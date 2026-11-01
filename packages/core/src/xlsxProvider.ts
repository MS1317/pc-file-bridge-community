import zlib from 'zlib';
import type {
  AppendSpreadsheetRowsRequest,
  CreateSpreadsheetRequest,
  CreateSpreadsheetSheetRequest,
  ReadSpreadsheetRangeRequest,
  SearchSpreadsheetRequest,
  SpreadsheetCell,
  SpreadsheetCellInput,
  SpreadsheetDateValue,
  SpreadsheetFailureKind,
  SpreadsheetFormulaValue,
  SpreadsheetInspection,
  SpreadsheetRange,
  SpreadsheetRowInput,
  SpreadsheetSearchMatch,
  SpreadsheetSheetDefinition,
  SpreadsheetSheetSelector,
  SpreadsheetSheetSummary,
  SpreadsheetWriteResult,
  UpdateSpreadsheetRangeRequest,
  UpdateSpreadsheetRowsByKeyRequest,
  UpsertSpreadsheetRowsRequest,
} from '@bridge/shared';
import {
  cellAddress,
  columnNameToNumber,
  columnNumberToName,
  normalizeSpreadsheetRange,
  parseSpreadsheetRange,
  spreadsheetRangeToString,
  SpreadsheetContractError,
  SPREADSHEET_LIMITS,
} from '@bridge/shared';

interface ZipEntry {
  name: string;
  data: Buffer;
}

interface XmlElement {
  xml: string;
  start: number;
  end: number;
  openEnd: number;
  attrs: string;
  inner: string;
}

export const SPREADSHEETML_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const OFFICE_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';

export interface XmlAttributeNode {
  name: string;
  localName: string;
  prefix: string;
  namespaceURI?: string;
  value: string;
}

export interface XmlNode {
  name: string;
  localName: string;
  prefix: string;
  namespaceURI?: string;
  attributes: XmlAttributeNode[];
  children: XmlNode[];
}

interface XmlStackEntry {
  node: XmlNode;
  namespaces: Map<string, string>;
}

interface ParsedCell {
  cell: SpreadsheetCell;
  xml: string;
  row: number;
  column: number;
  styleId?: string;
}

interface SheetRef {
  name: string;
  sheetId: number;
  relationshipId: string;
  partName: string;
}

interface ParsedSheet {
  ref: SheetRef;
  xml: string;
  cells: Map<string, ParsedCell>;
  usedRange: SpreadsheetRange | null;
  maxRow: number;
  maxColumn: number;
}

interface ParsedWorkbook {
  entries: Map<string, Buffer>;
  workbookXml: string;
  workbookPart: string;
  sheets: ParsedSheet[];
  date1904: boolean;
}

export interface ExpectedSpreadsheetCell {
  sheetName: string;
  sheetId: number;
  address: string;
  value: SpreadsheetCellInput;
}

export interface SpreadsheetProviderMutation {
  buffer: Buffer;
  affectedRange: string | null;
  rowCount: number;
  cellCount: number;
  insertedRows: number[];
  updatedRows: number[];
  warnings: string[];
  verify(buffer: Buffer): void;
}

export interface SpreadsheetProvider {
  validate(buffer: Buffer): void;
  inspect(buffer: Buffer, workspaceId: string, relativePath: string, fileHash: string): SpreadsheetInspection;
  readRange(buffer: Buffer, request: ReadSpreadsheetRangeRequest, fileHash: string): import('@bridge/shared').ReadSpreadsheetRangeResult;
  search(buffer: Buffer, request: SearchSpreadsheetRequest, fileHash: string): import('@bridge/shared').SearchSpreadsheetResult;
  appendRows(buffer: Buffer, request: AppendSpreadsheetRowsRequest): SpreadsheetProviderMutation;
  updateRange(buffer: Buffer, request: UpdateSpreadsheetRangeRequest): SpreadsheetProviderMutation;
  updateRowsByKey(buffer: Buffer, request: UpdateSpreadsheetRowsByKeyRequest): SpreadsheetProviderMutation;
  upsertRows(buffer: Buffer, request: UpsertSpreadsheetRowsRequest): SpreadsheetProviderMutation;
  createWorkbook(request: CreateSpreadsheetRequest): SpreadsheetProviderMutation;
  createSheet(buffer: Buffer, request: CreateSpreadsheetSheetRequest): SpreadsheetProviderMutation;
}

function fail(message: string, kind: SpreadsheetFailureKind): never {
  throw new SpreadsheetContractError(kind, message);
}

function canonicalizePackageEntryName(rawName: string): string {
  if (!rawName || rawName.includes('\0') || /[\u0001-\u001f\u007f]/.test(rawName)) {
    fail('XLSX ZIP entry name is empty or contains control characters', 'workbook_invalid');
  }

  const normalized = rawName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    fail(`Unsafe XLSX ZIP entry path: ${rawName}`, 'workbook_invalid');
  }

  const directory = normalized.endsWith('/');
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') fail(`Traversal-like XLSX ZIP entry path: ${rawName}`, 'workbook_invalid');
    parts.push(part);
  }
  if (parts.length === 0) fail(`Empty XLSX ZIP entry path: ${rawName}`, 'workbook_invalid');

  return `${parts.join('/')}${directory ? '/' : ''}`;
}

function xmlDecode(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlEncode(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function splitXmlName(name: string): { prefix: string; localName: string } {
  const match = /^([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)$/.exec(name);
  if (!match) throw new Error('Invalid XML name');
  return { prefix: match[1]?.slice(0, -1) ?? '', localName: match[2] };
}

function structuralFailure(partName: string, message: string): never {
  fail('Structural SpreadsheetML validation failed [stage=xml] part=' + partName + ': ' + message, 'workbook_invalid');
}

function xmlTagEnd(xml: string, start: number, partName: string): number {
  let quote = 0;
  for (let index = start; index < xml.length; index++) {
    const code = xml.charCodeAt(index);
    if (quote) {
      if (code === quote) quote = 0;
    } else if (code === 34 || code === 39) {
      quote = code;
    } else if (code === 62) {
      return index;
    }
  }
  return structuralFailure(partName, 'unterminated XML tag');
}

export function parseXmlDocument(xml: string, partName = 'XML part'): XmlNode {
  let cursor = 0;
  let root: XmlNode | undefined;
  const stack: XmlStackEntry[] = [];

  while (cursor < xml.length) {
    if (xml[cursor] !== '<') {
      const next = xml.indexOf('<', cursor);
      const end = next < 0 ? xml.length : next;
      if (xml.slice(cursor, end).trim() && stack.length === 0) structuralFailure(partName, 'text exists outside the document root');
      cursor = end;
      continue;
    }

    if (xml.startsWith('<!--', cursor)) {
      const end = xml.indexOf('-->', cursor + 4);
      if (end < 0) structuralFailure(partName, 'unterminated XML comment');
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', cursor)) {
      const end = xml.indexOf(']]>', cursor + 9);
      if (end < 0) structuralFailure(partName, 'unterminated CDATA section');
      if (stack.length === 0) structuralFailure(partName, 'CDATA exists outside the document root');
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', cursor)) {
      const end = xml.indexOf('?>', cursor + 2);
      if (end < 0) structuralFailure(partName, 'unterminated processing instruction');
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith('<!', cursor)) structuralFailure(partName, 'unsupported or malformed XML declaration');

    const end = xmlTagEnd(xml, cursor + 1, partName);
    if (xml[cursor + 1] === '/') {
      const closingName = xml.slice(cursor + 2, end).trim();
      if (!stack.length) structuralFailure(partName, 'unexpected closing element: ' + closingName);
      const open = stack[stack.length - 1];
      if (open.node.name !== closingName) structuralFailure(partName, 'closing element ' + closingName + ' does not match ' + open.node.name);
      stack.pop();
      cursor = end + 1;
      continue;
    }

    let body = xml.slice(cursor + 1, end).trim();
    const selfClosing = /\/\s*$/.test(body);
    if (selfClosing) body = body.replace(/\/\s*$/, '').trim();
    const nameMatch = /^([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)/.exec(body);
    if (!nameMatch) structuralFailure(partName, 'element name is missing');
    const name = nameMatch[1];
    const attributes: Array<{ name: string; value: string }> = [];
    let position = nameMatch[0].length;
    while (position < body.length) {
      while (/\s/.test(body[position] ?? '')) position++;
      if (position >= body.length) break;
      const attributeMatch = /^([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)/.exec(body.slice(position));
      if (!attributeMatch) structuralFailure(partName, 'invalid attribute in ' + name);
      const attributeName = attributeMatch[1];
      position += attributeMatch[0].length;
      while (/\s/.test(body[position] ?? '')) position++;
      if (body[position] !== '=') structuralFailure(partName, 'attribute ' + attributeName + ' has no value');
      position++;
      while (/\s/.test(body[position] ?? '')) position++;
      const quote = body.charCodeAt(position);
      if (quote !== 34 && quote !== 39) structuralFailure(partName, 'attribute ' + attributeName + ' is not quoted');
      position++;
      const valueStart = position;
      while (position < body.length && body.charCodeAt(position) !== quote) position++;
      if (position >= body.length) structuralFailure(partName, 'attribute ' + attributeName + ' is unterminated');
      const value = xmlDecode(body.slice(valueStart, position));
      position++;
      if (attributes.some((attribute) => attribute.name === attributeName)) structuralFailure(partName, 'duplicate attribute ' + attributeName);
      attributes.push({ name: attributeName, value });
    }

    const namespaces = new Map(stack.length ? stack[stack.length - 1].namespaces : [['xml', XML_NAMESPACE]]);
    for (const attribute of attributes) {
      const parsed = splitXmlName(attribute.name);
      if (attribute.name === 'xmlns') namespaces.set('', attribute.value);
      else if (parsed.prefix === 'xmlns') namespaces.set(parsed.localName, attribute.value);
    }
    const parsedName = splitXmlName(name);
    const namespaceURI = namespaces.get(parsedName.prefix);
    if (parsedName.prefix && namespaceURI === undefined) structuralFailure(partName, 'unbound XML namespace prefix: ' + parsedName.prefix);
    const node: XmlNode = {
      name,
      localName: parsedName.localName,
      prefix: parsedName.prefix,
      namespaceURI,
      attributes: attributes.map((attribute) => {
        const parsed = splitXmlName(attribute.name);
        const attributeNamespace = attribute.name === 'xmlns' || parsed.prefix === 'xmlns'
          ? XMLNS_NAMESPACE
          : parsed.prefix === 'xml'
            ? XML_NAMESPACE
            : parsed.prefix
              ? namespaces.get(parsed.prefix)
              : undefined;
        if (parsed.prefix && attributeNamespace === undefined) structuralFailure(partName, 'unbound XML namespace prefix: ' + parsed.prefix);
        return { ...parsed, name: attribute.name, namespaceURI: attributeNamespace, value: attribute.value };
      }),
      children: [],
    };
    if (stack.length > 0) stack[stack.length - 1].node.children.push(node);
    else if (root) structuralFailure(partName, 'multiple document roots');
    else root = node;
    if (!selfClosing) stack.push({ node, namespaces });
    cursor = end + 1;
  }

  if (!root) structuralFailure(partName, 'document root is missing');
  if (stack.length > 0) structuralFailure(partName, 'element is not closed: ' + stack[stack.length - 1].node.name);
  return root;
}

function attr(attrs: string, ...names: string[]): string | undefined {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*"([^"]*)"`).exec(attrs);
    if (match) return xmlDecode(match[1]);
  }
  return undefined;
}

function findElements(xml: string, localName: string): XmlElement[] {
  const open = new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${localName}\\b([^>]*)>`, 'g');
  const selfClosing = new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${localName}\\b([^>]*)\\/>`, 'g');
  const result: XmlElement[] = [];
  let match: RegExpExecArray | null;
  while ((match = selfClosing.exec(xml))) {
    result.push({ xml: match[0], start: match.index, end: selfClosing.lastIndex, openEnd: selfClosing.lastIndex, attrs: match[1], inner: '' });
  }
  while ((match = open.exec(xml))) {
    if (match[0].endsWith('/>')) continue;
    const close = new RegExp(`</(?:(?:[A-Za-z_][\\w.-]*):)?${localName}\\s*>`, 'g');
    close.lastIndex = open.lastIndex;
    const closing = close.exec(xml);
    if (!closing) continue;
    result.push({
      xml: xml.slice(match.index, close.lastIndex),
      start: match.index,
      end: close.lastIndex,
      openEnd: open.lastIndex,
      attrs: match[1],
      inner: xml.slice(open.lastIndex, closing.index),
    });
    open.lastIndex = close.lastIndex;
  }
  return result.sort((a, b) => a.start - b.start);
}

function firstElement(xml: string, localName: string): XmlElement | undefined {
  return findElements(xml, localName)[0];
}

function elementText(xml: string, localName: string): string | undefined {
  const element = firstElement(xml, localName);
  return element ? xmlDecode(element.inner).replace(/<[^>]+>/g, '') : undefined;
}

function textValues(xml: string, localName: string): string[] {
  return findElements(xml, localName).map((element) => xmlDecode(element.inner.replace(/<[^>]+>/g, '')));
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readZip(buffer: Buffer): Map<string, Buffer> {
  const minEnd = Math.max(0, buffer.length - 65_557);
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= minEnd; offset--) {
    if (offset >= 0 && buffer.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) fail('XLSX ZIP end record is missing', 'workbook_invalid');

  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize > buffer.length) fail('XLSX ZIP central directory is invalid', 'workbook_invalid');

  const entries = new Map<string, Buffer>();
  let uncompressedTotal = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      fail('XLSX ZIP central directory entry is invalid', 'workbook_invalid');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'utf8');
    const canonicalName = canonicalizePackageEntryName(name);
    uncompressedTotal += uncompressedSize;
    if (uncompressedTotal > SPREADSHEET_LIMITS.maxWorkbookBytes || entries.has(canonicalName) || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      if (uncompressedTotal > SPREADSHEET_LIMITS.maxWorkbookBytes) fail(`XLSX package expands beyond ${SPREADSHEET_LIMITS.maxWorkbookBytes} bytes`, 'workbook_too_large');
      if (entries.has(canonicalName)) fail(`XLSX ZIP entries collide after canonicalization: ${canonicalName}`, 'workbook_invalid');
      fail('XLSX ZIP entry is unsupported', 'workbook_invalid');
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      fail('XLSX ZIP local entry is invalid', 'workbook_invalid');
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    if (localNameEnd + localExtraLength > buffer.length) fail('XLSX ZIP local entry name is invalid', 'workbook_invalid');
    const localName = buffer.subarray(localNameStart, localNameEnd).toString('utf8');
    if (canonicalizePackageEntryName(localName) !== canonicalName) {
      fail(`XLSX ZIP central/local entry names disagree: ${name}`, 'workbook_invalid');
    }
    const dataStart = localNameEnd + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length || (flags & 1) !== 0) fail('Encrypted XLSX entries are unsupported', 'workbook_invalid');
    const compressed = buffer.subarray(dataStart, dataEnd);
    let data: Buffer;
    try {
      data = method === 0 ? Buffer.from(compressed) : method === 8 ? zlib.inflateRawSync(compressed) : fail(`Unsupported XLSX ZIP compression method: ${method}`, 'workbook_invalid');
    } catch (error) {
      if (error instanceof SpreadsheetContractError) throw error;
      fail(`XLSX ZIP entry could not be decompressed: ${name}`, 'workbook_invalid');
    }
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    if (data.length !== uncompressedSize || crc32(data) !== expectedCrc) {
      fail(`XLSX ZIP entry failed integrity validation: ${name}`, 'workbook_invalid');
    }
    entries.set(canonicalName, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Package-level inspection helpers used by preservation fixtures. */
export function readXlsxPackageEntries(buffer: Buffer): Map<string, Buffer> {
  return readZip(buffer);
}

export function writeXlsxPackageEntries(entries: Map<string, Buffer>): Buffer {
  // Fixture helper: callers may intentionally provide non-canonical names to
  // exercise the read boundary. Provider writes always use canonical names.
  return writeZip(entries, true);
}

function writeZip(entries: Map<string, Buffer>, preserveNames = false): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const writtenNames = new Set<string>();
  for (const [rawName, data] of entries) {
    const name = preserveNames ? rawName : canonicalizePackageEntryName(rawName);
    if (writtenNames.has(name)) fail(`XLSX ZIP entries collide after canonicalization: ${name}`, 'workbook_invalid');
    writtenNames.add(name);
    const nameBuffer = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + nameBuffer.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuffer.copy(local, 30);
    compressed.copy(local, 30 + nameBuffer.length);
    locals.push(local);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuffer.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }

  const central = Buffer.concat(centrals);
  const body = Buffer.concat([...locals, central]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([body, end]);
}

function normalizePartName(value: string, basePart: string): string {
  const target = value.replace(/\\/g, '/');
  const base = target.startsWith('/') ? '' : basePart.slice(0, basePart.lastIndexOf('/') + 1);
  const parts = `${base}${target.replace(/^\/+/, '')}`.split('/');
  const result: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (result.length === 0) fail(`XLSX relationship target escapes the package: ${value}`, 'workbook_invalid');
      result.pop();
    }
    else result.push(part);
  }
  return canonicalizePackageEntryName(result.join('/'));
}

function parseCellAddress(value: string | undefined, fallbackRow: number, fallbackColumn: number): { row: number; column: number } {
  if (!value) return { row: fallbackRow, column: fallbackColumn };
  const match = /^([A-Z]+)(\d+)$/i.exec(value);
  if (!match) fail(`Invalid worksheet cell address: ${value}`, 'workbook_invalid');
  return { row: Number(match[2]), column: columnNameToNumber(match[1]) };
}

function findCellElements(xml: string): XmlElement[] {
  return findElements(xml, 'c');
}

function serialToDate(serial: number, date1904: boolean): string {
  const adjusted = date1904 ? serial : serial >= 60 ? serial - 1 : serial;
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  return new Date(base + adjusted * 86_400_000).toISOString();
}

function isDateFormat(format: string | undefined): boolean {
  if (!format) return false;
  const normalized = format
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '');
  return /[dy]/i.test(normalized) || (/[m]/i.test(normalized) && !/[hs]/i.test(normalized));
}

function styleDateMap(stylesXml: string | undefined): Map<number, boolean> {
  const result = new Map<number, boolean>();
  if (!stylesXml) return result;
  const customFormats = new Map<number, string>();
  const numFmts = firstElement(stylesXml, 'numFmts');
  for (const format of numFmts ? findElements(numFmts.inner, 'numFmt') : []) {
    const id = Number(attr(format.attrs, 'numFmtId'));
    const code = attr(format.attrs, 'formatCode');
    if (Number.isInteger(id) && code !== undefined) customFormats.set(id, code);
  }
  const cellXfs = firstElement(stylesXml, 'cellXfs');
  for (const [index, xf] of (cellXfs ? findElements(cellXfs.inner, 'xf') : []).entries()) {
    const id = Number(attr(xf.attrs, 'numFmtId'));
    result.set(index, [14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 45, 46, 47].includes(id) || isDateFormat(customFormats.get(id)));
  }
  return result;
}

function parseRawValue(
  type: string | undefined,
  value: string | undefined,
  sharedStrings: string[],
  date: boolean,
  date1904: boolean
): { rawValue: string | number | boolean | null; valueType: SpreadsheetCell['valueType']; displayValue: string | null; dateIso?: string } {
  if (value === undefined || value === '') return { rawValue: null, valueType: 'blank', displayValue: null };
  if (type === 's') {
    const text = sharedStrings[Number(value)] ?? '';
    return { rawValue: text, valueType: 'string', displayValue: text };
  }
  if (type === 'inlineStr' || type === 'str') {
    return { rawValue: value, valueType: 'string', displayValue: value };
  }
  if (type === 'b') {
    const boolean = value === '1' || value.toLowerCase() === 'true';
    return { rawValue: boolean, valueType: 'boolean', displayValue: String(boolean) };
  }
  if (type === 'e') return { rawValue: value, valueType: 'error', displayValue: value };
  if (type === 'd') {
    const iso = new Date(value).toISOString();
    return { rawValue: value, valueType: 'date', displayValue: iso, dateIso: iso };
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return { rawValue: value, valueType: 'string', displayValue: value };
  if (date) {
    const dateIso = serialToDate(number, date1904);
    return { rawValue: number, valueType: 'date', displayValue: dateIso, dateIso };
  }
  return { rawValue: number, valueType: 'number', displayValue: String(number) };
}

function parseSheetCells(sheetXml: string, sharedStrings: string[], dateStyles: Map<number, boolean>, date1904: boolean): Map<string, ParsedCell> {
  const cells = new Map<string, ParsedCell>();
  let rowFallback = 0;
  for (const rowElement of findElements(sheetXml, 'row')) {
    rowFallback = Number(attr(rowElement.attrs, 'r')) || rowFallback + 1;
    let columnFallback = 0;
    for (const cellElement of findCellElements(rowElement.inner)) {
      columnFallback++;
      const styleId = attr(cellElement.attrs, 's');
      const address = parseCellAddress(attr(cellElement.attrs, 'r'), rowFallback, columnFallback);
      const type = attr(cellElement.attrs, 't');
      const formula = elementText(cellElement.inner, 'f');
      const inlineText = type === 'inlineStr' ? textValues(cellElement.inner, 't').join('') : undefined;
      const value = inlineText ?? elementText(cellElement.inner, 'v');
      const parsed = parseRawValue(type, value, sharedStrings, dateStyles.get(Number(styleId)) === true, date1904);
      const cell: SpreadsheetCell = {
        address: cellAddress(address.row, address.column),
        valueType: parsed.valueType,
        rawValue: parsed.rawValue,
        displayValue: parsed.displayValue,
        ...(formula ? { formula } : {}),
        ...(parsed.dateIso ? { dateIso: parsed.dateIso } : {}),
      };
      cells.set(cell.address, { cell, xml: cellElement.xml, row: address.row, column: address.column, styleId });
    }
  }
  return cells;
}

function usedRange(cells: Map<string, ParsedCell>): SpreadsheetRange | null {
  if (cells.size === 0) return null;
  let startRow = Number.MAX_SAFE_INTEGER;
  let startColumn = Number.MAX_SAFE_INTEGER;
  let endRow = 0;
  let endColumn = 0;
  for (const cell of cells.values()) {
    startRow = Math.min(startRow, cell.row);
    startColumn = Math.min(startColumn, cell.column);
    endRow = Math.max(endRow, cell.row);
    endColumn = Math.max(endColumn, cell.column);
  }
  return { startRow, startColumn, endRow, endColumn };
}

function sharedStringValues(entries: Map<string, Buffer>): string[] {
  const xml = entries.get('xl/sharedStrings.xml')?.toString('utf8');
  if (!xml) return [];
  return findElements(xml, 'si').map((item) => textValues(item.inner, 't').join(''));
}

function relationshipTarget(sourcePart: string, target: string): string {
  return normalizePartName(target, sourcePart);
}

function parseWorkbook(buffer: Buffer): ParsedWorkbook {
  const entries = readZip(buffer);
  const workbookPart = entries.has('xl/workbook.xml') ? 'xl/workbook.xml' : [...entries.keys()].find((key) => /(^|\/)workbook\.xml$/i.test(key));
  if (!workbookPart) fail('XLSX workbook.xml is missing', 'workbook_invalid');
  const workbookXml = entries.get(workbookPart)!.toString('utf8');
  const relsPart = `${workbookPart.slice(0, workbookPart.lastIndexOf('/') + 1)}_rels/${workbookPart.slice(workbookPart.lastIndexOf('/') + 1)}.rels`;
  const relsXml = entries.get(relsPart)?.toString('utf8');
  if (!relsXml) fail('XLSX workbook relationships are missing', 'workbook_invalid');
  const relationships = new Map<string, string>();
  for (const relationship of findElements(relsXml, 'Relationship')) {
    const id = attr(relationship.attrs, 'Id');
    const target = attr(relationship.attrs, 'Target');
    const targetMode = attr(relationship.attrs, 'TargetMode');
    if (id && target && targetMode !== 'External') relationships.set(id, relationshipTarget(workbookPart, target));
  }
  const sharedStrings = sharedStringValues(entries);
  const dateStyles = styleDateMap(entries.get('xl/styles.xml')?.toString('utf8'));
  const date1904 = attr(firstElement(workbookXml, 'workbookPr')?.attrs ?? '', 'date1904') === '1';
  const sheetsElement = firstElement(workbookXml, 'sheets');
  if (!sheetsElement) fail('XLSX workbook sheets are missing', 'workbook_invalid');
  const sheets: ParsedSheet[] = [];
  for (const sheetElement of findElements(sheetsElement.inner, 'sheet')) {
    const name = attr(sheetElement.attrs, 'name');
    const sheetId = Number(attr(sheetElement.attrs, 'sheetId'));
    const relationshipId = attr(sheetElement.attrs, 'r:id', 'id');
    const partName = relationshipId ? relationships.get(relationshipId) : undefined;
    if (!name || !Number.isInteger(sheetId) || !relationshipId || !partName || !entries.has(partName)) {
      fail('XLSX workbook contains an invalid sheet relationship', 'workbook_invalid');
    }
    const xml = entries.get(partName)!.toString('utf8');
    if (!firstElement(xml, 'sheetData')) fail(`Worksheet is missing sheetData: ${name}`, 'workbook_invalid');
    const cells = parseSheetCells(xml, sharedStrings, dateStyles, date1904);
    const range = usedRange(cells);
    sheets.push({
      ref: { name, sheetId, relationshipId, partName },
      xml,
      cells,
      usedRange: range,
      maxRow: range?.endRow ?? 0,
      maxColumn: range?.endColumn ?? 0,
    });
  }
  if (sheets.length === 0) fail('XLSX workbook contains no worksheets', 'workbook_invalid');
  if (sheets.length > SPREADSHEET_LIMITS.maxSheets) fail(`XLSX workbook contains more than ${SPREADSHEET_LIMITS.maxSheets} worksheets`, 'result_too_large');
  return { entries, workbookXml, workbookPart, sheets, date1904 };
}

const WORKSHEET_CHILD_ORDER = [
  'sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData',
  'sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios', 'autoFilter',
  'sortState', 'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr',
  'conditionalFormatting', 'dataValidations', 'hyperlinks', 'printOptions',
  'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks',
  'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing',
  'legacyDrawing', 'legacyDrawingHF', 'picture', 'oleObjects', 'controls',
  'webPublishItems', 'tableParts', 'extLst',
];
const WORKBOOK_CHILD_ORDER = [
  'fileVersion', 'fileSharing', 'workbookPr', 'workbookProtection', 'bookViews',
  'sheets', 'functionGroups', 'externalReferences', 'definedNames', 'calcPr',
  'oleSize', 'customWorkbookViews', 'pivotCaches', 'smartTags', 'extLst',
];
const WORKSHEET_NAMESPACE_ELEMENTS = new Set([
  'worksheet', 'sheetPr', 'dimension', 'sheetViews', 'sheetView', 'sheetFormatPr',
  'cols', 'col', 'sheetData', 'row', 'c', 'f', 'v', 'is', 't', 'sheetCalcPr',
  'sheetProtection', 'protectedRanges', 'protectedRange', 'scenarios', 'scenario',
  'autoFilter', 'sortState', 'sortCondition', 'dataConsolidate', 'customSheetViews',
  'customSheetView', 'mergeCells', 'mergeCell', 'phoneticPr', 'conditionalFormatting',
  'dataValidations', 'dataValidation', 'hyperlinks', 'hyperlink', 'printOptions',
  'pageMargins', 'pageSetup', 'headerFooter', 'drawing', 'tableParts', 'tablePart',
  'extLst',
]);
const WORKBOOK_NAMESPACE_ELEMENTS = new Set([
  'workbook', ...WORKBOOK_CHILD_ORDER, 'sheets', 'sheet', 'definedNames', 'definedName',
]);
const PACKAGE_RELATIONSHIP_ELEMENTS = new Set(['Relationships', 'Relationship']);
const CONTENT_TYPE_ELEMENTS = new Set(['Types', 'Default', 'Override']);

function validateKnownNamespaces(root: XmlNode, expected: string, known: Set<string>, partName: string): void {
  const visit = (node: XmlNode, extensionScope = false): void => {
    if (known.has(node.localName) && !extensionScope && node.namespaceURI !== expected) {
      structuralFailure(partName, '<' + node.name + '> has namespace ' + (node.namespaceURI ?? '(none)') + ', expected ' + expected);
    }
    const childExtensionScope = extensionScope || (node.namespaceURI === expected && (node.localName === 'extLst' || node.localName === 'ext'));
    node.children.forEach((child) => visit(child, childExtensionScope));
  };
  visit(root);
}

function validateChildOrder(parent: XmlNode, order: string[], partName: string): void {
  let last = -1;
  for (const child of parent.children) {
    if (child.namespaceURI !== SPREADSHEETML_NAMESPACE) continue;
    const index = order.indexOf(child.localName);
    if (index < 0) continue;
    if (index < last) structuralFailure(partName, '<' + child.name + '> is out of SpreadsheetML child order');
    last = index;
  }
}

function validateWorksheetDocument(root: XmlNode, partName: string): void {
  if (root.localName !== 'worksheet' || root.namespaceURI !== SPREADSHEETML_NAMESPACE) {
    structuralFailure(partName, 'worksheet root is not in the SpreadsheetML namespace');
  }
  validateKnownNamespaces(root, SPREADSHEETML_NAMESPACE, WORKSHEET_NAMESPACE_ELEMENTS, partName);
  validateChildOrder(root, WORKSHEET_CHILD_ORDER, partName);
  const sheetDataNodes = root.children.filter((child) => child.localName === 'sheetData' && child.namespaceURI === SPREADSHEETML_NAMESPACE);
  if (sheetDataNodes.length !== 1) structuralFailure(partName, 'worksheet must contain exactly one sheetData element');
  const sheetData = sheetDataNodes[0];
  if (sheetData.namespaceURI !== SPREADSHEETML_NAMESPACE) structuralFailure(partName, 'sheetData is not in the SpreadsheetML namespace');
  for (const row of sheetData.children) {
    if (row.namespaceURI !== SPREADSHEETML_NAMESPACE) {
      if (row.localName === 'row' && row.namespaceURI === undefined) structuralFailure(partName, 'sheetData contains a non-SpreadsheetML row');
      continue;
    }
    if (row.localName !== 'row') {
      structuralFailure(partName, 'sheetData contains a non-SpreadsheetML row');
    }
    validateChildOrder(row, ['c', 'extLst'], partName);
    for (const cell of row.children) {
      if (cell.namespaceURI !== SPREADSHEETML_NAMESPACE) {
        if (cell.localName === 'c' && cell.namespaceURI === undefined) structuralFailure(partName, 'row contains a non-SpreadsheetML cell');
        continue;
      }
      if (cell.localName !== 'c') continue;
      validateChildOrder(cell, ['f', 'v', 'is', 'extLst'], partName);
    }
  }
  for (const cols of root.children.filter((child) => child.localName === 'cols' && child.namespaceURI === SPREADSHEETML_NAMESPACE)) {
    for (const col of cols.children) {
      if (col.namespaceURI !== SPREADSHEETML_NAMESPACE) {
        if (col.localName === 'col' && col.namespaceURI === undefined) structuralFailure(partName, 'cols contains a non-SpreadsheetML col');
        continue;
      }
      if (col.localName !== 'col') structuralFailure(partName, 'cols contains a non-SpreadsheetML col');
    }
  }
}

function validateWorkbookDocument(root: XmlNode, partName: string): void {
  if (root.localName !== 'workbook' || root.namespaceURI !== SPREADSHEETML_NAMESPACE) {
    structuralFailure(partName, 'workbook root is not in the SpreadsheetML namespace');
  }
  validateKnownNamespaces(root, SPREADSHEETML_NAMESPACE, WORKBOOK_NAMESPACE_ELEMENTS, partName);
  validateChildOrder(root, WORKBOOK_CHILD_ORDER, partName);
  const sheets = root.children.find((child) => child.localName === 'sheets');
  if (!sheets || sheets.namespaceURI !== SPREADSHEETML_NAMESPACE) structuralFailure(partName, 'workbook sheets are not in the SpreadsheetML namespace');
  for (const sheet of sheets.children) {
    if (sheet.localName !== 'sheet' || sheet.namespaceURI !== SPREADSHEETML_NAMESPACE) structuralFailure(partName, 'workbook contains a non-SpreadsheetML sheet');
    const relationshipId = sheet.attributes.find((attribute) => attribute.localName === 'id');
    if (!relationshipId || relationshipId.namespaceURI !== OFFICE_RELATIONSHIPS_NAMESPACE) structuralFailure(partName, 'workbook sheet relationship id is not namespaced');
  }
}

function validatePackageDocument(root: XmlNode, partName: string): void {
  if (root.localName !== 'Relationships' || root.namespaceURI !== PACKAGE_RELATIONSHIPS_NAMESPACE) {
    structuralFailure(partName, 'relationships root is not in the package relationships namespace');
  }
  validateKnownNamespaces(root, PACKAGE_RELATIONSHIPS_NAMESPACE, PACKAGE_RELATIONSHIP_ELEMENTS, partName);
}

function validateXmlPackage(buffer: Buffer): void {
  const entries = readZip(buffer);
  const documents = new Map<string, XmlNode>();
  for (const [name, data] of entries) {
    if (name.toLowerCase().endsWith('.xml') || name.toLowerCase().endsWith('.rels')) {
      documents.set(name, parseXmlDocument(data.toString('utf8'), name));
    }
  }
  const workbook = parseWorkbook(buffer);
  const workbookDocument = documents.get(workbook.workbookPart);
  if (!workbookDocument) structuralFailure(workbook.workbookPart, 'workbook XML document is missing');
  validateWorkbookDocument(workbookDocument, workbook.workbookPart);
  for (const [name, document] of documents) {
    if (name.toLowerCase().endsWith('.rels')) validatePackageDocument(document, name);
  }
  for (const sheet of workbook.sheets) {
    const sheetDocument = documents.get(sheet.ref.partName);
    if (!sheetDocument) structuralFailure(sheet.ref.partName, 'worksheet XML document is missing');
    validateWorksheetDocument(sheetDocument, sheet.ref.partName);
  }
  const contentTypes = documents.get('[Content_Types].xml');
  if (!contentTypes || contentTypes.localName !== 'Types' || contentTypes.namespaceURI !== CONTENT_TYPES_NAMESPACE) {
    structuralFailure('[Content_Types].xml', 'content types root is invalid');
  }
  validateKnownNamespaces(contentTypes, CONTENT_TYPES_NAMESPACE, CONTENT_TYPE_ELEMENTS, '[Content_Types].xml');
}

function metadata(entries: Map<string, Buffer>): Record<string, string> {
  const result: Record<string, string> = {};
  const core = entries.get('docProps/core.xml')?.toString('utf8');
  if (!core) return result;
  for (const key of ['creator', 'lastModifiedBy', 'created', 'modified', 'title', 'subject']) {
    const value = elementText(core, key);
    if (value) result[key] = value;
  }
  return result;
}

function rowAndColumnCounts(range: SpreadsheetRange | null): { rowCount: number; columnCount: number } {
  return range
    ? { rowCount: range.endRow - range.startRow + 1, columnCount: range.endColumn - range.startColumn + 1 }
    : { rowCount: 0, columnCount: 0 };
}

function toSheetSummary(sheet: ParsedSheet): SpreadsheetSheetSummary {
  const counts = rowAndColumnCounts(sheet.usedRange);
  return {
    name: sheet.ref.name,
    sheetId: sheet.ref.sheetId,
    relationshipId: sheet.ref.relationshipId,
    usedRange: sheet.usedRange ? spreadsheetRangeToString(sheet.usedRange) : null,
    rowCount: counts.rowCount,
    columnCount: counts.columnCount,
  };
}

function resolveSheet(workbook: ParsedWorkbook, selector: SpreadsheetSheetSelector): ParsedSheet {
  const byName = selector.sheetName === undefined
    ? undefined
    : workbook.sheets.find((candidate) => candidate.ref.name === selector.sheetName);
  const byId = selector.sheetId === undefined
    ? undefined
    : workbook.sheets.find((candidate) => candidate.ref.sheetId === selector.sheetId);
  const sheet = selector.sheetName !== undefined && selector.sheetId !== undefined
    ? byName !== undefined && byName === byId ? byName : undefined
    : byName ?? byId;
  if (!sheet) fail(`Spreadsheet sheet was not found: ${selector.sheetName ?? selector.sheetId}`, 'sheet_not_found');
  return sheet;
}

function selectedSheets(workbook: ParsedWorkbook, selector: SpreadsheetSheetSelector): ParsedSheet[] {
  return selector.sheetName !== undefined || selector.sheetId !== undefined
    ? [resolveSheet(workbook, selector)]
    : workbook.sheets;
}

function blankCell(address: string): SpreadsheetCell {
  return { address, valueType: 'blank', rawValue: null, displayValue: null };
}

function primitiveText(value: SpreadsheetCellInput): string {
  if (value === null) return '';
  if (typeof value === 'object') {
    if (value.type === 'date') return new Date(value.value).toISOString();
    return value.formula.replace(/^=/, '');
  }
  return String(value);
}

function cellMatches(value: SpreadsheetCellInput, cell: SpreadsheetCell): boolean {
  if (value === null) return cell.valueType === 'blank' || cell.rawValue === null;
  if (typeof value === 'string') return cell.rawValue === value;
  if (typeof value === 'number') return cell.rawValue === value;
  if (typeof value === 'boolean') return cell.rawValue === value;
  if (value.type === 'date') return cell.dateIso === new Date(value.value).toISOString() || cell.displayValue === new Date(value.value).toISOString();
  return cell.formula?.replace(/^=/, '') === value.formula.replace(/^=/, '');
}

function canonicalCellValue(value: SpreadsheetCellInput | SpreadsheetCell): string {
  if (typeof value === 'object' && value !== null && 'valueType' in value) {
    if (value.valueType === 'date') return `date:${value.dateIso ?? value.displayValue ?? ''}`;
    return `${value.valueType}:${String(value.rawValue ?? '')}`;
  }
  if (value === null) return 'blank:';
  if (typeof value === 'object') return `${value.type}:${value.type === 'date' ? new Date(value.value).toISOString() : value.formula.replace(/^=/, '')}`;
  return `${typeof value}:${String(value)}`;
}

function headerMap(sheet: ParsedSheet): Map<string, number> {
  const result = new Map<string, number>();
  for (const cell of sheet.cells.values()) {
    if (cell.row !== 1 || cell.cell.valueType === 'blank') continue;
    const key = String(cell.cell.rawValue);
    if (result.has(key)) fail(`Duplicate header name in row 1: ${key}`, 'invalid_row_shape');
    result.set(key, cell.column);
  }
  return result;
}

function getHeader(sheet: ParsedSheet, column: number): string | undefined {
  const cell = sheet.cells.get(cellAddress(1, column));
  return cell && cell.cell.rawValue !== null ? String(cell.cell.rawValue) : undefined;
}

function rowValues(sheet: ParsedSheet, row: number, width: number): SpreadsheetCellInput[] {
  return Array.from({ length: width }, (_, index) => sheet.cells.get(cellAddress(row, index + 1))?.cell.rawValue ?? null);
}

function normalizeFormula(value: string): string {
  return value.replace(/^=/, '');
}

interface XmlNames {
  prefix: string;
  element(localName: string): string;
}

function xmlNames(xml: string, rootLocalName: string, namespaceURI: string, partName = rootLocalName + '.xml'): XmlNames {
  const root = parseXmlDocument(xml, partName);
  if (root.localName !== rootLocalName || root.namespaceURI !== namespaceURI) {
    fail('XML root is not in the expected namespace: ' + rootLocalName, 'workbook_invalid');
  }
  return {
    prefix: root.prefix,
    element: (localName) => root.prefix ? root.prefix + ':' + localName : localName,
  };
}

function spreadsheetMlNames(xml: string, rootLocalName: 'worksheet' | 'workbook'): XmlNames {
  return xmlNames(xml, rootLocalName, SPREADSHEETML_NAMESPACE);
}

const DEFAULT_SPREADSHEET_NAMES: XmlNames = {
  prefix: '',
  element: (localName) => localName,
};

function cellXmlWithNames(address: string, value: SpreadsheetCellInput, styleId: string | undefined, names: XmlNames): string {
  const element = (name: string, body: string, attributes = '') => '<' + names.element(name) + attributes + '>' + body + '</' + names.element(name) + '>';
  const empty = (name: string, attributes = '') => '<' + names.element(name) + attributes + '/>';
  const attrs = ' r="' + address + '"' + (styleId ? ' s="' + xmlEncode(styleId) + '"' : '');
  if (value === null) return empty('c', attrs);
  if (typeof value === 'string') {
    const space = value.trim() === value ? '' : ' xml:space="preserve"';
    return element('c', element('is', element('t', xmlEncode(value), space)), attrs + ' t="inlineStr"');
  }
  if (typeof value === 'number') return element('c', element('v', String(value)), attrs);
  if (typeof value === 'boolean') return element('c', element('v', value ? '1' : '0'), attrs + ' t="b"');
  if (value.type === 'date') return element('c', element('v', xmlEncode(new Date(value.value).toISOString())), attrs + ' t="d"');
  const formula = normalizeFormula(value.formula);
  const cached = value.cachedValue;
  const formulaXml = element('f', xmlEncode(formula));
  if (cached === undefined || cached === null) return element('c', formulaXml, attrs);
  const valueXml = element('v', typeof cached === 'string' ? xmlEncode(cached) : typeof cached === 'boolean' ? (cached ? '1' : '0') : String(cached));
  return element('c', formulaXml + valueXml, attrs + (typeof cached === 'string' ? ' t="str"' : typeof cached === 'boolean' ? ' t="b"' : ''));
}
function replaceStringRanges(value: string, replacements: Array<{ start: number; end: number; replacement: string }>): string {
  let result = value;
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, replacement.start) + replacement.replacement + result.slice(replacement.end);
  }
  return result;
}

function updateDimension(xml: string, range: SpreadsheetRange | null, names = DEFAULT_SPREADSHEET_NAMES): string {
  if (!range) return xml;
  const ref = spreadsheetRangeToString(range);
  const dimension = firstElement(xml, 'dimension');
  if (dimension) {
    const replacement = '<' + names.element('dimension') + dimension.attrs.replace(/\s+ref\s*=\s*"[^"]*"/, '') + ' ref="' + ref + '"/>';
    return xml.slice(0, dimension.start) + replacement + xml.slice(dimension.end);
  }
  const anchors = ['sheetViews', 'sheetFormatPr', 'cols', 'sheetData']
    .map((localName) => firstElement(xml, localName))
    .filter((element): element is XmlElement => element !== undefined)
    .sort((a, b) => a.start - b.start);
  const insertionAt = anchors[0]?.start ?? xml.lastIndexOf('</');
  if (insertionAt < 0) fail('Worksheet root is invalid', 'workbook_invalid');
  const insertion = '<' + names.element('dimension') + ' ref="' + ref + '"/>';
  return xml.slice(0, insertionAt) + insertion + xml.slice(insertionAt);
}

function mutateSheetXml(
  xml: string,
  updates: Map<string, SpreadsheetCellInput>,
  rangeAfter: SpreadsheetRange | null
): string {
  const names = spreadsheetMlNames(xml, 'worksheet');
  const sheetData = firstElement(xml, 'sheetData');
  if (!sheetData) fail('Worksheet is missing sheetData', 'workbook_invalid');
  const rows = new Map<number, XmlElement>();
  for (const row of findElements(sheetData.inner, 'row')) rows.set(Number(attr(row.attrs, 'r')) || rows.size + 1, row);
  const updatesByRow = new Map<number, Array<{ address: string; column: number; value: SpreadsheetCellInput }>>();
  for (const [address, value] of updates) {
    const parsed = parseCellAddress(address, 1, 1);
    const list = updatesByRow.get(parsed.row) ?? [];
    list.push({ address, column: parsed.column, value });
    updatesByRow.set(parsed.row, list);
  }

  for (const [rowNumber, rowUpdates] of updatesByRow) {
    const row = rows.get(rowNumber);
    if (row) {
      const replacements: Array<{ start: number; end: number; replacement: string }> = [];
      const cells = findCellElements(row.inner);
      const existing = new Map<string, XmlElement>();
      for (const cell of cells) {
        const parsed = parseCellAddress(attr(cell.attrs, 'r'), rowNumber, existing.size + 1);
        existing.set(cellAddress(parsed.row, parsed.column), cell);
      }
      const append: string[] = [];
      for (const update of rowUpdates) {
        const old = existing.get(update.address);
        const styleId = old ? attr(old.attrs, 's') : undefined;
        if (old) replacements.push({ start: old.start, end: old.end, replacement: cellXmlWithNames(update.address, update.value, styleId, names) });
        else append.push(cellXmlWithNames(update.address, update.value, undefined, names));
      }
      let inner = replaceStringRanges(row.inner, replacements);
      if (append.length > 0) inner += append.sort().join('');
      const replacement = '<' + names.element('row') + row.attrs + '>' + inner + '</' + names.element('row') + '>';
      rowUpdates.sort((a, b) => a.column - b.column);
      (row as XmlElement & { replacement?: string }).replacement = replacement;
    } else {
      const cells = rowUpdates.sort((a, b) => a.column - b.column).map((update) => cellXmlWithNames(update.address, update.value, undefined, names)).join('');
      (rowUpdates as unknown as { replacement?: string }).replacement = '<' + names.element('row') + ' r="' + rowNumber + '">' + cells + '</' + names.element('row') + '>';
    }
  }

  const rowXml = new Map<number, string>();
  for (const [rowNumber, row] of rows) rowXml.set(rowNumber, (row as XmlElement & { replacement?: string }).replacement ?? row.xml);
  for (const [rowNumber, rowUpdates] of updatesByRow) {
    if (!rowXml.has(rowNumber)) rowXml.set(rowNumber, (rowUpdates as unknown as { replacement?: string }).replacement ?? '');
  }
  const sheetDataName = names.element('sheetData');
  const newSheetData = '<' + sheetDataName + '>' + [...rowXml.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value).join('') + '</' + sheetDataName + '>';
  const updated = xml.slice(0, sheetData.start) + newSheetData + xml.slice(sheetData.end);
  return updateDimension(updated, rangeAfter, names);
}

function cloneEntries(entries: Map<string, Buffer>): Map<string, Buffer> {
  return new Map([...entries.entries()].map(([name, data]) => [name, Buffer.from(data)]));
}

function serializeWorkbook(workbook: ParsedWorkbook): Buffer {
  return writeZip(workbook.entries);
}

function workbookWithSheetUpdate(workbook: ParsedWorkbook, sheet: ParsedSheet, updates: Map<string, SpreadsheetCellInput>, rangeAfter: SpreadsheetRange | null): Buffer {
  const updatedXml = mutateSheetXml(sheet.xml, updates, rangeAfter);
  workbook.entries.set(sheet.ref.partName, Buffer.from(updatedXml, 'utf8'));
  return serializeWorkbook(workbook);
}

function sheetExpectedCells(sheet: ParsedSheet, updates: Map<string, SpreadsheetCellInput>): ExpectedSpreadsheetCell[] {
  return [...updates.entries()].map(([address, value]) => ({ sheetName: sheet.ref.name, sheetId: sheet.ref.sheetId, address, value }));
}

function materializeRows(
  rows: SpreadsheetRowInput[] | undefined,
  headers: string[] | undefined
): { headers: string[]; values: SpreadsheetCellInput[][] } {
  const inputRows = rows ?? [];
  let effectiveHeaders = headers ? [...headers] : [];
  if (effectiveHeaders.length === 0 && inputRows.some((row) => !Array.isArray(row))) {
    const firstObject = inputRows.find((row) => !Array.isArray(row)) as Record<string, SpreadsheetCellInput> | undefined;
    effectiveHeaders = firstObject ? Object.keys(firstObject) : [];
  }
  const values = inputRows.map((row, index) => {
    if (Array.isArray(row)) {
      if (effectiveHeaders.length > 0 && row.length > effectiveHeaders.length) fail(`Row ${index + 1} has more cells than the headers`, 'invalid_row_shape');
      return [...row];
    }
    if (effectiveHeaders.length === 0) fail(`Row ${index + 1} needs headers`, 'invalid_row_shape');
    for (const key of Object.keys(row)) if (!effectiveHeaders.includes(key)) fail(`Row ${index + 1} contains unknown header: ${key}`, 'invalid_row_shape');
    return effectiveHeaders.map((header) => row[header] ?? null);
  });
  return { headers: effectiveHeaders, values };
}

function rangeForUpdates(updates: Map<string, SpreadsheetCellInput>): SpreadsheetRange | null {
  if (updates.size === 0) return null;
  let startRow = Number.MAX_SAFE_INTEGER;
  let startColumn = Number.MAX_SAFE_INTEGER;
  let endRow = 0;
  let endColumn = 0;
  for (const address of updates.keys()) {
    const parsed = parseCellAddress(address, 1, 1);
    startRow = Math.min(startRow, parsed.row);
    startColumn = Math.min(startColumn, parsed.column);
    endRow = Math.max(endRow, parsed.row);
    endColumn = Math.max(endColumn, parsed.column);
  }
  return { startRow, startColumn, endRow, endColumn };
}

function unionRanges(a: SpreadsheetRange | null, b: SpreadsheetRange | null): SpreadsheetRange | null {
  if (!a) return b;
  if (!b) return a;
  return {
    startRow: Math.min(a.startRow, b.startRow),
    startColumn: Math.min(a.startColumn, b.startColumn),
    endRow: Math.max(a.endRow, b.endRow),
    endColumn: Math.max(a.endColumn, b.endColumn),
  };
}

function dateInput(value: SpreadsheetDateValue): string {
  return new Date(value.value).toISOString();
}

function expectedMatches(buffer: Buffer, expected: ExpectedSpreadsheetCell[]): void {
  const workbook = parseWorkbook(buffer);
  for (const item of expected) {
    const sheet = resolveSheet(workbook, { sheetName: item.sheetName, sheetId: item.sheetId });
    const cell = sheet.cells.get(item.address)?.cell ?? blankCell(item.address);
    if (!cellMatches(item.value, cell)) fail(`Read-after-write verification failed for ${item.sheetName}!${item.address}`, 'verification_failed');
  }
}

function addRowsToSheetXml(
  sheet: ParsedSheet,
  rows: SpreadsheetCellInput[][],
  startRow: number,
  startColumn: number,
  styles?: { boldHeader?: boolean }
): { updates: Map<string, SpreadsheetCellInput>; range: SpreadsheetRange } {
  const updates = new Map<string, SpreadsheetCellInput>();
  let width = 0;
  rows.forEach((row, rowIndex) => {
    width = Math.max(width, row.length);
    row.forEach((value, columnIndex) => updates.set(cellAddress(startRow + rowIndex, startColumn + columnIndex), value));
  });
  if (styles?.boldHeader) {
    // The generated workbook already defines style 1; existing workbooks keep their current style for updates.
    // Header formatting for existing sheets is intentionally limited to new workbooks.
  }
  return {
    updates,
    range: { startRow, startColumn, endRow: startRow + rows.length - 1, endColumn: startColumn + width - 1 },
  };
}

export class XlsxSpreadsheetProvider implements SpreadsheetProvider {
  validate(buffer: Buffer): void {
    validateXmlPackage(buffer);
  }

  inspect(buffer: Buffer, workspaceId: string, relativePath: string, fileHash: string): SpreadsheetInspection {
    const workbook = parseWorkbook(buffer);
    const namedRanges = findElements(workbook.workbookXml, 'definedName')
      .map((element) => ({ name: attr(element.attrs, 'name') ?? '', reference: xmlDecode(element.inner) }))
      .filter((entry) => entry.name.length > 0);
    return {
      workspaceId,
      relativePath,
      format: 'xlsx',
      fileHash,
      sizeBytes: buffer.length,
      sheets: workbook.sheets.map(toSheetSummary),
      namedRanges,
      metadata: metadata(workbook.entries),
      warnings: [],
    };
  }

  readRange(buffer: Buffer, request: ReadSpreadsheetRangeRequest, fileHash: string): import('@bridge/shared').ReadSpreadsheetRangeResult {
    const workbook = parseWorkbook(buffer);
    const sheet = resolveSheet(workbook, request);
    const range = normalizeSpreadsheetRange(request);
    const cellCount = (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1);
    if (cellCount > SPREADSHEET_LIMITS.maxCellsReturned) fail(`Requested range contains ${cellCount} cells; max is ${SPREADSHEET_LIMITS.maxCellsReturned}`, 'result_too_large');
    const rows: SpreadsheetCell[][] = [];
    for (let row = range.startRow; row <= range.endRow; row++) {
      const values: SpreadsheetCell[] = [];
      for (let column = range.startColumn; column <= range.endColumn; column++) {
        const address = cellAddress(row, column);
        values.push(sheet.cells.get(address)?.cell ?? blankCell(address));
      }
      rows.push(values);
    }
    const valueMode = request.valueMode ?? 'both';
    return {
      workspaceId: request.workspaceId,
      relativePath: request.relativePath,
      format: 'xlsx',
      sheetName: sheet.ref.name,
      sheetId: sheet.ref.sheetId,
      range: spreadsheetRangeToString(range),
      rows,
      rowCount: range.endRow - range.startRow + 1,
      columnCount: range.endColumn - range.startColumn + 1,
      cellCount,
      fileHash,
      valueMode,
    };
  }

  search(buffer: Buffer, request: SearchSpreadsheetRequest, fileHash: string): import('@bridge/shared').SearchSpreadsheetResult {
    const workbook = parseWorkbook(buffer);
    const matches: SpreadsheetSearchMatch[] = [];
    const limit = request.limit ?? SPREADSHEET_LIMITS.maxSearchResults;
    let scanned = 0;
    for (const sheet of selectedSheets(workbook, request)) {
      const targetColumn = request.column === undefined ? undefined : headerMap(sheet).get(request.column);
      if (request.column !== undefined && targetColumn === undefined) fail(`Header was not found: ${request.column}`, 'key_not_found');
      for (const parsed of sheet.cells.values()) {
        if (targetColumn !== undefined && parsed.column !== targetColumn) continue;
        scanned++;
        if (scanned > SPREADSHEET_LIMITS.maxSearchCells) fail(`Search exceeded ${SPREADSHEET_LIMITS.maxSearchCells} scanned cells`, 'result_too_large');
        const exact = cellMatches(request.query, parsed.cell);
        const contains = request.match === 'contains' && primitiveText(request.query).length > 0 && (parsed.cell.displayValue ?? '').toLowerCase().includes(primitiveText(request.query).toLowerCase());
        if (exact || contains) {
          matches.push({ sheetName: sheet.ref.name, sheetId: sheet.ref.sheetId, address: parsed.cell.address, row: parsed.row, column: parsed.column, cell: parsed.cell });
          if (matches.length >= limit) break;
        }
      }
      if (matches.length >= limit) break;
    }
    return {
      workspaceId: request.workspaceId,
      relativePath: request.relativePath,
      format: 'xlsx',
      query: request.query,
      matches,
      truncated: matches.length >= limit,
      fileHash,
    };
  }

  appendRows(buffer: Buffer, request: AppendSpreadsheetRowsRequest): SpreadsheetProviderMutation {
    const workbook = parseWorkbook(buffer);
    const sheet = resolveSheet(workbook, request);
    const headers = headerMap(sheet);
    const firstRow = request.rows[0];
    let effectiveHeaders = [...headers.entries()].sort((a, b) => a[1] - b[1]).map(([name]) => name);
    const headerMapping = request.headerMapping ?? {};
    const objectRows = request.rows.filter((row) => !Array.isArray(row)) as Record<string, SpreadsheetCellInput>[];
    if (objectRows.length > 0 && effectiveHeaders.length === 0) {
      const sourceKeys = Object.keys(objectRows[0]);
      effectiveHeaders = sourceKeys.map((key) => headerMapping[key] ?? key);
    }
    if (objectRows.length > 0 && effectiveHeaders.length === 0) fail('Object rows need a header row', 'invalid_row_shape');
    const values = request.rows.map((row, rowIndex) => {
      if (Array.isArray(row)) {
        if (effectiveHeaders.length > 0 && row.length > effectiveHeaders.length) fail(`Row ${rowIndex + 1} exceeds the existing header width`, 'invalid_row_shape');
        return row;
      }
      for (const key of Object.keys(row)) {
        const target = headerMapping[key] ?? key;
        if (!effectiveHeaders.includes(target)) fail(`Row ${rowIndex + 1} contains unknown header: ${target}`, 'invalid_row_shape');
      }
      return effectiveHeaders.map((header) => {
        const sourceKey = Object.keys(row).find((key) => (headerMapping[key] ?? key) === header);
        return sourceKey === undefined ? null : row[sourceKey];
      });
    });
    const createsHeader = objectRows.length > 0 && headers.size === 0;
    const startRow = createsHeader ? 2 : Math.max(1, sheet.maxRow + 1);
    const startColumn = 1;
    const dataMutation = addRowsToSheetXml(sheet, values, startRow, startColumn);
    const updates = dataMutation.updates;
    if (createsHeader) {
      const headerValues = effectiveHeaders.map((header) => header);
      const headerMutation = addRowsToSheetXml(sheet, [headerValues], 1, 1);
      for (const [address, value] of headerMutation.updates) updates.set(address, value);
    }
    const newRange = unionRanges(sheet.usedRange, unionRanges(dataMutation.range, createsHeader ? { startRow: 1, startColumn: 1, endRow: 1, endColumn: effectiveHeaders.length } : null));
    const after = workbookWithSheetUpdate(workbook, sheet, updates, newRange);
    const expected = sheetExpectedCells(sheet, updates);
    const insertedRows = values.map((_, index) => startRow + index);
    return {
      buffer: after,
      affectedRange: newRange ? spreadsheetRangeToString(dataMutation.range) : null,
      rowCount: values.length,
      cellCount: updates.size,
      insertedRows,
      updatedRows: [],
      warnings: firstRow && !Array.isArray(firstRow) && createsHeader ? ['A header row was created from object keys.'] : [],
      verify: (readBack) => expectedMatches(readBack, expected),
    };
  }

  updateRange(buffer: Buffer, request: UpdateSpreadsheetRangeRequest): SpreadsheetProviderMutation {
    const workbook = parseWorkbook(buffer);
    const sheet = resolveSheet(workbook, request);
    const range = normalizeSpreadsheetRange(request);
    const expectedRows = range.endRow - range.startRow + 1;
    const expectedColumns = range.endColumn - range.startColumn + 1;
    if (request.values.length !== expectedRows || request.values.some((row) => row.length !== expectedColumns)) {
      fail(`values dimensions do not match ${spreadsheetRangeToString(range)}`, 'invalid_row_shape');
    }
    const updates = new Map<string, SpreadsheetCellInput>();
    request.values.forEach((row, rowIndex) => row.forEach((value, columnIndex) => updates.set(cellAddress(range.startRow + rowIndex, range.startColumn + columnIndex), value)));
    const newRange = unionRanges(sheet.usedRange, range);
    const after = workbookWithSheetUpdate(workbook, sheet, updates, newRange);
    const expected = sheetExpectedCells(sheet, updates);
    return {
      buffer: after,
      affectedRange: spreadsheetRangeToString(range),
      rowCount: expectedRows,
      cellCount: updates.size,
      insertedRows: [],
      updatedRows: [...new Set([...updates.keys()].map((address) => parseCellAddress(address, 1, 1).row))],
      warnings: [],
      verify: (readBack) => expectedMatches(readBack, expected),
    };
  }

  updateRowsByKey(buffer: Buffer, request: UpdateSpreadsheetRowsByKeyRequest): SpreadsheetProviderMutation {
    const workbook = parseWorkbook(buffer);
    const sheet = resolveSheet(workbook, request);
    const headers = headerMap(sheet);
    const keyColumns = request.keyColumns.map((key) => headers.get(key));
    if (keyColumns.some((column) => column === undefined)) fail('A key column was not found in row 1', 'key_not_found');
    const changeColumns = Object.keys(request.changes).map((key) => headers.get(key));
    if (changeColumns.some((column) => column === undefined)) fail('A change column was not found in row 1', 'key_not_found');
    const matches: number[] = [];
    for (let row = 2; row <= sheet.maxRow; row++) {
      if (request.keyColumns.every((key, index) => cellMatches(request.key[key], sheet.cells.get(cellAddress(row, keyColumns[index] as number))?.cell ?? blankCell(cellAddress(row, keyColumns[index] as number))))) matches.push(row);
    }
    if (matches.length === 0) fail('No spreadsheet row matched the requested key', 'key_not_found');
    if (matches.length > 1) fail(`Spreadsheet key matched ${matches.length} rows`, 'duplicate_key');
    const row = matches[0];
    const updates = new Map<string, SpreadsheetCellInput>();
    Object.entries(request.changes).forEach(([key, value]) => updates.set(cellAddress(row, headers.get(key) as number), value));
    const after = workbookWithSheetUpdate(workbook, sheet, updates, unionRanges(sheet.usedRange, rangeForUpdates(updates)));
    const expected = sheetExpectedCells(sheet, updates);
    return {
      buffer: after,
      affectedRange: rangeForUpdates(updates) ? spreadsheetRangeToString(rangeForUpdates(updates) as SpreadsheetRange) : null,
      rowCount: 1,
      cellCount: updates.size,
      insertedRows: [],
      updatedRows: [row],
      warnings: [],
      verify: (readBack) => expectedMatches(readBack, expected),
    };
  }

  upsertRows(buffer: Buffer, request: UpsertSpreadsheetRowsRequest): SpreadsheetProviderMutation {
    const workbook = parseWorkbook(buffer);
    const sheet = resolveSheet(workbook, request);
    let headers = [...headerMap(sheet).entries()].sort((a, b) => a[1] - b[1]).map(([name]) => name);
    const createdHeaders = headers.length === 0;
    const updates = new Map<string, SpreadsheetCellInput>();
    if (headers.length === 0) {
      const allKeys: string[] = [];
      for (const row of request.rows) for (const key of Object.keys(row)) if (!allKeys.includes(key)) allKeys.push(key);
      headers = [...request.keyColumns, ...allKeys.filter((key) => !request.keyColumns.includes(key))];
      headers.forEach((header, index) => updates.set(cellAddress(1, index + 1), header));
    }
    const columns = new Map(headers.map((header, index) => [header, index + 1]));
    if (request.keyColumns.some((key) => !columns.has(key))) fail('A key column was not found in row 1', 'key_not_found');
    for (const row of request.rows) for (const key of Object.keys(row)) if (!columns.has(key)) fail(`Row contains unknown header: ${key}`, 'invalid_row_shape');

    const existingByKey = new Map<string, number[]>();
    for (let row = 2; row <= sheet.maxRow; row++) {
      const key = request.keyColumns.map((column) => canonicalCellValue(sheet.cells.get(cellAddress(row, columns.get(column) as number))?.cell ?? blankCell(cellAddress(row, columns.get(column) as number)))).join('|');
      const rows = existingByKey.get(key) ?? [];
      rows.push(row);
      existingByKey.set(key, rows);
    }
    const incomingKeys = new Set<string>();
    const insertedRows: number[] = [];
    const updatedRows: number[] = [];
    let nextRow = createdHeaders ? 2 : Math.max(1, sheet.maxRow + 1);
    for (const row of request.rows) {
      const key = request.keyColumns.map((column) => canonicalCellValue(row[column] ?? null)).join('|');
      if (incomingKeys.has(key)) fail('Input rows contain duplicate keys', 'duplicate_key');
      incomingKeys.add(key);
      const existing = existingByKey.get(key) ?? [];
      if (existing.length > 1) fail(`Spreadsheet key matched ${existing.length} rows`, 'duplicate_key');
      if (existing.length === 1) {
        const rowNumber = existing[0];
        updatedRows.push(rowNumber);
        for (const [header, value] of Object.entries(row)) updates.set(cellAddress(rowNumber, columns.get(header) as number), value);
      } else {
        const rowNumber = nextRow++;
        insertedRows.push(rowNumber);
        headers.forEach((header, index) => updates.set(cellAddress(rowNumber, index + 1), row[header] ?? null));
      }
    }
    if (updates.size === 0) fail('No spreadsheet cells were supplied for upsert', 'invalid_row_shape');
    const newRange = unionRanges(sheet.usedRange, rangeForUpdates(updates));
    const after = workbookWithSheetUpdate(workbook, sheet, updates, newRange);
    const expected = sheetExpectedCells(sheet, updates);
    return {
      buffer: after,
      affectedRange: rangeForUpdates(updates) ? spreadsheetRangeToString(rangeForUpdates(updates) as SpreadsheetRange) : null,
      rowCount: insertedRows.length + updatedRows.length,
      cellCount: updates.size,
      insertedRows,
      updatedRows,
      warnings: [],
      verify: (readBack) => expectedMatches(readBack, expected),
    };
  }

  createWorkbook(request: CreateSpreadsheetRequest): SpreadsheetProviderMutation {
    const entries = new Map<string, Buffer>();
    const sheets = request.sheets ?? [{ name: 'Sheet1' }];
    const sheetRefs: Array<{ definition: SpreadsheetSheetDefinition; sheetId: number; relationshipId: string; partName: string }> = [];
    sheets.forEach((definition, index) => sheetRefs.push({ definition, sheetId: index + 1, relationshipId: `rId${index + 1}`, partName: `xl/worksheets/sheet${index + 1}.xml` }));
    entries.set('[Content_Types].xml', Buffer.from(contentTypesXml(sheetRefs.map((sheet) => sheet.partName)), 'utf8'));
    entries.set('_rels/.rels', Buffer.from(rootRelationshipsXml(), 'utf8'));
    entries.set('xl/workbook.xml', Buffer.from(workbookXml(sheetRefs), 'utf8'));
    entries.set('xl/_rels/workbook.xml.rels', Buffer.from(workbookRelationshipsXml(sheetRefs), 'utf8'));
    entries.set('xl/styles.xml', Buffer.from(stylesXml(), 'utf8'));
    entries.set('docProps/core.xml', Buffer.from(corePropertiesXml(), 'utf8'));
    entries.set('docProps/app.xml', Buffer.from(appPropertiesXml(sheetRefs.map((sheet) => sheet.definition.name)), 'utf8'));
    const expected: ExpectedSpreadsheetCell[] = [];
    for (const sheet of sheetRefs) {
      const materialized = materializeRows(sheet.definition.rows, sheet.definition.headers);
      const allRows = materialized.headers.length > 0 ? [materialized.headers, ...materialized.values] : materialized.values;
      const xml = worksheetXml(allRows, sheet.definition.boldHeaders === true);
      entries.set(sheet.partName, Buffer.from(xml, 'utf8'));
      allRows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => expected.push({ sheetName: sheet.definition.name, sheetId: sheet.sheetId, address: cellAddress(rowIndex + 1, columnIndex + 1), value })));
    }
    const after = writeZip(entries);
    return {
      buffer: after,
      affectedRange: null,
      rowCount: request.sheets?.reduce((sum, sheet) => sum + (sheet.rows?.length ?? 0), 0) ?? 0,
      cellCount: expected.length,
      insertedRows: [],
      updatedRows: [],
      warnings: [],
      verify: (readBack) => {
        const workbook = parseWorkbook(readBack);
        if (workbook.sheets.length !== sheetRefs.length || sheetRefs.some((sheet) => !workbook.sheets.some((candidate) => candidate.ref.name === sheet.definition.name))) fail('Created workbook sheet verification failed', 'verification_failed');
        expectedMatches(readBack, expected);
      },
    };
  }

  createSheet(buffer: Buffer, request: CreateSpreadsheetSheetRequest): SpreadsheetProviderMutation {
    const workbook = parseWorkbook(buffer);
    if (workbook.sheets.some((sheet) => sheet.ref.name === request.sheetName)) fail(`Spreadsheet sheet already exists: ${request.sheetName}`, 'duplicate_key');
    const ids = workbook.sheets.map((sheet) => sheet.ref.sheetId);
    const nextSheetId = Math.max(0, ...ids) + 1;
    let nextPartIndex = 1;
    while (workbook.entries.has(`xl/worksheets/sheet${nextPartIndex}.xml`)) nextPartIndex++;
    const partName = `xl/worksheets/sheet${nextPartIndex}.xml`;
    const materialized = materializeRows(request.rows, request.headers);
    const allRows = materialized.headers.length > 0 ? [materialized.headers, ...materialized.values] : materialized.values;
    const expected: ExpectedSpreadsheetCell[] = [];
    allRows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => expected.push({ sheetName: request.sheetName, sheetId: nextSheetId, address: cellAddress(rowIndex + 1, columnIndex + 1), value })));
    workbook.entries.set(partName, Buffer.from(worksheetXml(allRows, request.boldHeaders === true), 'utf8'));
    const sheetsElement = firstElement(workbook.workbookXml, 'sheets');
    const relsPart = `${workbook.workbookPart.slice(0, workbook.workbookPart.lastIndexOf('/') + 1)}_rels/${workbook.workbookPart.slice(workbook.workbookPart.lastIndexOf('/') + 1)}.rels`;
    const relsXml = workbook.entries.get(relsPart)?.toString('utf8');
    if (!sheetsElement || !relsXml) fail('XLSX workbook relationships are invalid', 'workbook_invalid');
    const relationshipIds = new Set(findElements(relsXml, 'Relationship').map((relationship) => attr(relationship.attrs, 'Id')).filter((id): id is string => id !== undefined));
    let relationshipIndex = 1;
    while (relationshipIds.has(`rId${relationshipIndex}`)) relationshipIndex++;
    const nextRelationshipId = `rId${relationshipIndex}`;
    const workbookNames = spreadsheetMlNames(workbook.workbookXml, 'workbook');
    const workbookDocument = parseXmlDocument(workbook.workbookXml, workbook.workbookPart);
    const workbookSheets = workbookDocument.children.find((child) => child.localName === 'sheets');
    const relationshipIdAttribute = workbookSheets?.children.find((child) => child.localName === 'sheet')?.attributes.find((attribute) => attribute.localName === 'id');
    const relationshipIdName = relationshipIdAttribute?.name ?? 'r:id';
    const sheetTag = '<' + workbookNames.element('sheet') + ' name="' + xmlEncode(request.sheetName) + '" sheetId="' + nextSheetId + '" ' + relationshipIdName + '="' + nextRelationshipId + '"/>';
    const sheetsCloseStart = workbook.workbookXml.lastIndexOf('</', sheetsElement.end);
    if (sheetsCloseStart < sheetsElement.start) fail('XLSX workbook sheets are invalid', 'workbook_invalid');
    workbook.workbookXml = workbook.workbookXml.slice(0, sheetsCloseStart) + sheetTag + workbook.workbookXml.slice(sheetsCloseStart);
    const relationshipNames = xmlNames(relsXml, 'Relationships', PACKAGE_RELATIONSHIPS_NAMESPACE, relsPart);
    const relTag = `<${relationshipNames.element('Relationship')} Id="${nextRelationshipId}" Type="${OFFICE_RELATIONSHIPS_NAMESPACE}/worksheet" Target="worksheets/${pathName(partName)}"/>`;
    const relEnd = relsXml.lastIndexOf('</' + relationshipNames.element('Relationships') + '>');
    if (relEnd < 0) fail('XLSX workbook relationships are invalid', 'workbook_invalid');
    workbook.entries.set(workbook.workbookPart, Buffer.from(workbook.workbookXml, 'utf8'));
    workbook.entries.set(relsPart, Buffer.from(relsXml.slice(0, relEnd) + relTag + relsXml.slice(relEnd), 'utf8'));
    const contentTypes = workbook.entries.get('[Content_Types].xml')?.toString('utf8');
    if (!contentTypes) fail('XLSX content types are missing', 'workbook_invalid');
    const contentNames = xmlNames(contentTypes, 'Types', CONTENT_TYPES_NAMESPACE, '[Content_Types].xml');
    const contentEnd = contentTypes.lastIndexOf('</' + contentNames.element('Types') + '>');
    if (contentEnd < 0) fail('XLSX content types are invalid', 'workbook_invalid');
    const override = `<${contentNames.element('Override')} PartName="/${partName}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
    workbook.entries.set('[Content_Types].xml', Buffer.from(contentTypes.slice(0, contentEnd) + override + contentTypes.slice(contentEnd), 'utf8'));
    const after = serializeWorkbook(workbook);
    return {
      buffer: after,
      affectedRange: allRows.length > 0 && allRows[0].length > 0 ? `A1:${columnNumberToName(allRows[0].length)}${allRows.length}` : null,
      rowCount: allRows.length,
      cellCount: allRows.reduce((sum, row) => sum + row.length, 0),
      insertedRows: allRows.map((_, index) => index + 1),
      updatedRows: [],
      warnings: [],
      verify: (readBack) => {
        const read = parseWorkbook(readBack);
        if (!read.sheets.some((sheet) => sheet.ref.name === request.sheetName && sheet.ref.sheetId === nextSheetId)) fail('Created sheet verification failed', 'verification_failed');
        expectedMatches(readBack, expected);
      },
    };
  }
}

function pathName(value: string): string {
  return value.slice(value.lastIndexOf('/') + 1);
}

function contentTypesXml(sheetParts: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${sheetParts.map((part) => `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
}

function rootRelationshipsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
}

function workbookXml(sheets: Array<{ definition: SpreadsheetSheetDefinition; sheetId: number; relationshipId: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="16000" windowHeight="9000"/></bookViews><sheets>${sheets.map((sheet) => `<sheet name="${xmlEncode(sheet.definition.name)}" sheetId="${sheet.sheetId}" r:id="${sheet.relationshipId}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
}

function workbookRelationshipsXml(sheets: Array<{ partName: string; relationshipId: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((sheet) => `<Relationship Id="${sheet.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${pathName(sheet.partName)}"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="0"/><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

function corePropertiesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>PC File Bridge</dc:creator><cp:lastModifiedBy>PC File Bridge</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified></cp:coreProperties>`;
}

function appPropertiesXml(sheetNames: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>PC File Bridge</Application><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${sheetNames.length}</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="${sheetNames.length}" baseType="lpstr">${sheetNames.map((name) => `<vt:lpstr>${xmlEncode(name)}</vt:lpstr>`).join('')}</vt:vector></TitlesOfParts></Properties>`;
}

function worksheetXml(rows: SpreadsheetCellInput[][], boldHeader: boolean): string {
  const names = DEFAULT_SPREADSHEET_NAMES;
  const rowXml = rows.map((row, rowIndex) => `<${names.element('row')} r="${rowIndex + 1}">${row.map((value, columnIndex) => cellXmlWithNames(cellAddress(rowIndex + 1, columnIndex + 1), value, boldHeader && rowIndex === 0 ? '1' : undefined, names)).join('')}</${names.element('row')}>`).join('');
  const dimension = rows.length > 0 && rows.some((row) => row.length > 0)
    ? `<${names.element('dimension')} ref="A1:${columnNumberToName(Math.max(...rows.map((row) => row.length)))}${rows.length}"/>`
    : `<${names.element('dimension')} ref="A1"/>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${names.element('worksheet')} xmlns="${SPREADSHEETML_NAMESPACE}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${dimension}<${names.element('sheetViews')}><${names.element('sheetView')} workbookViewId="0"/></${names.element('sheetViews')}><${names.element('sheetFormatPr')} defaultRowHeight="15"/><${names.element('sheetData')}>${rowXml}</${names.element('sheetData')}><${names.element('pageMargins')} left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></${names.element('worksheet')}>`;
}
