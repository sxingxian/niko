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
export const KN_SHEET_ROWS_PER_CALL = 1000; // rows sent to the server in one request
export const KN_SHEET_ROW_PIECES_MAX = 2000; // sheets up to this many rows also get one searchable piece per row
export const KN_DEVICE_DIMS = 384;         // search numbers made on the device
export const KN_CLOUDFLARE_DIMS = 1024;    // search numbers made by Cloudflare (bge-m3)
export const KN_READ_MAX_BYTES = 10 * 1024 * 1024; // the largest file Cloudflare reading takes
/** Storage in one Neon Free plan project (1 GB since October 2026; https://neon.com/faqs/free-plan-limits-and-quotas).
 *  Knowledge has its own project, so this is what the admin's database bar measures against. */
export const KN_DB_FREE_BYTES = 1024 ** 3;

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
export type KnMode = 'files' | 'only' | 'off';
export interface KnowledgePrefs {
  /** How Niko answers from each collection. files: files first when Niko is sure · only: only when asked "from my
   *  files" · off: don't use it. A collection without its own choice uses `mode`. */
  mode: KnMode;
  modes: Record<string, KnMode>;
  /** Where new files are kept. */
  place: 'niko' | 'device';
  /** Who reads PDF and Word files, and who makes search numbers. */
  read: 'cloudflare' | 'device';
  search: 'cloudflare' | 'device';
  /** Telegram replies can use Knowledge. */
  telegram: boolean;
  /** Reply drafts can use Knowledge (off keeps drafts quick: they read only the message). */
  drafts: boolean;
}
export const KN_PREF_DEFAULTS: KnowledgePrefs = { mode: 'files', modes: {}, place: 'niko', read: 'cloudflare', search: 'cloudflare', telegram: true, drafts: false };
const isMode = (v: unknown): v is KnMode => v === 'files' || v === 'only' || v === 'off';
/** How Niko answers from one collection. */
export const knModeOf = (p: KnowledgePrefs, collection: string): KnMode => p.modes[collection] ?? p.mode;
export function cleanKnowledgePrefs(v: unknown): KnowledgePrefs {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>, d = KN_PREF_DEFAULTS;
  const modes: Record<string, KnMode> = {};
  if (o.modes && typeof o.modes === 'object') for (const [k, v] of Object.entries(o.modes as Record<string, unknown>).slice(0, 100)) if (isMode(v) && k.trim() && k.length <= 80) modes[k.trim()] = v;
  return {
    mode: isMode(o.mode) ? o.mode : d.mode, modes,
    place: o.place === 'device' ? 'device' : d.place,
    read: o.read === 'device' ? 'device' : d.read,
    search: o.search === 'device' ? 'device' : d.search,
    telegram: typeof o.telegram === 'boolean' ? o.telegram : d.telegram,
    drafts: typeof o.drafts === 'boolean' ? o.drafts : d.drafts,
  };
}

/** What one account may use, from its AI options (see AI_OPTION_GROUPS, group "knowledge"). */
export interface KnowledgeAccess { files: boolean; niko: boolean; device: boolean; cloudflareRead: boolean; cloudflareSearch: boolean; learning: boolean }
export function knowledgeAccess(allowed: (key: string) => boolean): KnowledgeAccess {
  const files = allowed('kn:files');
  return { files, niko: files && allowed('kn:place:niko'), device: files && allowed('kn:place:device'),
    cloudflareRead: files && allowed('kn:cf-read'), cloudflareSearch: files && allowed('kn:cf-search'), learning: allowed('kn:learning') };
}

/** What a sheet column holds, so counts and totals come out right. */
export type KnColType = 'text' | 'number' | 'date' | 'yesno';
export const KN_COL_TYPES: KnColType[] = ['text', 'number', 'date', 'yesno'];
export const KN_COL_TYPE_NAMES: Record<KnColType, string> = { text: 'Text', number: 'Number', date: 'Date', yesno: 'Yes / no' };
export interface KnColumn { name: string; type: KnColType }
