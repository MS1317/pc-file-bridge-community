import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  ReadSpreadsheetRangeResult,
  SpreadsheetInspection,
  SpreadsheetWriteResult,
  UpdateSpreadsheetRangeRequest,
  Workspace,
} from '@bridge/shared';
import { parseSpreadsheetRequest, SPREADSHEET_LIMITS } from '@bridge/shared';
import { AuditLog } from '../auditLog';
import { ChangeService } from '../changeService';
import { PendingStore } from '../pendingStore';
import { hashBuffer } from '../fileHash';
import {
  parseXmlDocument,
  readXlsxPackageEntries,
  SPREADSHEETML_NAMESPACE,
  writeXlsxPackageEntries,
  XlsxSpreadsheetProvider,
  type XmlNode,
} from '../xlsxProvider';
import { SpreadsheetError, SpreadsheetService } from '../spreadsheetService';

function request(action: string, value: Record<string, unknown>) {
  return parseSpreadsheetRequest(action, value);
}

const WORKSHEET_NAMESPACE_TAGS = [
  'worksheet', 'dimension', 'sheetViews', 'sheetView', 'sheetFormatPr', 'sheetData',
  'row', 'c', 'v', 'is', 't', 'f', 'pageMargins',
];
const X14_NAMESPACE = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';

function prefixWorksheet(xml: string): string {
  const withPrefix = xml.replace(
    'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
    'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
  );
  const tags = new RegExp('<(/?)(' + WORKSHEET_NAMESPACE_TAGS.join('|') + ')(?=\\s|/?>)', 'g');
  return withPrefix.replace(tags, '<$1x:$2');
}

function addExtensionContent(xml: string): string {
  return xml.replace(
    '</worksheet>',
    '<extLst><ext uri="{D2F7F5A4-4A4B-4E7E-9A5C-EXTENSION-FIXTURE}"><x14:conditionalFormattings xmlns:x14="' + X14_NAMESPACE + '"><x14:conditionalFormatting sqref="A1"><x14:cfRule type="expression" priority="1"><x14:formula>1=1</x14:formula></x14:cfRule></x14:conditionalFormatting></x14:conditionalFormattings></ext></extLst></worksheet>',
  );
}

function allXmlNodes(node: XmlNode): XmlNode[] {
  return [node, ...node.children.flatMap(allXmlNodes)];
}

describe('SpreadsheetService', () => {
  let root: string;
  let dataDir: string;
  let workspace: Workspace;
  let service: SpreadsheetService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-spreadsheet-workspace-'));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-spreadsheet-data-'));
    workspace = {
      id: 'spreadsheet-ws',
      name: 'Generic Spreadsheet Fixture',
      root,
      allowedGlobs: ['**/*.xlsx'],
      blockedGlobs: [],
      writeMode: 'approval_required',
      createdAt: new Date().toISOString(),
    };
    service = new SpreadsheetService(dataDir, new AuditLog(dataDir));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function run(action: string, value: Record<string, unknown>) {
    return service.execute(workspace, action as never, request(action, value));
  }

  async function createBook(name = 'book.xlsx') {
    return await run('create_spreadsheet', {
      workspaceId: workspace.id,
      relativePath: name,
      sheets: [{
        name: 'Data',
        headers: ['Finding ID', 'Status', 'Amount', 'Active', 'Date', 'Formula'],
        rows: [
          ['QA-001', 'open', 12.5, true, { type: 'date', value: '2026-08-01T00:00:00.000Z' }, { type: 'formula', formula: 'SUM(C2:C2)', cachedValue: 12.5 }],
          ['QA-002', 'closed', 4, false, null, { type: 'formula', formula: 'C3*2', cachedValue: 8 }],
        ],
        boldHeaders: true,
      }],
    }) as SpreadsheetWriteResult;
  }

  it('creates, inspects, reads typed values, and preserves formulas', async () => {
    await createBook();
    const inspected = await run('inspect_spreadsheet', { workspaceId: workspace.id, relativePath: 'book.xlsx' }) as SpreadsheetInspection;
    expect(inspected.format).toBe('xlsx');
    expect(inspected.sheets).toEqual([
      expect.objectContaining({ name: 'Data', usedRange: 'A1:F3', rowCount: 3, columnCount: 6 }),
    ]);

    const read = await run('read_spreadsheet_range', {
      workspaceId: workspace.id,
      relativePath: 'book.xlsx',
      sheetName: 'Data',
      range: 'A1:F3',
    }) as ReadSpreadsheetRangeResult;
    expect(read.rows[1][0].rawValue).toBe('QA-001');
    expect(read.rows[1][2].rawValue).toBe(12.5);
    expect(read.rows[1][3].rawValue).toBe(true);
    expect(read.rows[1][4].valueType).toBe('date');
    expect(read.rows[1][5].formula).toBe('SUM(C2:C2)');
    expect(read.rows[1][5].rawValue).toBe(12.5);

    const beforeHash = inspected.fileHash;
    const updated = await run('update_spreadsheet_range', {
      workspaceId: workspace.id,
      relativePath: 'book.xlsx',
      sheetName: 'Data',
      range: 'B2:B2',
      values: [['resolved']],
      baseHash: beforeHash,
    }) as SpreadsheetWriteResult;
    expect(updated.writeStatus).toEqual({ requested: true, validated: true, written: true, verified: true });
    const after = await run('read_spreadsheet_range', {
      workspaceId: workspace.id,
      relativePath: 'book.xlsx',
      sheetName: 'Data',
      range: 'B2:F2',
    }) as ReadSpreadsheetRangeResult;
    expect(after.rows[0][0].rawValue).toBe('resolved');
    expect(after.rows[0][4].formula).toBe('SUM(C2:C2)');
  });

  it('creates a valid package without an unused theme part', async () => {
    await createBook('generated.xlsx');
    const entries = readXlsxPackageEntries(fs.readFileSync(path.join(root, 'generated.xlsx')));
    expect(entries.has('xl/theme/theme1.xml')).toBe(false);
    expect(entries.get('xl/_rels/workbook.xml.rels')!.toString('utf8')).not.toContain('relationships/theme');
    expect(entries.get('[Content_Types].xml')!.toString('utf8')).not.toContain('/xl/theme/theme1.xml');
    new XlsxSpreadsheetProvider().validate(fs.readFileSync(path.join(root, 'generated.xlsx')));
  });

  it('extends a prefixed worksheet with namespace-safe cells, formulas, and dimensions', async () => {
    await createBook('prefixed.xlsx');
    const workbookPath = path.join(root, 'prefixed.xlsx');
    const entries = readXlsxPackageEntries(fs.readFileSync(workbookPath));
    const sheetPart = 'xl/worksheets/sheet1.xml';
    entries.set(sheetPart, Buffer.from(prefixWorksheet(entries.get(sheetPart)!.toString('utf8')), 'utf8'));
    fs.writeFileSync(workbookPath, writeXlsxPackageEntries(entries));

    const result = await run('update_spreadsheet_range', {
      workspaceId: workspace.id,
      relativePath: 'prefixed.xlsx',
      sheetName: 'Data',
      range: 'M1:N3',
      values: [
        ['QA Status', 'Notes'],
        ['passed', { type: 'formula', formula: 'A2' }],
        ['unchanged', 42],
      ],
    }) as SpreadsheetWriteResult;
    expect(result.writeStatus).toEqual({ requested: true, validated: true, written: true, verified: true });

    const saved = fs.readFileSync(workbookPath);
    const savedEntries = readXlsxPackageEntries(saved);
    const sheetXml = savedEntries.get(sheetPart)!.toString('utf8');
    const sheetRoot = parseXmlDocument(sheetXml, sheetPart);
    const nodes = allXmlNodes(sheetRoot);
    for (const localName of WORKSHEET_NAMESPACE_TAGS) {
      const matches = nodes.filter((node) => node.localName === localName);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.every((node) => node.namespaceURI === SPREADSHEETML_NAMESPACE)).toBe(true);
    }
    const dimension = nodes.find((node) => node.localName === 'dimension');
    expect(dimension?.attributes.find((attribute) => attribute.localName === 'ref')?.value).toBe('A1:N3');
    new XlsxSpreadsheetProvider().validate(saved);

    const read = await run('read_spreadsheet_range', {
      workspaceId: workspace.id,
      relativePath: 'prefixed.xlsx',
      sheetName: 'Data',
      range: 'A2:N3',
    }) as ReadSpreadsheetRangeResult;
    expect(read.rows[0][0].rawValue).toBe('QA-001');
    expect(read.rows[0][12].rawValue).toBe('passed');
    expect(read.rows[1][13].rawValue).toBe(42);
  });

  it('preserves valid extension namespaces through range, append, keyed, and upsert mutations', async () => {
    await createBook('extensions.xlsx');
    const workbookPath = path.join(root, 'extensions.xlsx');
    const entries = readXlsxPackageEntries(fs.readFileSync(workbookPath));
    const sheetPart = 'xl/worksheets/sheet1.xml';
    entries.set(sheetPart, Buffer.from(addExtensionContent(entries.get(sheetPart)!.toString('utf8')), 'utf8'));
    fs.writeFileSync(workbookPath, writeXlsxPackageEntries(entries));

    const assertExtensionSurvives = () => {
      const saved = fs.readFileSync(workbookPath);
      new XlsxSpreadsheetProvider().validate(saved);
      const xml = readXlsxPackageEntries(saved).get(sheetPart)!.toString('utf8');
      expect(xml).toContain('<x14:conditionalFormattings');
      expect(xml).toContain('<x14:conditionalFormatting');
      expect(xml).toContain(X14_NAMESPACE);
    };

    assertExtensionSurvives();
    await run('update_spreadsheet_range', {
      workspaceId: workspace.id,
      relativePath: 'extensions.xlsx',
      sheetName: 'Data',
      range: 'M1:N1',
      values: [['QA Status', 'Notes']],
    });
    assertExtensionSurvives();
    await run('append_spreadsheet_rows', {
      workspaceId: workspace.id,
      relativePath: 'extensions.xlsx',
      sheetName: 'Data',
      rows: [['QA-003', 'open', 1, true, null, null]],
    });
    assertExtensionSurvives();
    await run('update_spreadsheet_rows_by_key', {
      workspaceId: workspace.id,
      relativePath: 'extensions.xlsx',
      sheetName: 'Data',
      keyColumns: ['Finding ID'],
      key: { 'Finding ID': 'QA-003' },
      changes: { Status: 'closed' },
    });
    assertExtensionSurvives();
    await run('upsert_spreadsheet_rows', {
      workspaceId: workspace.id,
      relativePath: 'extensions.xlsx',
      sheetName: 'Data',
      keyColumns: ['Finding ID'],
      rows: [{ 'Finding ID': 'QA-004', Status: 'new', Amount: 4 }],
    });
    assertExtensionSurvives();
  });

  it('preserves unrelated OpenXML package parts, styles, panes, and drawings', async () => {
    await createBook();
    const workbookPath = path.join(root, 'book.xlsx');
    const entries = readXlsxPackageEntries(fs.readFileSync(workbookPath));
    const sheetPart = entries.get('xl/worksheets/sheet1.xml')!.toString('utf8');
    entries.set(
      'xl/worksheets/sheet1.xml',
      Buffer.from(sheetPart.replace(
        '<sheetViews><sheetView workbookViewId="0"/></sheetViews>',
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews>'
      ).replace('<sheetData>', '<cols><col min="1" max="2" width="24" customWidth="1"/></cols><sheetData>')
        .replace('<row r="2">', '<row r="2" s="1" customFormat="1">'), 'utf8')
    );
    const workbookPart = entries.get('xl/workbook.xml')!.toString('utf8');
    entries.set('xl/workbook.xml', Buffer.from(workbookPart.replace(
      '</sheets>',
      '</sheets><definedNames><definedName name="FixtureRange">Data!$A$1</definedName></definedNames>'
    ), 'utf8'));
    const styles = entries.get('xl/styles.xml')!;
    entries.set('xl/styles.xml', Buffer.from(styles.toString('utf8').replace('</styleSheet>', '<extLst><ext uri="fixture-style"/></extLst></styleSheet>'), 'utf8'));
    const preservedParts = new Map<string, Buffer>([
      ['xl/charts/chart1.xml', Buffer.from('<chart fixture="true"/>')],
      ['xl/drawings/drawing1.xml', Buffer.from('<drawing fixture="true"/>')],
      ['xl/media/image1.png', Buffer.from([0, 1, 2, 3])],
      ['xl/worksheets/_rels/sheet1.xml.rels', Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDrawing" Target="../drawings/drawing1.xml"/></Relationships>')],
      ['xl/drawings/_rels/drawing1.xml.rels', Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage" Target="../media/image1.png"/></Relationships>')],
      ['xl/customXml/item1.xml', Buffer.from('<custom fixture="true"/>')],
    ]);
    for (const [name, value] of preservedParts) entries.set(name, value);
    fs.writeFileSync(workbookPath, writeXlsxPackageEntries(entries));

    const beforeParts = readXlsxPackageEntries(fs.readFileSync(workbookPath));
    await run('update_spreadsheet_range', {
      workspaceId: workspace.id,
      relativePath: 'book.xlsx',
      sheetName: 'Data',
      range: 'A2:A2',
      values: [['changed']],
    });
    const afterParts = readXlsxPackageEntries(fs.readFileSync(workbookPath));
    for (const [name, value] of preservedParts) expect(afterParts.get(name)).toEqual(value);
    expect(afterParts.get('xl/styles.xml')).toEqual(beforeParts.get('xl/styles.xml'));
    expect(afterParts.get('xl/worksheets/sheet1.xml')!.toString('utf8')).toContain('state="frozen"');
    expect(afterParts.get('xl/worksheets/sheet1.xml')!.toString('utf8')).toContain('width="24" customWidth="1"');
    expect(afterParts.get('xl/worksheets/sheet1.xml')!.toString('utf8')).toContain('s="1" customFormat="1"');
    expect(afterParts.get('xl/worksheets/sheet1.xml')!.toString('utf8')).toContain('SUM(C2:C2)');
    expect(afterParts.get('xl/workbook.xml')).toEqual(beforeParts.get('xl/workbook.xml'));
  });

  it('canonicalizes backslash, repeated-separator, and dot-segment package names', async () => {
    await createBook('slash-source.xlsx');
    const sourceEntries = readXlsxPackageEntries(fs.readFileSync(path.join(root, 'slash-source.xlsx')));
    const preservedParts = new Map<string, Buffer>([
      ['xl/charts/chart1.xml', Buffer.from('<chart fixture="backslash"/>')],
      ['xl/drawings/drawing1.xml', Buffer.from('<drawing fixture="backslash"/>')],
      ['xl/customXml/item1.xml', Buffer.from('<custom fixture="backslash"/>')],
    ]);
    for (const [name, value] of preservedParts) sourceEntries.set(name, value);

    const rawEntries = new Map<string, Buffer>();
    for (const [name, value] of sourceEntries) {
      let rawName = name.replace(/\//g, '\\');
      if (name === 'xl/workbook.xml') rawName = String.raw`xl\.\workbook.xml`;
      if (name === 'xl/worksheets/sheet1.xml') rawName = String.raw`xl\\worksheets\.\sheet1.xml`;
      rawEntries.set(rawName, value);
    }
    const rawBuffer = writeXlsxPackageEntries(rawEntries);
    expect(rawBuffer.includes(Buffer.from(String.raw`xl\.\workbook.xml`))).toBe(true);
    fs.writeFileSync(path.join(root, 'backslash.xlsx'), rawBuffer);

    const inspected = await run('inspect_spreadsheet', {
      workspaceId: workspace.id,
      relativePath: 'backslash.xlsx',
    }) as SpreadsheetInspection;
    expect(inspected.sheets.map((sheet) => sheet.name)).toEqual(['Data']);

    const read = await run('read_spreadsheet_range', {
      workspaceId: workspace.id,
      relativePath: 'backslash.xlsx',
      sheetName: 'Data',
      range: 'A1:F3',
    }) as ReadSpreadsheetRangeResult;
    expect(read.rows[2][0].rawValue).toBe('QA-002');

    const search = await run('search_spreadsheet', {
      workspaceId: workspace.id,
      relativePath: 'backslash.xlsx',
      sheetName: 'Data',
      column: 'Finding ID',
      query: 'QA-002',
      match: 'exact',
    }) as { matches: Array<{ address: string }>; truncated: boolean };
    expect(search.matches.map((match) => match.address)).toEqual(['A3']);
    expect(search.truncated).toBe(false);

    const appended = await run('append_spreadsheet_rows', {
      workspaceId: workspace.id,
      relativePath: 'backslash.xlsx',
      sheetName: 'Data',
      rows: [['QA-003', 'open', 2, true, null, null]],
    }) as SpreadsheetWriteResult;
    expect(appended.affectedRange).toBe('A4:F4');

    const updated = await run('update_spreadsheet_rows_by_key', {
      workspaceId: workspace.id,
      relativePath: 'backslash.xlsx',
      sheetName: 'Data',
      keyColumns: ['Finding ID'],
      key: { 'Finding ID': 'QA-003' },
      changes: { Status: 'verified' },
    }) as SpreadsheetWriteResult;
    expect(updated.updatedRows).toEqual([4]);

    const after = await run('read_spreadsheet_range', {
      workspaceId: workspace.id,
      relativePath: 'backslash.xlsx',
      sheetName: 'Data',
      range: 'A4:B4',
    }) as ReadSpreadsheetRangeResult;
    expect(after.rows[0].map((cell) => cell.rawValue)).toEqual(['QA-003', 'verified']);

    const provider = new XlsxSpreadsheetProvider();
    const saved = fs.readFileSync(path.join(root, 'backslash.xlsx'));
    provider.validate(saved);
    const savedEntries = readXlsxPackageEntries(saved);
    for (const [name, value] of preservedParts) expect(savedEntries.get(name)).toEqual(value);
    expect([...savedEntries.keys()].some((name) => name.includes('\\'))).toBe(false);
  });

  it('rejects canonical package collisions and unsafe archive paths', async () => {
    await createBook('archive-source.xlsx');
    const entries = readXlsxPackageEntries(fs.readFileSync(path.join(root, 'archive-source.xlsx')));
    const provider = new XlsxSpreadsheetProvider();

    const invalidPackages = [
      (() => {
        const collision = new Map(entries);
        collision.set(String.raw`xl\workbook.xml`, entries.get('xl/workbook.xml')!);
        return collision;
      })(),
      (() => {
        const traversal = new Map(entries);
        traversal.set('../outside.xml', Buffer.from('unsafe'));
        return traversal;
      })(),
      (() => {
        const absolute = new Map(entries);
        absolute.set('/outside.xml', Buffer.from('unsafe'));
        return absolute;
      })(),
    ];

    for (const invalid of invalidPackages) {
      try {
        provider.validate(writeXlsxPackageEntries(invalid));
        throw new Error('expected invalid XLSX package');
      } catch (error) {
        expect(error).toMatchObject({ kind: 'workbook_invalid' });
      }
    }
  });

  it('appends after dynamic used rows and handles empty/header-only sheets', async () => {
    await createBook();
    const result = await run('append_spreadsheet_rows', {
      workspaceId: workspace.id,
      relativePath: 'book.xlsx',
      sheetName: 'Data',
      rows: [['QA-003', 'open', 9, true, null, null]],
    }) as SpreadsheetWriteResult;
    expect(result.affectedRange).toBe('A4:F4');
    expect(result.insertedRows).toEqual([4]);

    await run('create_spreadsheet', {
      workspaceId: workspace.id,
      relativePath: 'empty.xlsx',
      sheets: [{ name: 'Empty' }],
    });
    const empty = await run('append_spreadsheet_rows', {
      workspaceId: workspace.id,
      relativePath: 'empty.xlsx',
      sheetName: 'Empty',
      rows: [{ Name: 'first', Count: 1 }],
    }) as SpreadsheetWriteResult;
    expect(empty.insertedRows).toEqual([2]);
    const emptyRead = await run('read_spreadsheet_range', {
      workspaceId: workspace.id,
      relativePath: 'empty.xlsx',
      sheetName: 'Empty',
      range: 'A1:B2',
    }) as ReadSpreadsheetRangeResult;
    expect(emptyRead.rows.map((row) => row.map((cell) => cell.rawValue))).toEqual([
      ['Name', 'Count'],
      ['first', 1],
    ]);
  });

  it('searches typed values and adds a worksheet without changing existing sheets', async () => {
    await createBook();
    const search = await run('search_spreadsheet', {
      workspaceId: workspace.id,
      relativePath: 'book.xlsx',
      sheetName: 'Data',
      column: 'Finding ID',
      query: 'QA-002',
      match: 'exact',
    }) as { matches: Array<{ address: string; sheetName: string }>; truncated: boolean };
    expect(search.matches).toEqual([{ sheetName: 'Data', sheetId: 1, address: 'A3', row: 3, column: 1, cell: expect.any(Object) }]);
    expect(search.truncated).toBe(false);

    const added = await run('create_spreadsheet_sheet', {
      workspaceId: workspace.id,
      relativePath: 'book.xlsx',
      sheetName: 'Notes',
      headers: ['Note'],
      rows: [['kept']],
    }) as SpreadsheetWriteResult;
    expect(added.operation).toBe('create_sheet');
    const relationships = readXlsxPackageEntries(fs.readFileSync(path.join(root, 'book.xlsx')))
      .get('xl/_rels/workbook.xml.rels')!.toString('utf8');
    expect(relationships).toContain('Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"');
    expect(relationships).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"');
    const inspected = await run('inspect_spreadsheet', { workspaceId: workspace.id, relativePath: 'book.xlsx' }) as SpreadsheetInspection;
    expect(inspected.sheets.map((sheet) => sheet.name)).toEqual(['Data', 'Notes']);
  });

  it('updates by generic key, upserts existing/missing rows, and types duplicates', async () => {
    await createBook('keys.xlsx');
    const updated = await run('update_spreadsheet_rows_by_key', {
      workspaceId: workspace.id,
      relativePath: 'keys.xlsx',
      sheetName: 'Data',
      keyColumns: ['Finding ID'],
      key: { 'Finding ID': 'QA-001' },
      changes: { Status: 'done' },
    }) as SpreadsheetWriteResult;
    expect(updated.updatedRows).toEqual([2]);

    const upserted = await run('upsert_spreadsheet_rows', {
      workspaceId: workspace.id,
      relativePath: 'keys.xlsx',
      sheetName: 'Data',
      keyColumns: ['Finding ID'],
      rows: [
        { 'Finding ID': 'QA-001', Status: 'verified' },
        { 'Finding ID': 'QA-003', Status: 'new', Amount: 3 },
      ],
    }) as SpreadsheetWriteResult;
    expect(upserted.updatedRows).toEqual([2]);
    expect(upserted.insertedRows).toEqual([4]);

    await run('create_spreadsheet', {
      workspaceId: workspace.id,
      relativePath: 'duplicates.xlsx',
      sheets: [{ name: 'Data', headers: ['ID', 'Value'], rows: [['same', 1], ['same', 2]] }],
    });
    await expect(run('update_spreadsheet_rows_by_key', {
      workspaceId: workspace.id,
      relativePath: 'duplicates.xlsx',
      sheetName: 'Data',
      keyColumns: ['ID'],
      key: { ID: 'same' },
      changes: { Value: 99 },
    })).rejects.toMatchObject({ kind: 'duplicate_key' });
  });

  it('rejects stale hashes, invalid inputs, and unsupported formats', async () => {
    await createBook();
    const inspected = await run('inspect_spreadsheet', { workspaceId: workspace.id, relativePath: 'book.xlsx' }) as SpreadsheetInspection;
    await run('update_spreadsheet_range', {
      workspaceId: workspace.id,
      relativePath: 'book.xlsx',
      sheetName: 'Data',
      range: 'B2:B2',
      values: [['changed']],
    });
    await expect(run('update_spreadsheet_range', {
      workspaceId: workspace.id,
      relativePath: 'book.xlsx',
      sheetName: 'Data',
      range: 'B2:B2',
      values: [['stale']],
      baseHash: inspected.fileHash,
    })).rejects.toMatchObject({ kind: 'concurrent_modification' });

    await expect(run('read_spreadsheet_range', {
      workspaceId: workspace.id,
      relativePath: 'book.xlsx',
      sheetName: 'Missing',
      range: 'A1:A1',
    })).rejects.toMatchObject({ kind: 'sheet_not_found' });
    expect(() => request('read_spreadsheet_range', {
      workspaceId: workspace.id,
      relativePath: 'book.xlsx',
      sheetName: 'Data',
      range: 'B2:A1',
    })).toThrow(/Invalid spreadsheet range/);
    await expect(run('update_spreadsheet_range', {
      workspaceId: workspace.id,
      relativePath: 'book.xlsx',
      sheetName: 'Data',
      range: 'A1:B2',
      values: [['too', 'short']],
    })).rejects.toMatchObject({ kind: 'invalid_row_shape' });
    await expect(run('inspect_spreadsheet', {
      workspaceId: workspace.id,
      relativePath: 'book.xls',
    })).rejects.toMatchObject({ kind: 'unsupported_spreadsheet_format' });
    await expect(run('inspect_spreadsheet', {
      workspaceId: workspace.id,
      relativePath: 'missing.xlsx',
    })).rejects.toMatchObject({ kind: 'spreadsheet_file_not_found' });
    await expect(run('read_spreadsheet_range', {
      workspaceId: workspace.id,
      relativePath: 'book.xlsx',
      sheetName: 'Data',
      range: 'A1:K1000',
    })).rejects.toMatchObject({ kind: 'result_too_large' });

    fs.writeFileSync(path.join(root, 'corrupt.xlsx'), Buffer.from('not an xlsx'));
    await expect(run('inspect_spreadsheet', {
      workspaceId: workspace.id,
      relativePath: 'corrupt.xlsx',
    })).rejects.toMatchObject({ kind: 'workbook_invalid' });
    await expect(run('inspect_spreadsheet', {
      workspaceId: workspace.id,
      relativePath: '../outside.xlsx',
    })).rejects.toMatchObject({ kind: 'permission_denied' });
    await expect(run('inspect_spreadsheet', {
      workspaceId: workspace.id,
      relativePath: path.join(root, 'book.xlsx'),
    })).rejects.toMatchObject({ kind: 'permission_denied' });
    fs.writeFileSync(path.join(root, 'too-large.xlsx'), Buffer.alloc(SPREADSHEET_LIMITS.maxWorkbookBytes + 1));
    await expect(run('inspect_spreadsheet', {
      workspaceId: workspace.id,
      relativePath: 'too-large.xlsx',
    })).rejects.toMatchObject({ kind: 'workbook_too_large' });
  });

  it('rejects a malformed but readable candidate before replacement and preserves bytes', async () => {
    await createBook('structural.xlsx');
    const workbookPath = path.join(root, 'structural.xlsx');
    const initialEntries = readXlsxPackageEntries(fs.readFileSync(workbookPath));
    const sheetPart = 'xl/worksheets/sheet1.xml';
    initialEntries.set(sheetPart, Buffer.from(prefixWorksheet(initialEntries.get(sheetPart)!.toString('utf8')), 'utf8'));
    fs.writeFileSync(workbookPath, writeXlsxPackageEntries(initialEntries));
    const before = fs.readFileSync(workbookPath);
    const updateRequest = request('update_spreadsheet_range', {
      workspaceId: workspace.id,
      relativePath: 'structural.xlsx',
      sheetName: 'Data',
      range: 'M1:M1',
      values: [['readable but invalid']],
    }) as UpdateSpreadsheetRangeRequest;

    const provider = new XlsxSpreadsheetProvider();
    const cleanPlan = provider.updateRange(before, updateRequest);
    const malformedEntries = readXlsxPackageEntries(cleanPlan.buffer);
    const malformedSheet = malformedEntries.get(sheetPart)!.toString('utf8').replace('<x:dimension', '<dimension');
    malformedEntries.set(sheetPart, Buffer.from(malformedSheet, 'utf8'));
    const malformed = writeXlsxPackageEntries(malformedEntries);
    expect(() => cleanPlan.verify(malformed)).not.toThrow();
    expect(() => provider.validate(malformed)).toThrow();
    for (const localName of ['dimension', 'sheetData', 'row', 'c']) {
      const entries = readXlsxPackageEntries(cleanPlan.buffer);
      const sheet = entries.get(sheetPart)!.toString('utf8')
        .replace(`<x:${localName}`, `<${localName}`)
        .replace(`</x:${localName}>`, `</${localName}>`);
      entries.set(sheetPart, Buffer.from(sheet, 'utf8'));
      expect(() => provider.validate(writeXlsxPackageEntries(entries))).toThrow();
    }

    const failingProvider = new XlsxSpreadsheetProvider();
    const originalUpdate = failingProvider.updateRange.bind(failingProvider);
    failingProvider.updateRange = (buffer, parsedRequest) => {
      const plan = originalUpdate(buffer, parsedRequest);
      const entries = readXlsxPackageEntries(plan.buffer);
      const sheet = entries.get(sheetPart)!.toString('utf8').replace('<x:dimension', '<dimension');
      entries.set(sheetPart, Buffer.from(sheet, 'utf8'));
      return { ...plan, buffer: writeXlsxPackageEntries(entries) };
    };
    const failingService = new SpreadsheetService(dataDir, new AuditLog(dataDir), failingProvider);
    await expect(failingService.execute(workspace, 'update_spreadsheet_range', updateRequest)).rejects.toMatchObject({
      kind: 'workbook_invalid',
      diagnostics: expect.stringContaining('destinationReplaced=false'),
    });
    expect(fs.readFileSync(workbookPath)).toEqual(before);
    expect(hashBuffer(fs.readFileSync(workbookPath))).toBe(hashBuffer(before));
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('restores the original after verification failure and supports generic audit/revert', async () => {
    await createBook('atomic.xlsx');
    const workbookPath = path.join(root, 'atomic.xlsx');
    const before = fs.readFileSync(workbookPath);
    const failingProvider = new XlsxSpreadsheetProvider();
    const originalAppend = failingProvider.appendRows.bind(failingProvider);
    failingProvider.appendRows = (buffer, request) => {
      const plan = originalAppend(buffer, request);
      return { ...plan, verify: () => { throw new SpreadsheetError('verification_failed', 'fixture verification failure'); } };
    };
    const failingService = new SpreadsheetService(dataDir, new AuditLog(dataDir), failingProvider);
    await expect(failingService.execute(workspace, 'append_spreadsheet_rows', request('append_spreadsheet_rows', {
      workspaceId: workspace.id,
      relativePath: 'atomic.xlsx',
      sheetName: 'Data',
      rows: [['will', 'rollback', 0, false, null, null]],
    }))).rejects.toMatchObject({ kind: 'verification_failed' });
    expect(fs.readFileSync(workbookPath)).toEqual(before);
    expect(fs.readdirSync(path.join(dataDir, 'backups')).length).toBeGreaterThanOrEqual(2);

    const applied = await run('update_spreadsheet_range', {
      workspaceId: workspace.id,
      relativePath: 'atomic.xlsx',
      sheetName: 'Data',
      range: 'B2:B2',
      values: [['temporary']],
    }) as SpreadsheetWriteResult;
    const audit = new AuditLog(dataDir).readRecent(1)[0];
    expect(audit).toMatchObject({
      id: applied.auditId,
      action: 'spreadsheet',
      relativePath: 'atomic.xlsx',
      operation: 'update_range',
      operationSummary: { affectedRange: 'B2:B2', rowCount: 1, cellCount: 1 },
    });
    expect(JSON.stringify(audit)).not.toContain('temporary');
    const reverted = new ChangeService(dataDir, new AuditLog(dataDir), new PendingStore()).revert(workspace, applied.auditId);
    expect(reverted.success).toBe(true);
    expect(hashBuffer(fs.readFileSync(workbookPath))).toBe(applied.beforeHash);
  });
});
