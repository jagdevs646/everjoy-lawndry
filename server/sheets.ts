/*
 * Spreadsheet in and out (register export, import templates, student/staff import).
 * Uses exceljs; the old `xlsx` package on npm has unfixed parsing advisories.
 */
import ExcelJS from 'exceljs';
import { HttpError } from './util.js';

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type SheetSpec = { name: string; header?: string[]; rows: unknown[][]; widths?: number[] };

/**
 * Build an .xlsx file. Every cell is written as a plain value (text, number or date), never as a
 * formula, so a student name like "=HYPERLINK(...)" stays text when the office opens the file.
 */
export async function writeXlsx(sheets: SheetSpec[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    if (s.header) {
      ws.addRow(s.header);
      ws.getRow(1).font = { bold: true };
    }
    for (const r of s.rows) ws.addRow(r.map(safeCell));
    const widths = s.widths ?? (s.header ?? []).map(h => Math.max(10, h.length + 2));
    widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Plain values only: objects (formula, hyperlink) are flattened to text. */
function safeCell(v: unknown) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean' || v instanceof Date) return v;
  return String(v);
}

export type SheetRow = { row: number; cells: Record<string, string> };

/**
 * Read the first sheet of an uploaded .xlsx or .csv into rows keyed by lower-case header.
 * `row` is the row number the admin sees in Excel (blank rows are skipped but keep numbering).
 */
export async function readUpload(buf: Buffer, csv: boolean, maxRows = 5000): Promise<SheetRow[]> {
  const grid = csv ? parseCsv(buf.toString('utf8')) : await readXlsxGrid(buf, maxRows);
  const headerAt = grid.findIndex(g => g.cells.some(c => c.trim()));
  if (headerAt < 0) return [];
  const header = grid[headerAt].cells.map(h => h.trim().toLowerCase());
  const out: SheetRow[] = [];
  for (const g of grid.slice(headerAt + 1)) {
    if (!g.cells.some(c => c.trim())) continue;
    if (out.length >= maxRows) throw new HttpError(400, `Up to ${maxRows} rows per upload. Split the sheet into smaller files.`);
    const cells: Record<string, string> = {};
    header.forEach((h, i) => { if (h && !(h in cells)) cells[h] = (g.cells[i] ?? '').trim(); });
    out.push({ row: g.row, cells });
  }
  return out;
}

type Grid = { row: number; cells: string[] }[];

/**
 * Total unpacked size of a zip, read from its central directory without unpacking anything.
 * Returns null when the file isn't a plain zip (e.g. damaged or ZIP64, which our sheets never need).
 */
export function zipUnpackedSize(buf: Buffer): number | null {
  const min = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const entries = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || at === 0xffffffff) return null;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) return null;
    const size = buf.readUInt32LE(at + 24);
    if (size === 0xffffffff) return null;
    total += size;
    at += 46 + buf.readUInt16LE(at + 28) + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return total;
}

/** 5000 rows of the template unpack to about 2 MB; anything far bigger is not a student list. */
const MAX_UNPACKED = 12 * 1024 * 1024;

async function readXlsxGrid(buf: Buffer, maxRows: number): Promise<Grid> {
  // An .xlsx file is a zip: check the signature so other files get a clear message.
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new HttpError(400, 'That file is not an .xlsx file. In Excel use File → Save As → Excel Workbook (.xlsx), or upload a .csv.');
  // Check the unpacked size first, so a small file that unzips to millions of rows can't fill the server's memory.
  const unpacked = zipUnpackedSize(buf);
  if (unpacked === null) throw new HttpError(400, 'That file could not be read. Use the template from this page.');
  if (unpacked > MAX_UNPACKED) throw new HttpError(400, `This file is too big to import. Up to ${maxRows} rows per upload; split it into smaller files.`);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new HttpError(400, 'That file could not be read. Use the template from this page.');
  }
  const ws = wb.worksheets[0];
  if (!ws) return [];
  if (ws.rowCount > maxRows + 50) throw new HttpError(400, `Up to ${maxRows} rows per upload. Split the sheet into smaller files.`);
  const grid: Grid = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => { if (col <= 200) cells[col - 1] = cellText(cell.value); });
    grid.push({ row: rowNumber, cells: Array.from(cells, c => c ?? '') });
  });
  return grid;
}

/** A cell as text: dates as YYYY-MM-DD, formulas as their last result, rich text joined. */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const d = new Date(v.getTime() + 12 * 3600_000);   // date cells are midnight in some zone: take the nearest day
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'object') {
    const o = v as { result?: unknown; richText?: { text: string }[]; text?: unknown; error?: unknown };
    if ('richText' in o && Array.isArray(o.richText)) return o.richText.map(t => t.text).join('');
    if ('result' in o) return o.result === undefined || o.result === null ? '' : cellText(o.result as ExcelJS.CellValue);
    if ('text' in o) return String(o.text ?? '');
    return '';
  }
  return String(v);
}

/** Small RFC 4180 CSV reader: quoted fields, "" escapes, commas and newlines inside quotes, CRLF. */
export function parseCsv(text: string): Grid {
  const src = text.replace(/^﻿/, '');
  const grid: Grid = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowStart = 1;
  const endRow = () => { row.push(field); grid.push({ row: rowStart, cells: row }); row = []; field = ''; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r') { /* CRLF: handled by \n */ }
    else if (ch === '\n') { endRow(); line++; rowStart = line; }
    else field += ch;
  }
  if (field !== '' || row.length) endRow();
  return grid;
}
