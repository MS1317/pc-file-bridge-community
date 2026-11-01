export const SUPPORTED_SPREADSHEET_FORMATS = ['xlsx'] as const;
export type SpreadsheetFormat = (typeof SUPPORTED_SPREADSHEET_FORMATS)[number];

const SPREADSHEET_EXTENSIONS = SUPPORTED_SPREADSHEET_FORMATS.map((format) => `.${format}`);

export const SPREADSHEET_LIMITS = Object.freeze({
  maxWorkbookBytes: 50 * 1024 * 1024,
  maxCellsReturned: 10_000,
  maxRowsPerMutation: 2_000,
  maxSearchResults: 200,
  maxSearchCells: 100_000,
  maxSheets: 100,
  maxRows: 1_048_576,
  maxColumns: 16_384,
  maxKeyColumns: 32,
});

export type SpreadsheetFailureKind =
  | 'spreadsheet_file_not_found'
  | 'unsupported_spreadsheet_format'
  | 'workbook_invalid'
  | 'workbook_too_large'
  | 'sheet_not_found'
  | 'invalid_range'
  | 'invalid_row_shape'
  | 'duplicate_key'
  | 'key_not_found'
  | 'concurrent_modification'
  | 'workbook_locked'
  | 'write_failed'
  | 'verification_failed'
  | 'permission_denied'
  | 'invalid_request'
  | 'result_too_large'
  | 'file_exists';

export class SpreadsheetContractError extends Error {
  readonly kind: SpreadsheetFailureKind;

  constructor(kind: SpreadsheetFailureKind, message: string) {
    super(message);
    this.name = 'SpreadsheetContractError';
    this.kind = kind;
  }
}

export function spreadsheetFormatForPath(relativePath: string): SpreadsheetFormat | null {
  const lower = relativePath.toLowerCase();
  const index = SPREADSHEET_EXTENSIONS.findIndex((extension) => lower.endsWith(extension));
  return index === -1 ? null : SUPPORTED_SPREADSHEET_FORMATS[index] ?? null;
}

export function isSpreadsheetPath(relativePath: string): boolean {
  return spreadsheetFormatForPath(relativePath) !== null;
}

export const MAX_SHEET_NAME_LENGTH = 31;

export function validateSpreadsheetSheetName(name: string): string {
  const normalized = name.trim();
  if (!normalized || normalized.length > MAX_SHEET_NAME_LENGTH || /[\\/*?:\[\]]/.test(normalized)) {
    throw new SpreadsheetContractError('invalid_request', `Invalid spreadsheet sheet name: ${name}`);
  }
  return normalized;
}

export type SpreadsheetPrimitive = string | number | boolean | null;

export interface SpreadsheetDateValue {
  type: 'date';
  value: string;
}

export interface SpreadsheetFormulaValue {
  type: 'formula';
  formula: string;
  cachedValue?: SpreadsheetPrimitive;
}

export type SpreadsheetCellInput = SpreadsheetPrimitive | SpreadsheetDateValue | SpreadsheetFormulaValue;
export type SpreadsheetRowInput = SpreadsheetCellInput[] | Record<string, SpreadsheetCellInput>;

export interface SpreadsheetCell {
  address: string;
  valueType: 'blank' | 'string' | 'number' | 'boolean' | 'date' | 'error';
  rawValue: SpreadsheetPrimitive;
  displayValue: string | null;
  formula?: string;
  dateIso?: string;
}

export interface SpreadsheetRange {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

export interface SpreadsheetRangeInput {
  range?: string;
  startRow?: number;
  startColumn?: number;
  endRow?: number;
  endColumn?: number;
}

export interface SpreadsheetSheetSelector {
  sheetName?: string;
  sheetId?: number;
}

export function columnNameToNumber(name: string): number {
  const normalized = name.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(normalized)) {
    throw new SpreadsheetContractError('invalid_range', `Invalid spreadsheet column: ${name}`);
  }
  let result = 0;
  for (const char of normalized) result = result * 26 + char.charCodeAt(0) - 64;
  if (result < 1 || result > SPREADSHEET_LIMITS.maxColumns) {
    throw new SpreadsheetContractError('invalid_range', `Spreadsheet column is out of bounds: ${name}`);
  }
  return result;
}

export function columnNumberToName(column: number): string {
  if (!Number.isInteger(column) || column < 1 || column > SPREADSHEET_LIMITS.maxColumns) {
    throw new SpreadsheetContractError('invalid_range', `Spreadsheet column is out of bounds: ${column}`);
  }
  let value = column;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

export function cellAddress(row: number, column: number): string {
  if (!Number.isInteger(row) || row < 1 || row > SPREADSHEET_LIMITS.maxRows) {
    throw new SpreadsheetContractError('invalid_range', `Spreadsheet row is out of bounds: ${row}`);
  }
  return `${columnNumberToName(column)}${row}`;
}

export function parseSpreadsheetRange(value: string): SpreadsheetRange {
  const match = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/.exec(value.trim());
  if (!match) throw new SpreadsheetContractError('invalid_range', `Invalid spreadsheet range: ${value}`);

  const startRow = Number(match[2]);
  const startColumn = columnNameToNumber(match[1]);
  const endRow = match[4] ? Number(match[4]) : startRow;
  const endColumn = match[3] ? columnNameToNumber(match[3]) : startColumn;
  if (
    !Number.isInteger(startRow) ||
    !Number.isInteger(endRow) ||
    startRow < 1 ||
    endRow < startRow ||
    endRow > SPREADSHEET_LIMITS.maxRows ||
    endColumn < startColumn
  ) {
    throw new SpreadsheetContractError('invalid_range', `Invalid spreadsheet range: ${value}`);
  }
  return { startRow, startColumn, endRow, endColumn };
}

export function normalizeSpreadsheetRange(input: SpreadsheetRangeInput): SpreadsheetRange {
  if (input.range !== undefined) return parseSpreadsheetRange(input.range);
  const values = [input.startRow, input.startColumn, input.endRow, input.endColumn];
  if (!values.every((value) => Number.isInteger(value))) {
    throw new SpreadsheetContractError(
      'invalid_range',
      'Provide range or integer startRow, startColumn, endRow, and endColumn'
    );
  }
  return parseSpreadsheetRange(
    `${columnNumberToName(input.startColumn as number)}${input.startRow}:${columnNumberToName(input.endColumn as number)}${input.endRow}`
  );
}

export function spreadsheetRangeToString(range: SpreadsheetRange): string {
  return `${cellAddress(range.startRow, range.startColumn)}:${cellAddress(range.endRow, range.endColumn)}`;
}

export interface InspectSpreadsheetRequest {
  workspaceId: string;
  relativePath: string;
}

export interface ReadSpreadsheetRangeRequest extends InspectSpreadsheetRequest, SpreadsheetSheetSelector, SpreadsheetRangeInput {
  valueMode?: 'both' | 'raw' | 'display';
}

export interface SearchSpreadsheetRequest extends InspectSpreadsheetRequest, SpreadsheetSheetSelector {
  query: SpreadsheetCellInput;
  column?: string;
  match?: 'exact' | 'contains';
  limit?: number;
}

export interface AppendSpreadsheetRowsRequest extends InspectSpreadsheetRequest, SpreadsheetSheetSelector {
  rows: SpreadsheetRowInput[];
  headerMapping?: Record<string, string>;
  baseHash?: string;
  reason?: string;
}

export interface UpdateSpreadsheetRangeRequest extends InspectSpreadsheetRequest, SpreadsheetSheetSelector, SpreadsheetRangeInput {
  values: SpreadsheetCellInput[][];
  baseHash?: string;
  reason?: string;
}

export interface UpdateSpreadsheetRowsByKeyRequest extends InspectSpreadsheetRequest, SpreadsheetSheetSelector {
  keyColumns: string[];
  key: Record<string, SpreadsheetCellInput>;
  changes: Record<string, SpreadsheetCellInput>;
  baseHash?: string;
  reason?: string;
}

export interface UpsertSpreadsheetRowsRequest extends InspectSpreadsheetRequest, SpreadsheetSheetSelector {
  keyColumns: string[];
  rows: Record<string, SpreadsheetCellInput>[];
  baseHash?: string;
  reason?: string;
}

export interface SpreadsheetSheetDefinition {
  name: string;
  headers?: string[];
  rows?: SpreadsheetRowInput[];
  boldHeaders?: boolean;
}

export interface CreateSpreadsheetRequest {
  workspaceId: string;
  relativePath: string;
  sheets?: SpreadsheetSheetDefinition[];
  reason?: string;
}

export interface CreateSpreadsheetSheetRequest extends InspectSpreadsheetRequest {
  sheetName: string;
  headers?: string[];
  rows?: SpreadsheetRowInput[];
  boldHeaders?: boolean;
  baseHash?: string;
  reason?: string;
}

export type SpreadsheetActionName =
  | 'inspect_spreadsheet'
  | 'read_spreadsheet_range'
  | 'search_spreadsheet'
  | 'append_spreadsheet_rows'
  | 'update_spreadsheet_range'
  | 'update_spreadsheet_rows_by_key'
  | 'upsert_spreadsheet_rows'
  | 'create_spreadsheet'
  | 'create_spreadsheet_sheet';

export type SpreadsheetActionRequest =
  | InspectSpreadsheetRequest
  | ReadSpreadsheetRangeRequest
  | SearchSpreadsheetRequest
  | AppendSpreadsheetRowsRequest
  | UpdateSpreadsheetRangeRequest
  | UpdateSpreadsheetRowsByKeyRequest
  | UpsertSpreadsheetRowsRequest
  | CreateSpreadsheetRequest
  | CreateSpreadsheetSheetRequest;

export type SpreadsheetOperation =
  | 'inspect'
  | 'read_range'
  | 'search'
  | 'append_rows'
  | 'update_range'
  | 'update_rows_by_key'
  | 'upsert_rows'
  | 'create'
  | 'create_sheet';

export interface SpreadsheetSheetSummary {
  name: string;
  sheetId: number;
  relationshipId: string;
  usedRange: string | null;
  rowCount: number;
  columnCount: number;
}

export interface SpreadsheetInspection {
  workspaceId: string;
  relativePath: string;
  format: SpreadsheetFormat;
  fileHash: string;
  sizeBytes: number;
  sheets: SpreadsheetSheetSummary[];
  namedRanges: Array<{ name: string; reference: string }>;
  metadata: Record<string, string>;
  warnings: string[];
}

export interface ReadSpreadsheetRangeResult {
  workspaceId: string;
  relativePath: string;
  format: SpreadsheetFormat;
  sheetName: string;
  sheetId: number;
  range: string;
  rows: SpreadsheetCell[][];
  rowCount: number;
  columnCount: number;
  cellCount: number;
  fileHash: string;
  valueMode: 'both' | 'raw' | 'display';
}

export interface SpreadsheetSearchMatch {
  sheetName: string;
  sheetId: number;
  address: string;
  row: number;
  column: number;
  cell: SpreadsheetCell;
}

export interface SearchSpreadsheetResult {
  workspaceId: string;
  relativePath: string;
  format: SpreadsheetFormat;
  query: SpreadsheetCellInput;
  matches: SpreadsheetSearchMatch[];
  truncated: boolean;
  fileHash: string;
}

export interface SpreadsheetWriteStatus {
  requested: boolean;
  validated: boolean;
  written: boolean;
  verified: boolean;
}

export interface SpreadsheetWriteResult {
  success: true;
  workspaceId: string;
  relativePath: string;
  format: SpreadsheetFormat;
  operation: SpreadsheetOperation;
  beforeHash: string | null;
  afterHash: string;
  backupId: string;
  auditId: string;
  writeStatus: SpreadsheetWriteStatus;
  verificationStatus: 'verified';
  affectedRange: string | null;
  rowCount: number;
  cellCount: number;
  insertedRows: number[];
  updatedRows: number[];
  warnings: string[];
}

export type SpreadsheetActionResult =
  | SpreadsheetInspection
  | ReadSpreadsheetRangeResult
  | SearchSpreadsheetResult
  | SpreadsheetWriteResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SpreadsheetContractError('invalid_request', `${field} is required and must be a non-empty string`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new SpreadsheetContractError('invalid_request', `${field} must be a string`);
  }
  return value;
}

function optionalBoolean(args: Record<string, unknown>, field: string): boolean | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new SpreadsheetContractError('invalid_request', `${field} must be a boolean`);
  }
  return value;
}

function optionalInteger(args: Record<string, unknown>, field: string, min: number, max: number): number | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new SpreadsheetContractError('invalid_request', `${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function requiredInteger(args: Record<string, unknown>, field: string, min: number): number {
  const value = args[field];
  if (!Number.isInteger(value) || (value as number) < min) {
    throw new SpreadsheetContractError('invalid_request', `${field} must be an integer >= ${min}`);
  }
  return value as number;
}

function parseCellInput(value: unknown, field: string): SpreadsheetCellInput {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SpreadsheetContractError('invalid_request', `${field} must be finite`);
    return value;
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new SpreadsheetContractError('invalid_request', `${field} must be a string, number, boolean, null, date, or formula value`);
  }
  if (value.type === 'date') {
    if (typeof value.value !== 'string' || Number.isNaN(Date.parse(value.value))) {
      throw new SpreadsheetContractError('invalid_request', `${field}.value must be a valid date string`);
    }
    return { type: 'date', value: value.value };
  }
  if (value.type === 'formula') {
    if (typeof value.formula !== 'string' || value.formula.trim().length === 0) {
      throw new SpreadsheetContractError('invalid_request', `${field}.formula must be a non-empty string`);
    }
    const cachedValue = value.cachedValue === undefined
      ? undefined
      : (() => {
          const parsed = parseCellInput(value.cachedValue, `${field}.cachedValue`);
          if (parsed !== null && typeof parsed === 'object') {
            throw new SpreadsheetContractError('invalid_request', `${field}.cachedValue cannot be a date or formula`);
          }
          return parsed as SpreadsheetPrimitive;
        })();
    return { type: 'formula', formula: value.formula, cachedValue };
  }
  throw new SpreadsheetContractError('invalid_request', `${field}.type is unsupported`);
}

function parseRow(value: unknown, field: string): SpreadsheetRowInput {
  if (Array.isArray(value)) return value.map((cell, index) => parseCellInput(cell, `${field}[${index}]`));
  if (!isRecord(value)) throw new SpreadsheetContractError('invalid_row_shape', `${field} must be an array or object`);
  const result: Record<string, SpreadsheetCellInput> = {};
  for (const [key, cell] of Object.entries(value)) result[key] = parseCellInput(cell, `${field}.${key}`);
  return result;
}

function parseRows(value: unknown, field: string, allowEmpty = false): SpreadsheetRowInput[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new SpreadsheetContractError('invalid_row_shape', `${field} must be a non-empty array of rows`);
  }
  if (value.length > SPREADSHEET_LIMITS.maxRowsPerMutation) {
    throw new SpreadsheetContractError('result_too_large', `${field} exceeds ${SPREADSHEET_LIMITS.maxRowsPerMutation} rows`);
  }
  return value.map((row, index) => parseRow(row, `${field}[${index}]`));
}

function parseObjectRows(value: unknown, field: string): Record<string, SpreadsheetCellInput>[] {
  const rows = parseRows(value, field);
  if (rows.some((row) => Array.isArray(row))) {
    throw new SpreadsheetContractError('invalid_row_shape', `${field} must contain object rows`);
  }
  return rows as Record<string, SpreadsheetCellInput>[];
}

function parseHeaders(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new SpreadsheetContractError('invalid_row_shape', `${field} must be a non-empty string array`);
  }
  const headers = value.map((header, index) => {
    if (typeof header !== 'string' || header.trim().length === 0) {
      throw new SpreadsheetContractError('invalid_row_shape', `${field}[${index}] must be a non-empty string`);
    }
    return header;
  });
  if (new Set(headers).size !== headers.length) {
    throw new SpreadsheetContractError('invalid_row_shape', `${field} must not contain duplicate headers`);
  }
  return headers;
}

function parseRecordOfCells(value: unknown, field: string): Record<string, SpreadsheetCellInput> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new SpreadsheetContractError('invalid_row_shape', `${field} must be a non-empty object`);
  }
  const result: Record<string, SpreadsheetCellInput> = {};
  for (const [key, cell] of Object.entries(value)) result[key] = parseCellInput(cell, `${field}.${key}`);
  return result;
}

function requireRecordFields(record: Record<string, SpreadsheetCellInput>, fields: string[], field: string): void {
  for (const name of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, name)) {
      throw new SpreadsheetContractError('invalid_row_shape', `${field} must include key column ${name}`);
    }
  }
}

function parseKeyColumns(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > SPREADSHEET_LIMITS.maxKeyColumns) {
    throw new SpreadsheetContractError('invalid_request', `keyColumns must be a non-empty array of at most ${SPREADSHEET_LIMITS.maxKeyColumns} strings`);
  }
  const columns = value.map((column, index) => {
    if (typeof column !== 'string' || column.trim().length === 0) {
      throw new SpreadsheetContractError('invalid_request', `keyColumns[${index}] must be a non-empty string`);
    }
    return column;
  });
  if (new Set(columns).size !== columns.length) {
    throw new SpreadsheetContractError('invalid_request', 'keyColumns must not contain duplicates');
  }
  return columns;
}

function parseSheetSelector(args: Record<string, unknown>): SpreadsheetSheetSelector {
  const sheetName = optionalString(args, 'sheetName');
  const sheetId = optionalInteger(args, 'sheetId', 1, SPREADSHEET_LIMITS.maxSheets);
  if (sheetName === undefined && sheetId === undefined) {
    throw new SpreadsheetContractError('sheet_not_found', 'sheetName or sheetId is required');
  }
  return { sheetName: sheetName === undefined ? undefined : validateSpreadsheetSheetName(sheetName), sheetId };
}

function parseRangeInput(args: Record<string, unknown>): SpreadsheetRangeInput {
  const range = optionalString(args, 'range');
  const result: SpreadsheetRangeInput = {
    range,
    startRow: optionalInteger(args, 'startRow', 1, SPREADSHEET_LIMITS.maxRows),
    startColumn: optionalInteger(args, 'startColumn', 1, SPREADSHEET_LIMITS.maxColumns),
    endRow: optionalInteger(args, 'endRow', 1, SPREADSHEET_LIMITS.maxRows),
    endColumn: optionalInteger(args, 'endColumn', 1, SPREADSHEET_LIMITS.maxColumns),
  };
  normalizeSpreadsheetRange(result);
  return result;
}

function commonFileArgs(args: Record<string, unknown>): InspectSpreadsheetRequest {
  return {
    workspaceId: requiredString(args, 'workspaceId'),
    relativePath: requiredString(args, 'relativePath'),
  };
}

function optionalWriteArgs(args: Record<string, unknown>): { baseHash?: string; reason?: string } {
  const baseHash = optionalString(args, 'baseHash');
  if (baseHash !== undefined && !/^[a-f0-9]{64}$/i.test(baseHash)) {
    throw new SpreadsheetContractError('invalid_request', 'baseHash must be a SHA-256 hex hash');
  }
  return { baseHash, reason: optionalString(args, 'reason') };
}

function parseHeaderMapping(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new SpreadsheetContractError('invalid_row_shape', 'headerMapping must be an object');
  const result: Record<string, string> = {};
  for (const [key, header] of Object.entries(value)) {
    if (typeof header !== 'string' || header.trim().length === 0) {
      throw new SpreadsheetContractError('invalid_row_shape', `headerMapping.${key} must be a non-empty string`);
    }
    result[key] = header;
  }
  return result;
}

export function isSpreadsheetActionName(value: string): value is SpreadsheetActionName {
  return [
    'inspect_spreadsheet',
    'read_spreadsheet_range',
    'search_spreadsheet',
    'append_spreadsheet_rows',
    'update_spreadsheet_range',
    'update_spreadsheet_rows_by_key',
    'upsert_spreadsheet_rows',
    'create_spreadsheet',
    'create_spreadsheet_sheet',
  ].includes(value as SpreadsheetActionName);
}

export function parseSpreadsheetRequest(action: string, input: unknown): SpreadsheetActionRequest {
  if (!isSpreadsheetActionName(action)) {
    throw new SpreadsheetContractError('invalid_request', `Unsupported spreadsheet action: ${action}`);
  }
  if (!isRecord(input)) throw new SpreadsheetContractError('invalid_request', `${action} arguments must be an object`);

  switch (action) {
    case 'inspect_spreadsheet':
      return commonFileArgs(input);
    case 'read_spreadsheet_range':
      return {
        ...commonFileArgs(input),
        ...parseSheetSelector(input),
        ...parseRangeInput(input),
        valueMode: input.valueMode === undefined ? 'both' : (() => {
          if (input.valueMode !== 'both' && input.valueMode !== 'raw' && input.valueMode !== 'display') {
            throw new SpreadsheetContractError('invalid_request', 'valueMode must be both, raw, or display');
          }
          return input.valueMode;
        })(),
      };
    case 'search_spreadsheet': {
      const match = input.match === undefined ? 'contains' : input.match;
      if (match !== 'exact' && match !== 'contains') {
        throw new SpreadsheetContractError('invalid_request', 'match must be exact or contains');
      }
      return {
        ...commonFileArgs(input),
        ...(input.sheetName !== undefined || input.sheetId !== undefined ? parseSheetSelector(input) : {}),
        query: parseCellInput(input.query, 'query'),
        column: optionalString(input, 'column'),
        match,
        limit: optionalInteger(input, 'limit', 1, SPREADSHEET_LIMITS.maxSearchResults),
      };
    }
    case 'append_spreadsheet_rows':
      return {
        ...commonFileArgs(input),
        ...parseSheetSelector(input),
        rows: parseRows(input.rows, 'rows'),
        headerMapping: parseHeaderMapping(input.headerMapping),
        ...optionalWriteArgs(input),
      };
    case 'update_spreadsheet_range':
      if (!Array.isArray(input.values) || input.values.length === 0) {
        throw new SpreadsheetContractError('invalid_row_shape', 'values must be a non-empty two-dimensional array');
      }
      if (input.values.length > SPREADSHEET_LIMITS.maxRowsPerMutation) {
        throw new SpreadsheetContractError('result_too_large', `values exceeds ${SPREADSHEET_LIMITS.maxRowsPerMutation} rows`);
      }
      return {
        ...commonFileArgs(input),
        ...parseSheetSelector(input),
        ...parseRangeInput(input),
        values: input.values.map((row, rowIndex) => {
          if (!Array.isArray(row) || row.length === 0) {
            throw new SpreadsheetContractError('invalid_row_shape', `values[${rowIndex}] must be a non-empty array`);
          }
          return row.map((cell, columnIndex) => parseCellInput(cell, `values[${rowIndex}][${columnIndex}]`));
        }),
        ...optionalWriteArgs(input),
      };
    case 'update_spreadsheet_rows_by_key': {
      const keyColumns = parseKeyColumns(input.keyColumns);
      const key = parseRecordOfCells(input.key, 'key');
      requireRecordFields(key, keyColumns, 'key');
      return {
        ...commonFileArgs(input),
        ...parseSheetSelector(input),
        keyColumns,
        key,
        changes: parseRecordOfCells(input.changes, 'changes'),
        ...optionalWriteArgs(input),
      };
    }
    case 'upsert_spreadsheet_rows': {
      const keyColumns = parseKeyColumns(input.keyColumns);
      const rows = parseObjectRows(input.rows, 'rows');
      rows.forEach((row, index) => requireRecordFields(row, keyColumns, `rows[${index}]`));
      return {
        ...commonFileArgs(input),
        ...parseSheetSelector(input),
        keyColumns,
        rows,
        ...optionalWriteArgs(input),
      };
    }
    case 'create_spreadsheet': {
      const sheetsValue = input.sheets;
      const sheets = sheetsValue === undefined
        ? [{ name: 'Sheet1' }]
        : (() => {
            if (!Array.isArray(sheetsValue) || sheetsValue.length === 0 || sheetsValue.length > SPREADSHEET_LIMITS.maxSheets) {
              throw new SpreadsheetContractError('invalid_request', `sheets must contain 1-${SPREADSHEET_LIMITS.maxSheets} sheets`);
            }
            const parsed = sheetsValue.map((sheet, index) => {
              if (!isRecord(sheet)) throw new SpreadsheetContractError('invalid_request', `sheets[${index}] must be an object`);
              return {
                name: validateSpreadsheetSheetName(requiredString(sheet, 'name')),
                headers: parseHeaders(sheet.headers, `sheets[${index}].headers`),
                rows: sheet.rows === undefined ? undefined : parseRows(sheet.rows, `sheets[${index}].rows`, true),
                boldHeaders: optionalBoolean(sheet, 'boldHeaders') ?? false,
              };
            });
            if (new Set(parsed.map((sheet) => sheet.name)).size !== parsed.length) {
              throw new SpreadsheetContractError('duplicate_key', 'Spreadsheet sheet names must be unique');
            }
            return parsed;
          })();
      return {
        workspaceId: requiredString(input, 'workspaceId'),
        relativePath: requiredString(input, 'relativePath'),
        sheets,
        reason: optionalString(input, 'reason'),
      };
    }
    case 'create_spreadsheet_sheet':
      return {
        ...commonFileArgs(input),
        sheetName: validateSpreadsheetSheetName(requiredString(input, 'sheetName')),
        headers: parseHeaders(input.headers, 'headers'),
        rows: input.rows === undefined ? undefined : parseRows(input.rows, 'rows', true),
        boldHeaders: optionalBoolean(input, 'boldHeaders') ?? false,
        ...optionalWriteArgs(input),
      };
  }
}

export interface SpreadsheetToolDefinition {
  name: SpreadsheetActionName;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

const CELL_SCHEMA = {
  oneOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
    {
      type: 'object',
      properties: { type: { const: 'date' }, value: { type: 'string', format: 'date-time' } },
      required: ['type', 'value'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { const: 'formula' },
        formula: { type: 'string' },
        cachedValue: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] },
      },
      required: ['type', 'formula'],
      additionalProperties: false,
    },
  ],
};

const ROW_SCHEMA = {
  oneOf: [
    { type: 'array', items: CELL_SCHEMA },
    { type: 'object', additionalProperties: CELL_SCHEMA },
  ],
};

const FILE_PROPERTIES = {
  workspaceId: { type: 'string' },
  relativePath: { type: 'string', description: 'Workspace-relative .xlsx path; absolute paths are not accepted.' },
};

const SHEET_PROPERTIES = {
  sheetName: { type: 'string', description: 'Exact sheet name.' },
  sheetId: { type: 'integer', minimum: 1, maximum: SPREADSHEET_LIMITS.maxSheets },
};

const RANGE_PROPERTIES = {
  range: { type: 'string', description: 'A1 range such as A1:C20.' },
  startRow: { type: 'integer', minimum: 1, maximum: SPREADSHEET_LIMITS.maxRows },
  startColumn: { type: 'integer', minimum: 1, maximum: SPREADSHEET_LIMITS.maxColumns },
  endRow: { type: 'integer', minimum: 1, maximum: SPREADSHEET_LIMITS.maxRows },
  endColumn: { type: 'integer', minimum: 1, maximum: SPREADSHEET_LIMITS.maxColumns },
};

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const WRITE_DESCRIPTION =
  'Write through the bridge spreadsheet service. ChatGPT should use this for workbook cells, rows, sheets, or ranges instead of run_terminal_command. ' +
  'The bridge validates the workspace path, takes a backup, saves atomically, reopens the workbook, verifies the requested mutation, and records an audit entry.';

export const SPREADSHEET_TOOL_DEFINITIONS: SpreadsheetToolDefinition[] = [
  {
    name: 'inspect_spreadsheet',
    title: 'Inspect Spreadsheet',
    description: 'Inspect an approved .xlsx workbook before reading or changing it. Returns sheets, used ranges, dimensions, names, metadata, and the current file hash.',
    inputSchema: schema(FILE_PROPERTIES, ['workspaceId', 'relativePath']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_spreadsheet_range',
    title: 'Read Spreadsheet Range',
    description: 'Read structured raw values, display values, and formulas from an approved .xlsx range. Use this instead of reading ZIP/XML workbook parts.',
    inputSchema: schema({ ...FILE_PROPERTIES, ...SHEET_PROPERTIES, ...RANGE_PROPERTIES, valueMode: { enum: ['both', 'raw', 'display'] } }, ['workspaceId', 'relativePath']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'search_spreadsheet',
    title: 'Search Spreadsheet',
    description: 'Search an approved workbook or sheet for a typed value. Supports exact/contains matching and an optional header/key column.',
    inputSchema: schema({
      ...FILE_PROPERTIES,
      ...SHEET_PROPERTIES,
      query: CELL_SCHEMA,
      column: { type: 'string', description: 'Optional header name to search only in that column.' },
      match: { enum: ['exact', 'contains'] },
      limit: { type: 'integer', minimum: 1, maximum: SPREADSHEET_LIMITS.maxSearchResults },
    }, ['workspaceId', 'relativePath', 'query']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'append_spreadsheet_rows',
    title: 'Append Spreadsheet Rows',
    description: WRITE_DESCRIPTION + ' Rows are appended after the current used rows; fixed row numbers are not assumed.',
    inputSchema: schema({
      ...FILE_PROPERTIES,
      ...SHEET_PROPERTIES,
      rows: { type: 'array', minItems: 1, maxItems: SPREADSHEET_LIMITS.maxRowsPerMutation, items: ROW_SCHEMA },
      headerMapping: { type: 'object', additionalProperties: { type: 'string' } },
      baseHash: { type: 'string', description: 'Optional SHA-256 from inspect/read; mismatches are rejected.' },
      reason: { type: 'string' },
    }, ['workspaceId', 'relativePath', 'rows']),
    annotations: { destructiveHint: true },
  },
  {
    name: 'update_spreadsheet_range',
    title: 'Update Spreadsheet Range',
    description: WRITE_DESCRIPTION + ' The two-dimensional values must exactly match the requested range dimensions.',
    inputSchema: schema({
      ...FILE_PROPERTIES,
      ...SHEET_PROPERTIES,
      ...RANGE_PROPERTIES,
      values: { type: 'array', minItems: 1, maxItems: SPREADSHEET_LIMITS.maxRowsPerMutation, items: { type: 'array', minItems: 1, items: CELL_SCHEMA } },
      baseHash: { type: 'string', description: 'Optional SHA-256 from inspect/read; mismatches are rejected.' },
      reason: { type: 'string' },
    }, ['workspaceId', 'relativePath', 'values']),
    annotations: { destructiveHint: true },
  },
  {
    name: 'update_spreadsheet_rows_by_key',
    title: 'Update Spreadsheet Rows by Key',
    description: WRITE_DESCRIPTION + ' Header names and key values come from the request/current sheet. Duplicate matches fail with a typed duplicate_key result.',
    inputSchema: schema({
      ...FILE_PROPERTIES,
      ...SHEET_PROPERTIES,
      keyColumns: { type: 'array', minItems: 1, maxItems: SPREADSHEET_LIMITS.maxKeyColumns, items: { type: 'string' } },
      key: { type: 'object', additionalProperties: CELL_SCHEMA },
      changes: { type: 'object', minProperties: 1, additionalProperties: CELL_SCHEMA },
      baseHash: { type: 'string', description: 'Optional SHA-256 from inspect/read; mismatches are rejected.' },
      reason: { type: 'string' },
    }, ['workspaceId', 'relativePath', 'keyColumns', 'key', 'changes']),
    annotations: { destructiveHint: true },
  },
  {
    name: 'upsert_spreadsheet_rows',
    title: 'Upsert Spreadsheet Rows',
    description: WRITE_DESCRIPTION + ' Searches existing rows by generic key columns, updates unique matches, and appends missing rows in one save.',
    inputSchema: schema({
      ...FILE_PROPERTIES,
      ...SHEET_PROPERTIES,
      keyColumns: { type: 'array', minItems: 1, maxItems: SPREADSHEET_LIMITS.maxKeyColumns, items: { type: 'string' } },
      rows: { type: 'array', minItems: 1, maxItems: SPREADSHEET_LIMITS.maxRowsPerMutation, items: { type: 'object', additionalProperties: CELL_SCHEMA } },
      baseHash: { type: 'string', description: 'Optional SHA-256 from inspect/read; mismatches are rejected.' },
      reason: { type: 'string' },
    }, ['workspaceId', 'relativePath', 'keyColumns', 'rows']),
    annotations: { destructiveHint: true },
  },
  {
    name: 'create_spreadsheet',
    title: 'Create Spreadsheet',
    description: WRITE_DESCRIPTION + ' Creates a new .xlsx workbook with named sheets, optional headers, rows, and basic bold-header formatting.',
    inputSchema: schema({
      workspaceId: FILE_PROPERTIES.workspaceId,
      relativePath: FILE_PROPERTIES.relativePath,
      sheets: {
        type: 'array', minItems: 1, maxItems: SPREADSHEET_LIMITS.maxSheets,
        items: schema({
          name: { type: 'string' },
          headers: { type: 'array', minItems: 1, items: { type: 'string' } },
          rows: { type: 'array', maxItems: SPREADSHEET_LIMITS.maxRowsPerMutation, items: ROW_SCHEMA },
          boldHeaders: { type: 'boolean' },
        }, ['name']),
      },
      reason: { type: 'string' },
    }, ['workspaceId', 'relativePath']),
    annotations: { destructiveHint: true },
  },
  {
    name: 'create_spreadsheet_sheet',
    title: 'Create Spreadsheet Sheet',
    description: WRITE_DESCRIPTION + ' Adds one worksheet while preserving existing workbook parts and relationships.',
    inputSchema: schema({
      ...FILE_PROPERTIES,
      sheetName: { type: 'string' },
      headers: { type: 'array', minItems: 1, items: { type: 'string' } },
      rows: { type: 'array', maxItems: SPREADSHEET_LIMITS.maxRowsPerMutation, items: ROW_SCHEMA },
      boldHeaders: { type: 'boolean' },
      baseHash: { type: 'string', description: 'Optional SHA-256 from inspect/read; mismatches are rejected.' },
      reason: { type: 'string' },
    }, ['workspaceId', 'relativePath', 'sheetName']),
    annotations: { destructiveHint: true },
  },
];
