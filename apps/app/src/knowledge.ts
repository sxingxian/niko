// Knowledge in the browser: reads a file, splits it into the pieces Niko searches, keeps spreadsheets as tables, and
// sends them to the server a few dozen at a time. Splitting happens here so the server stays within the free Workers
// plan's small CPU allowance. PDF, Word and spreadsheet files are first turned into text by Cloudflare (when that is
// allowed and chosen); nothing else leaves this browser except the pieces themselves.
import { api, ApiError } from '@niko/ui';
import {
  KN_PIECE_CHARS, KN_PIECES_PER_CALL, KN_SHEET_CELL_CHARS, KN_SHEET_ROWS_PER_CALL, KN_SHEET_MAX_COLS, KN_SHEET_MAX_ROWS, KN_SHEET_ROW_PIECES_MAX,
  knIsSheet, knKindOf, knNeedsCloudflare, type KnColType, type KnColumn, type KnKind,
} from '@niko/shared';

export interface Piece { heading: string | null; body: string }
export interface Sheet { name: string; columns: KnColumn[]; rows: string[][]; header: boolean }
export interface Prepared { kind: KnKind; pieces: Piece[]; sheets: Sheet[]; flagged: boolean }

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
const sheetSummary = (s: Sheet): Piece => ({ heading: s.name, body: `Spreadsheet “${s.name}” with ${s.rows.length.toLocaleString('en')} rows and columns: ${s.columns.map((c) => c.name).join(', ')}.`.slice(0, KN_PIECE_CHARS) });

/** Markdown tables (as Cloudflare writes spreadsheets), each named by the heading above it. */
export function markdownTables(md: string): { name: string; rows: string[][] }[] {
  const out: { name: string; rows: string[][] }[] = [];
  let name = '', cur: string[][] | null = null;
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim().replace(/\\\|/g, '|'));
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
/** Text from HTML or XML, keeping headings so pieces stay under them. Needs the browser's DOMParser. */
export function fromMarkup(text: string, kind: 'html' | 'xml'): string {
  const doc = new DOMParser().parseFromString(text, kind === 'html' ? 'text/html' : 'application/xml');
  if (kind === 'xml' && doc.querySelector('parsererror')) throw new Error('That XML file has a mistake in it, so it can’t be read.');
  doc.querySelectorAll('script, style, noscript, template').forEach((n) => n.remove());
  const out: string[] = [];
  const walk = (n: Element, depth: number) => {
    const tag = n.tagName.toLowerCase();
    if (kind === 'html' && /^h[1-6]$/.test(tag)) { out.push(`${'#'.repeat(Number(tag[1]))} ${n.textContent?.trim() ?? ''}`, ''); return; }
    const kids = [...n.children];
    if (kind === 'xml' && !kids.length) { const t = n.textContent?.trim(); if (t) out.push(`${tag}: ${t}`); return; }
    if (kind === 'html' && /^(p|li|td|th|dd|dt|blockquote|pre|figcaption)$/.test(tag)) { const t = n.textContent?.replace(/\s+/g, ' ').trim(); if (t) out.push(t, ''); return; }
    if (kind === 'xml' && depth > 0 && kids.length) out.push('', `${'#'.repeat(Math.min(6, depth))} ${tag}`);
    for (const k of kids) walk(k, depth + 1);
  };
  const root = kind === 'html' ? doc.body : doc.documentElement;
  if (root) walk(root, 0);
  return out.join('\n');
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

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- reading a file
/** Reads a file into pieces and sheets. Cloudflare is asked only for PDF, Word and spreadsheet files. */
export async function prepare(file: File, readWithCloudflare: boolean): Promise<Prepared> {
  const kind = knKindOf(file.name);
  if (!kind) throw new Error('Knowledge takes MD, TXT, CSV, TSV, JSON, XML, HTML, PDF, Word (DOCX), Excel (XLSX, XLS) and OpenDocument files.');
  let text = '';
  let sheets: Sheet[] = [];
  const base = file.name.replace(/\.[^.]+$/, '');
  if (knNeedsCloudflare(kind)) {
    if (!readWithCloudflare) throw new Error('PDF, Word and spreadsheet files are read with Cloudflare, which is off. Choose it under “Read files with”, or save the file as CSV, MD or TXT.');
    const res = await fetch(`/api/knowledge/read?name=${encodeURIComponent(file.name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data?.error ?? 'That file couldn’t be read.', res.status, data);
    text = String(data.text ?? '');
    if (knIsSheet(kind)) { sheets = markdownTables(text).map((t) => toSheet(t.name, t.rows)); if (sheets.length) text = ''; }
  } else {
    const raw = await file.text();
    if (kind === 'csv' || kind === 'tsv') sheets = [toSheet(base, parseDelimited(raw, kind === 'csv' ? ',' : '\t'))];
    else if (kind === 'json') ({ sheets, text } = fromJson(file.name, raw));
    else if (kind === 'html' || kind === 'xml') text = fromMarkup(raw, kind);
    else text = raw;
  }
  const pieces = [...splitText(text), ...sheets.flatMap((s) => (s.rows.length > KN_SHEET_ROW_PIECES_MAX ? [sheetSummary(s)] : rowPieces(s)))];
  if (!pieces.length && !sheets.some((s) => s.rows.length)) throw new Error('No text was found in that file.');
  return { kind, pieces, sheets: sheets.filter((s) => s.rows.length), flagged: looksLikeInstructions(text) || sheets.some((s) => s.rows.some((r) => looksLikeInstructions(r.join(' ')))) };
}

/** Adds one file: reads it, starts it on the server, sends its pieces and sheets, and finishes it. If anything fails
 *  part-way, the half-added file is removed so nothing is left behind. */
export async function addFile(file: File, collection: string, opts: { readWithCloudflare: boolean; onStep?: (step: string, done: number, total: number) => void }): Promise<{ id: string; pieces: number }> {
  opts.onStep?.('Reading', 0, 1);
  const prepared = await prepare(file, opts.readWithCloudflare);
  const sha256 = await sha256Hex(await file.arrayBuffer());
  const started = await api<{ id: string }>('/knowledge/files', { method: 'POST', body: { name: file.name, bytes: file.size, sha256, collection, flagged: prepared.flagged } });
  try {
    const total = prepared.pieces.length;
    for (let i = 0; i < total; i += KN_PIECES_PER_CALL) {
      opts.onStep?.('Adding', i, total);
      await api(`/knowledge/files/${started.id}/pieces`, { method: 'POST', body: { start: i, pieces: prepared.pieces.slice(i, i + KN_PIECES_PER_CALL) } });
    }
    for (const s of prepared.sheets) {
      opts.onStep?.('Adding the table', total, total);
      const sh = await api<{ id: string }>(`/knowledge/files/${started.id}/sheets`, { method: 'POST', body: { name: s.name, columns: s.columns, rows: s.rows.slice(0, KN_SHEET_ROWS_PER_CALL), header: s.header } });
      for (let i = KN_SHEET_ROWS_PER_CALL; i < s.rows.length; i += KN_SHEET_ROWS_PER_CALL) {
        opts.onStep?.('Adding the table', i, s.rows.length);
        await api(`/knowledge/files/${started.id}/sheets/${sh.id}/rows`, { method: 'POST', body: { start: i, rows: s.rows.slice(i, i + KN_SHEET_ROWS_PER_CALL) } });
      }
    }
    const done = await api<{ pieces: number }>(`/knowledge/files/${started.id}/done`, { method: 'POST' });
    return { id: started.id, pieces: done.pieces };
  } catch (e) {
    await api(`/knowledge/files/${started.id}`, { method: 'DELETE' }).catch(() => undefined);
    throw e;
  }
}
