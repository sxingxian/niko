// Knowledge: each person's own files, which Niko searches and answers from. Shared by the app, the admin portal and
// the Worker, so the same limits and checks apply everywhere.

/** File types Knowledge takes. The browser reads the text ones itself; the rest need Cloudflare reading. */
export const KN_TEXT_KINDS = ['md', 'txt', 'csv', 'tsv', 'json', 'xml', 'html'] as const;
export const KN_CLOUDFLARE_KINDS = ['pdf', 'docx', 'xlsx', 'xls', 'ods', 'odt'] as const;
export type KnKind = (typeof KN_TEXT_KINDS)[number] | (typeof KN_CLOUDFLARE_KINDS)[number];
const ALIASES: Record<string, KnKind> = { markdown: 'md', text: 'txt', htm: 'html' };
/** The kind of a file from its name, or null when Knowledge can't take it. */
export function knKindOf(name: string): KnKind | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? '';
  const k = (ALIASES[ext] ?? ext) as KnKind;
  return (KN_TEXT_KINDS as readonly string[]).includes(k) || (KN_CLOUDFLARE_KINDS as readonly string[]).includes(k) ? k : null;
}
export const knNeedsCloudflare = (k: KnKind) => (KN_CLOUDFLARE_KINDS as readonly string[]).includes(k);
export const knIsSheet = (k: KnKind) => k === 'csv' || k === 'tsv' || k === 'xlsx' || k === 'xls' || k === 'ods';

/** Sizes the browser splits to and the server checks. */
export const KN_PIECE_CHARS = 2000;        // the most text in one searchable piece
export const KN_PIECES_PER_CALL = 48;      // pieces sent to the server in one request
export const KN_SHEET_MAX_ROWS = 20_000;   // rows kept from one sheet
export const KN_SHEET_MAX_COLS = 60;
export const KN_SHEET_CELL_CHARS = 500;
export const KN_SHEET_ROW_PIECES_MAX = 2000; // sheets up to this many rows also get one searchable piece per row
export const KN_DEVICE_DIMS = 384;         // search numbers made on the device
export const KN_CLOUDFLARE_DIMS = 1024;    // search numbers made by Cloudflare (bge-m3)
export const KN_READ_MAX_BYTES = 10 * 1024 * 1024; // the largest file Cloudflare reading takes

/** How much each account may keep. The admin sets a default and can change it per person. */
export interface KnowledgeLimits { files: number; mbPerFile: number; mbTotal: number }
export const KN_LIMIT_DEFAULTS: KnowledgeLimits = { files: 200, mbPerFile: 10, mbTotal: 100 };
export const KN_FILE_STEPS = [10, 25, 50, 100, 200, 500, 1000];
export const KN_MB_FILE_STEPS = [1, 2, 5, 10];
export const KN_MB_TOTAL_STEPS = [10, 25, 50, 100, 250, 500];
const pick = (v: unknown, steps: number[]) => (typeof v === 'number' && steps.includes(v) ? v : undefined);
export function cleanKnowledgeLimits(v: unknown): Partial<KnowledgeLimits> {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>, out: Partial<KnowledgeLimits> = {};
  const f = pick(o.files, KN_FILE_STEPS), a = pick(o.mbPerFile, KN_MB_FILE_STEPS), t = pick(o.mbTotal, KN_MB_TOTAL_STEPS);
  if (f !== undefined) out.files = f;
  if (a !== undefined) out.mbPerFile = a;
  if (t !== undefined) out.mbTotal = t;
  return out;
}
export const knowledgeLimits = (defaults: Partial<KnowledgeLimits>, own: Partial<KnowledgeLimits>): KnowledgeLimits => ({ ...KN_LIMIT_DEFAULTS, ...defaults, ...own });

/** Admin settings for Knowledge as a whole. Splitting files into pieces happens in the browser on the free Workers
 *  plan; once Workers Paid is on, the admin can move it to the server. */
export interface KnowledgeSettings { split: 'browser' | 'server'; limits: Partial<KnowledgeLimits> }
export function cleanKnowledgeSettings(v: unknown): KnowledgeSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { split: o.split === 'server' ? 'server' : 'browser', limits: cleanKnowledgeLimits(o.limits) };
}

/** Each person's own Knowledge choices (Settings · Knowledge). */
export interface KnowledgePrefs {
  /** files: files first when Niko is sure · only: only when asked "from my files" · off: don't use files. */
  mode: 'files' | 'only' | 'off';
  /** Where new files are kept. */
  place: 'niko' | 'device';
  /** Who reads PDF and Word files, and who makes search numbers. */
  read: 'cloudflare' | 'device';
  search: 'cloudflare' | 'device';
  /** Telegram replies can use Knowledge. */
  telegram: boolean;
}
export const KN_PREF_DEFAULTS: KnowledgePrefs = { mode: 'files', place: 'niko', read: 'cloudflare', search: 'cloudflare', telegram: true };
export function cleanKnowledgePrefs(v: unknown): KnowledgePrefs {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>, d = KN_PREF_DEFAULTS;
  return {
    mode: o.mode === 'only' || o.mode === 'off' ? o.mode : d.mode,
    place: o.place === 'device' ? 'device' : d.place,
    read: o.read === 'device' ? 'device' : d.read,
    search: o.search === 'device' ? 'device' : d.search,
    telegram: typeof o.telegram === 'boolean' ? o.telegram : d.telegram,
  };
}

/** What one account may use, from its AI options (see AI_OPTION_GROUPS, group "knowledge"). */
export interface KnowledgeAccess { files: boolean; niko: boolean; device: boolean; cloudflareRead: boolean; cloudflareSearch: boolean; learning: boolean }
export function knowledgeAccess(allowed: (key: string) => boolean): KnowledgeAccess {
  const files = allowed('kn:files');
  return { files, niko: files && allowed('kn:place:niko'), device: files && allowed('kn:place:device'),
    cloudflareRead: files && allowed('kn:cf-read'), cloudflareSearch: files && allowed('kn:cf-search'), learning: allowed('kn:learning') };
}
