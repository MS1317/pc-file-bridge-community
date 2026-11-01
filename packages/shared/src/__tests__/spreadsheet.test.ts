import {
  cellAddress,
  columnNameToNumber,
  columnNumberToName,
  isSpreadsheetActionName,
  normalizeSpreadsheetRange,
  parseSpreadsheetRange,
  parseSpreadsheetRequest,
  spreadsheetFormatForPath,
  spreadsheetRangeToString,
  validateSpreadsheetSheetName,
} from '../spreadsheet';

describe('spreadsheet shared contracts', () => {
  it('recognizes only xlsx paths, without depending on filename case', () => {
    expect(spreadsheetFormatForPath('reports/Q1.XLSX')).toBe('xlsx');
    expect(spreadsheetFormatForPath('reports/Q1.xls')).toBeNull();
    expect(spreadsheetFormatForPath('reports/Q1.xlsx/notes.txt')).toBeNull();
  });

  it('converts column names, numbers, and cell addresses', () => {
    expect(columnNameToNumber('A')).toBe(1);
    expect(columnNameToNumber('Z')).toBe(26);
    expect(columnNameToNumber('AA')).toBe(27);
    expect(columnNumberToName(1)).toBe('A');
    expect(columnNumberToName(27)).toBe('AA');
    expect(cellAddress(12, 28)).toBe('AB12');
    expect(() => columnNameToNumber('A1')).toThrow();
    expect(() => columnNumberToName(0)).toThrow();
  });

  it('parses and normalizes single cells and ranges', () => {
    expect(parseSpreadsheetRange('b2:d5')).toEqual({ startRow: 2, startColumn: 2, endRow: 5, endColumn: 4 });
    expect(spreadsheetRangeToString(parseSpreadsheetRange('B2:D5'))).toBe('B2:D5');
    expect(normalizeSpreadsheetRange({ range: 'b2:d5' }))
      .toEqual({ startRow: 2, startColumn: 2, endRow: 5, endColumn: 4 });
    expect(() => parseSpreadsheetRange('A0:B1')).toThrow();
    expect(() => parseSpreadsheetRange('A1:B2:C3')).toThrow();
  });

  it('validates worksheet names against Excel naming limits', () => {
    expect(validateSpreadsheetSheetName('Quarter 1')).toBe('Quarter 1');
    expect(() => validateSpreadsheetSheetName('')).toThrow();
    expect(() => validateSpreadsheetSheetName('bad/name')).toThrow();
    expect(() => validateSpreadsheetSheetName('x'.repeat(32))).toThrow();
  });

  it('recognizes supported actions and rejects unknown actions', () => {
    expect(isSpreadsheetActionName('inspect_spreadsheet')).toBe(true);
    expect(isSpreadsheetActionName('delete_workbook')).toBe(false);
    expect(() => parseSpreadsheetRequest('delete_workbook', {})).toThrow();
  });

  it('normalizes requests for read and write actions', () => {
    expect(parseSpreadsheetRequest('inspect_spreadsheet', { workspaceId: 'ws-1', relativePath: 'book.xlsx' }))
      .toEqual(expect.objectContaining({ workspaceId: 'ws-1', relativePath: 'book.xlsx' }));
    expect(parseSpreadsheetRequest('read_spreadsheet_range', {
      workspaceId: 'ws-1', relativePath: 'book.xlsx', sheetName: 'Sheet 1', range: 'A1:B2',
    })).toEqual(expect.objectContaining({
      workspaceId: 'ws-1',
      range: 'A1:B2',
      valueMode: 'both',
    }));
    expect(parseSpreadsheetRequest('append_spreadsheet_rows', {
      workspaceId: 'ws-1', relativePath: 'book.xlsx', sheetName: 'Sheet 1', rows: [{ Name: 'Ada' }],
    })).toEqual(expect.objectContaining({ workspaceId: 'ws-1', rows: [{ Name: 'Ada' }] }));
    expect(parseSpreadsheetRequest('read_spreadsheet_range', {
      workspaceId: 'ws-1', relativePath: 'book.xls', sheetName: 'Sheet 1', range: 'A1:B2',
    })).toEqual(expect.objectContaining({ relativePath: 'book.xls' }));
    expect(spreadsheetFormatForPath('book.xls')).toBeNull();
  });
});
