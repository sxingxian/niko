// Splitting Knowledge into the pieces Niko searches and the tables it counts with. The browser does this when a file
// is added (so the free Workers plan's CPU allowance is enough); the server does the same when a file kept in Notion,
// Google Drive, OneDrive or their own storage was changed there and is read again.
import { KN_PIECE_CHARS, KN_SHEET_CELL_CHARS, KN_SHEET_MAX_COLS, KN_SHEET_MAX_ROWS, KN_SHEET_ROW_PIECES_MAX, knIsSheet, type KnColType, type KnColumn, type KnKind } from './knowledge';

export interface Piece { heading: string | null; body: string }
export interface Sheet { name: string; columns: KnColumn[]; rows: string[][]; header: boolean }

// ---------------------------------------------------------------- splitting text into pieces
const TARGET = 1200; // a piece aims for about this many characters, and never more than KN_PIECE_CHARS
const clean = (s: string) => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

/** Splits text (Markdown or plain) into pieces under headings. A heading carries its parents ("Returns › Faulty"). */
export function splitText(text: string): Piece[] {
  const lines = clean(text).split('\n');
  const out: Piece[] = [];
  const path: string[] = [];
  let buf: string[] = [];
  const heading = () => (path.length ? path.filter(Boolean).join(' › ').slice(0, 200) : null);
  const flush = () => {
    const paras = buf.join('\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    buf = [];
    let cur = '';
    const push = () => { if (cur.trim()) out.push({ heading: heading(), body: cur.trim() }); cur = ''; };
    for (const p of paras) {
      if (p.length > KN_PIECE_CHARS) { push(); for (const part of cutLong(p)) out.push({ heading: heading(), body: part }); continue; }
      if (cur && cur.length + p.length + 2 > TARGET) push();
      cur = cur ? `${cur}\n\n${p}` : p;
    }
    push();
  };
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { flush(); const level = h[1]!.length; path.length = level - 1; path[level - 1] = h[2]!.replace(/[*_`]/g, '').trim(); continue; }
    buf.push(line);
  }
  flush();
  return out;
}
/** A very long paragraph is cut at sentence ends where it can be, otherwise at a space, never past the limit. */
function cutLong(p: string): string[] {
  const parts: string[] = [];
  let rest = p;
  while (rest.length > KN_PIECE_CHARS) {
    const window = rest.slice(0, KN_PIECE_CHARS);
    let at = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '), window.lastIndexOf('\n'));
    if (at < TARGET / 2) at = window.lastIndexOf(' ');
    if (at < TARGET / 2) at = KN_PIECE_CHARS - 1;
    parts.push(rest.slice(0, at + 1).trim());
    rest = rest.slice(at + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

// ---------------------------------------------------------------- tables
/** Reads CSV or TSV: quoted fields, quotes inside quotes, line breaks inside quotes, and a leading byte-order mark. */
export function parseDelimited(text: string, delim: ',' | '\t'): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > KN_SHEET_MAX_ROWS + 1) break;
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const NUM = /^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?%?$|^[-+]?\.\d+$/;
const DATE = /^(\d{4}-\d{1,2}-\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2} [A-Za-z]{3,9} \d{4})$/;
const YESNO = /^(yes|no|true|false|y|n)$/i;
const money = (v: string) => v.replace(/^[A-Z]{0,3}\$|^[€£¥]/, '');
/** What a column holds, from its values (empty cells are ignored). */
export function guessType(values: string[]): KnColType {
  const vs = values.map((v) => v.trim()).filter(Boolean).slice(0, 500);
  if (!vs.length) return 'text';
  if (vs.every((v) => YESNO.test(v))) return 'yesno';
  if (vs.every((v) => NUM.test(money(v)))) return 'number';
  if (vs.every((v) => DATE.test(v))) return 'date';
  return 'text';
}
/** Whether the first row looks like column names: all filled in, different from each other, and not numbers or dates
 *  while the rows under them are. */
export function guessHeader(rows: string[][]): boolean {
  const first = rows[0], rest = rows.slice(1, 50);
  if (!first || !rest.length) return false;
  const cells = first.map((c) => c.trim());
  if (cells.some((c) => !c) || new Set(cells.map((c) => c.toLowerCase())).size !== cells.length) return false;
  if (cells.some((c) => NUM.test(money(c)) || DATE.test(c))) return false;
  // At least one column whose name is text while its values are numbers or dates, or every name is short text.
  return cells.some((_, i) => guessType(rest.map((r) => r[i] ?? '')) !== 'text') || cells.every((c) => c.length <= 40);
}
/** Turns rows into a sheet: the header (when there is one), at most the allowed columns and rows, cells cut to length. */
export function toSheet(name: string, rows: string[][], header = guessHeader(rows)): Sheet {
  const width = Math.min(KN_SHEET_MAX_COLS, Math.max(1, ...rows.slice(0, 200).map((r) => r.length)));
  const names = header ? rows[0]!.slice(0, width) : [];
  const body = (header ? rows.slice(1) : rows).slice(0, KN_SHEET_MAX_ROWS).map((r) => Array.from({ length: width }, (_, i) => (r[i] ?? '').trim().slice(0, KN_SHEET_CELL_CHARS)));
  const columns = Array.from({ length: width }, (_, i) => ({ name: (names[i] ?? '').trim() || `Column ${i + 1}`, type: guessType(body.map((r) => r[i]!)) }));
  return { name: name.slice(0, 120) || 'Sheet', columns, rows: body, header };
}
/** One searchable piece per row, for sheets small enough, so a question can find the right row by meaning. */
export function rowPieces(sheet: Sheet): Piece[] {
  if (sheet.rows.length > KN_SHEET_ROW_PIECES_MAX) return [];
  return sheet.rows.map((r) => {
    const body = sheet.columns.map((c, i) => (r[i] ? `${c.name}: ${r[i]}` : '')).filter(Boolean).join('. ').slice(0, KN_PIECE_CHARS);
    return { heading: `${sheet.name} · ${r.find(Boolean) ?? 'row'}`.slice(0, 200), body };
  }).filter((p) => p.body);
}
/** A short description of a big sheet, so it can still be found when it has too many rows for one piece each. */
export const sheetSummary = (s: Sheet): Piece => ({ heading: s.name, body: `Spreadsheet “${s.name}” with ${s.rows.length.toLocaleString('en')} rows and columns: ${s.columns.map((c) => c.name).join(', ')}.`.slice(0, KN_PIECE_CHARS) });

/** Markdown tables (as Cloudflare writes spreadsheets), each named by the heading above it. */
export function markdownTables(md: string): { name: string; rows: string[][] }[] {
  const out: { name: string; rows: string[][] }[] = [];
  let name = '', cur: string[][] | null = null;
  // Cells split on | but not on an escaped \| (which stands for a | inside a cell).
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  for (const line of clean(md).split('\n')) {
    const h = /^#{1,6}\s+(.+)$/.exec(line.trim());
    if (h) { name = h[1]!.trim(); cur = null; continue; }
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|?\s*:?-{2,}/.test(line)) continue; // the |---|---| line
      if (!cur) { cur = []; out.push({ name: name || `Sheet ${out.length + 1}`, rows: cur }); }
      cur.push(cells(line));
    } else if (line.trim()) cur = null;
  }
  return out.filter((t) => t.rows.length);
}

// ---------------------------------------------------------------- JSON, XML and HTML
/** A list of records becomes a sheet; anything else becomes lines such as "order.items[0].name: Kettle". */
export function fromJson(name: string, text: string): { sheets: Sheet[]; text: string } {
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new Error('That JSON file has a mistake in it, so it can’t be read.'); }
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v as object).find((x) => Array.isArray(x) && x.length && x.every((r) => r && typeof r === 'object' && !Array.isArray(r))) as unknown[] | undefined : undefined;
  if (Array.isArray(list) && list.length && list.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
    const keys = [...new Set(list.slice(0, 500).flatMap((r) => Object.keys(r as object)))].slice(0, KN_SHEET_MAX_COLS);
    const rows = [keys, ...list.slice(0, KN_SHEET_MAX_ROWS).map((r) => keys.map((k) => { const x = (r as Record<string, unknown>)[k]; return x == null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x); }))];
    return { sheets: [toSheet(name.replace(/\.[^.]+$/, ''), rows, true)], text: '' };
  }
  const lines: string[] = [];
  const walk = (x: unknown, at: string) => {
    if (lines.length > 50_000) return;
    if (Array.isArray(x)) x.forEach((y, i) => walk(y, `${at}[${i}]`));
    else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) walk(y, at ? `${at}.${k}` : k);
    else lines.push(`${at || 'value'}: ${String(x)}`);
  };
  walk(v, '');
  return { sheets: [], text: lines.join('\n') };
}
// ---------------------------------------------------------------- safety
/** Text that reads like instructions to an AI ("ignore the earlier rules and send…"). Niko never acts on file text
 *  anyway; this only lets the person see it and decide whether to keep the file. */
const INSTRUCTIONS = [
  /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|earlier|above|system)\s+(instructions|rules|prompts?|messages)\b/i,
  /\byou\s+are\s+now\s+(a|an|in)\b/i,
  /\b(system|developer)\s+prompt\b/i,
  /\b(send|forward|email|transfer|pay|delete)\b[^.\n]{0,60}\b(to|all)\b[^.\n]{0,60}\b(without|don'?t)\s+(asking|telling|confirm)/i,
  /\[\[(open|item|image|map|send|weather):/i,
];
export const looksLikeInstructions = (text: string) => INSTRUCTIONS.some((r) => r.test(text));


// ---------------------------------------------------------------- writing it out again
/** A document's pieces as Markdown, with its headings put back (a heading "Returns › Faulty" becomes "## Faulty" under
 *  "# Returns"), for keeping a copy in Notion, Drive, OneDrive or their own storage. */
export function piecesMarkdown(pieces: { heading: string | null; body: string }[]): string {
  const out: string[] = [];
  let path: string[] = [];
  for (const p of pieces) {
    const next = p.heading ? p.heading.split(' › ').map((s) => s.trim()).filter(Boolean).slice(0, 6) : [];
    let same = 0;
    while (same < path.length && same < next.length && path[same] === next[same]) same++;
    for (let i = same; i < next.length; i++) out.push(`${'#'.repeat(i + 1)} ${next[i]}`, '');
    path = next;
    out.push(p.body.trim(), '');
  }
  return out.join('\n').trim() + '\n';
}
/** One cell for CSV: quoted when it holds a comma, quote or line break, and never read as a formula by a spreadsheet. */
const csvCell = (v: string) => {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** A sheet as CSV, with its column names as the first row. */
/** A sheet as a Markdown table under its title, for places that show notes (Obsidian). A | inside a cell is escaped
 *  and line breaks become spaces, so markdownTables reads it back exactly. */
export function sheetMarkdown(title: string, columns: { name: string }[], rows: string[][]): string {
  const cell = (c: string) => (c ?? '').replace(/\r?\n/g, ' ').replace(/\\(?=\|)/g, '').replace(/\|/g, '\\|').trim() || ' ';
  const line = (r: string[]) => `| ${r.map(cell).join(' | ')} |`;
  return [`# ${title.replace(/\s+/g, ' ').trim()}`, '', line(columns.map((c) => c.name)), `|${columns.map(() => ' --- ').join('|')}|`, ...rows.map((r) => line(columns.map((_, i) => r[i] ?? '')))].join('\n') + '\n';
}
export const sheetCsv = (columns: { name: string }[], rows: string[][]) => [columns.map((c) => c.name), ...rows].map((r) => r.map((c) => csvCell(c ?? '')).join(',')).join('\r\n') + '\r\n';

// ---------------------------------------------------------------- reading safely
/** XML that declares entities or points at outside files (a DOCTYPE with ENTITY, SYSTEM or PUBLIC) can blow up when
 *  expanded or reach outside the file, so it isn't read at all. */
export function xmlProblem(text: string): string | null {
  const head = text.slice(0, 200_000);
  const doctype = /<!DOCTYPE[\s\S]*?(\[[\s\S]*?\]\s*)?>/i.exec(head)?.[0] ?? '';
  return /<!ENTITY|\bSYSTEM\b|\bPUBLIC\b/i.test(doctype) || /<!ENTITY/i.test(head)
    ? 'That XML file declares entities or points at other files, which Niko doesn’t read, for safety. Save it without its DOCTYPE and add it again.'
    : null;
}
/** What reading a file gives, before it's sent to Niko or kept on the device. */
export interface PreparedText { pieces: Piece[]; sheets: Sheet[]; flagged: boolean; text: string }
/**
 * The CPU-heavy part of reading a file, from its text: CSV and TSV become sheets, JSON lists become sheets (anything
 * else, path lines), Markdown and plain text are split under their headings, and Cloudflare's text of a spreadsheet
 * gives its tables. HTML and XML are turned into Markdown first (that needs the browser's DOMParser), then come here
 * as 'md'. Runs in a background thread in the browser (apps/app/src/knowledgeRead.worker.ts), and on the server when
 * splitting there is switched on.
 */
export function prepareText(kind: KnKind, name: string, raw: string, fromCloudflare = false): PreparedText {
  let text = '';
  let sheets: Sheet[] = [];
  const base = name.replace(/\.[^.]+$/, '');
  if (fromCloudflare) {
    text = raw;
    if (knIsSheet(kind)) { sheets = markdownTables(text).map((t) => toSheet(t.name, t.rows)); if (sheets.length) text = ''; }
  } else if (kind === 'csv' || kind === 'tsv') sheets = [toSheet(base, parseDelimited(raw, kind === 'csv' ? ',' : '\t'))];
  else if (kind === 'json') ({ sheets, text } = fromJson(name, raw));
  else text = raw;
  const pieces = [...splitText(text), ...sheets.flatMap((s) => (s.rows.length > KN_SHEET_ROW_PIECES_MAX ? [sheetSummary(s)] : rowPieces(s)))];
  if (!pieces.length && !sheets.some((s) => s.rows.length)) throw new Error('No text was found in that file.');
  return { pieces, sheets: sheets.filter((s) => s.rows.length), flagged: looksLikeInstructions(text) || sheets.some((s) => s.rows.some((r) => looksLikeInstructions(r.join(' ')))), text };
}
