// Knowledge in the browser: reads a file, splits it into the pieces Niko searches, keeps spreadsheets as tables, and
// sends them to the server a few dozen at a time. Splitting happens here so the server stays within the free Workers
// plan's small CPU allowance. PDF, Word and spreadsheet files are first turned into text by Cloudflare (when that is
// allowed and chosen); nothing else leaves this browser except the pieces themselves.
import { api, ApiError } from '@niko/ui';
import { embedReady, embedTexts } from './embed';
import {
  KN_PIECE_CHARS, KN_PIECES_PER_CALL, KN_SHEET_CELL_CHARS, KN_SHEET_ROWS_PER_CALL, KN_SHEET_MAX_COLS, KN_SHEET_MAX_ROWS, KN_SHEET_ROW_PIECES_MAX,
  knIsSheet, knKindOf, knNeedsCloudflare, type KnColType, type KnColumn, type KnKind,
} from '@niko/shared';

export {
  splitText, parseDelimited, guessType, guessHeader, toSheet, rowPieces, sheetSummary, markdownTables, fromJson, looksLikeInstructions,
  type Piece, type Sheet,
} from '@niko/shared';
import { prepareText, xmlProblem, type Piece, type PreparedText, type Sheet } from '@niko/shared';
export interface Prepared { kind: KnKind; pieces: Piece[]; sheets: Sheet[]; flagged: boolean }

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

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- reading a file
/** How long reading one file may take in the background thread before it's stopped. */
const READ_TIME_MS = 60_000;
/** The heavy part of reading runs in a background thread with a time limit, so a huge or hostile file can't freeze
 *  the page. Where workers aren't available (tests), it runs here. */
function prepareInWorker(kind: KnKind, name: string, text: string, fromCloudflare: boolean): Promise<PreparedText> {
  if (typeof Worker === 'undefined') return Promise.resolve(prepareText(kind, name, text, fromCloudflare));
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./knowledgeRead.worker.ts', import.meta.url), { type: 'module' });
    const stop = setTimeout(() => { w.terminate(); reject(new Error('That file took too long to read. Try a smaller file, or split it into parts.')); }, READ_TIME_MS);
    w.onmessage = (e: MessageEvent<{ ok: true; out: PreparedText } | { ok: false; error: string }>) => {
      clearTimeout(stop); w.terminate();
      if (e.data.ok) resolve(e.data.out); else reject(new Error(e.data.error));
    };
    w.onerror = () => { clearTimeout(stop); w.terminate(); reject(new Error('That file couldn’t be read.')); };
    w.postMessage({ kind, name, text, fromCloudflare });
  });
}

/** A file's text, ready to split: Cloudflare reads PDF, Word and spreadsheets; HTML and XML become Markdown here. */
async function readText(file: File, readWithCloudflare: boolean): Promise<{ kind: KnKind; as: KnKind; text: string; fromCloudflare: boolean }> {
  const kind = knKindOf(file.name);
  if (!kind) throw new Error('Knowledge takes MD, TXT, CSV, TSV, JSON, XML, HTML, PDF, Word (DOCX), Excel (XLSX, XLS) and OpenDocument files.');
  let text: string, fromCloudflare = false, as: KnKind = kind;
  if (knNeedsCloudflare(kind)) {
    if (!readWithCloudflare) throw new Error('PDF, Word and spreadsheet files are read with Cloudflare, which is off. Choose it under “Read files with”, or save the file as CSV, MD or TXT.');
    const res = await fetch(`/api/knowledge/read?name=${encodeURIComponent(file.name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data?.error ?? 'That file couldn’t be read.', res.status, data);
    text = String(data.text ?? ''); fromCloudflare = true;
  } else {
    text = await file.text();
    if (kind === 'xml') { const p = xmlProblem(text); if (p) throw new Error(p); }
    // HTML and XML need the page's DOMParser, so they become Markdown here and are split in the background.
    if (kind === 'html' || kind === 'xml') { text = fromMarkup(text, kind); as = 'md'; }
  }
  return { kind, as, text, fromCloudflare };
}
/** Reads a file into pieces and sheets. Cloudflare is asked only for PDF, Word and spreadsheet files. */
export async function prepare(file: File, readWithCloudflare: boolean): Promise<Prepared> {
  const r = await readText(file, readWithCloudflare);
  const out = await prepareInWorker(r.as, file.name, r.text, r.fromCloudflare);
  return { kind: r.kind, pieces: out.pieces, sheets: out.sheets, flagged: out.flagged };
}

/** Adds one file: reads it, starts it on the server, sends its pieces and sheets, and finishes it. If anything fails
 *  part-way, the half-added file is removed so nothing is left behind. */
export async function addFile(file: File, collection: string, opts: { readWithCloudflare: boolean; serverSplit?: boolean; onStep?: (step: string, done: number, total: number) => void }): Promise<{ id: string; pieces: number }> {
  opts.onStep?.('Reading', 0, 1);
  // Splitting on Niko's server (switched on by the admin): the text goes in one request and Niko splits it.
  if (opts.serverSplit) {
    const r = await readText(file, opts.readWithCloudflare);
    const sha = await sha256Hex(await file.arrayBuffer());
    const made = await api<{ id: string }>('/knowledge/files', { method: 'POST', body: { name: file.name, bytes: file.size, sha256: sha, collection, flagged: false } });
    try {
      opts.onStep?.('Adding', 0, 1);
      await api(`/knowledge/files/${made.id}/text`, { method: 'POST', body: { kind: r.as, text: r.text, fromCloudflare: r.fromCloudflare } });
      const done = await api<{ pieces: number }>(`/knowledge/files/${made.id}/done`, { method: 'POST' });
      return { id: made.id, pieces: done.pieces };
    } catch (e) {
      await api(`/knowledge/files/${made.id}`, { method: 'DELETE' }).catch(() => undefined);
      throw e;
    }
  }
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

/** Makes this device's search numbers for a file kept in Niko (after choosing "On this device" for search), a page of
 *  pieces at a time: the pieces' text comes from Niko, the numbers are made here and sent back. */
export async function addNumbersInNiko(fileId: string, onBatch?: (done: number) => void): Promise<void> {
  if (!embedReady()) throw new Error('Download the search model to this device first.');
  for (let start: number | null = 0; start !== null;) {
    const page: { pieces: { ord: number; heading: string | null; body: string }[]; next: number | null } = await api(`/knowledge/files/${fileId}/pieces?start=${start}`);
    for (let i = 0; i < page.pieces.length; i += KN_PIECES_PER_CALL) {
      const batch = page.pieces.slice(i, i + KN_PIECES_PER_CALL);
      const vectors = await embedTexts(batch.map((p) => (p.heading ? `${p.heading}\n${p.body}` : p.body)), 'passage');
      if (!vectors) throw new Error('The search model stopped. Try again.');
      // Pieces are numbered without gaps, so each batch starts at its first piece's number.
      await api(`/knowledge/files/${fileId}/numbers`, { method: 'PUT', body: { start: batch[0]!.ord, vectors } });
      onBatch?.(batch.length);
    }
    start = page.next;
  }
}
