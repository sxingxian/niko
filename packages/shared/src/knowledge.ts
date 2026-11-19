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
  /** Where files are kept. In Notion, Google Drive, OneDrive or their own storage, Niko keeps a copy of each file there
   *  (its own folder or page) and keeps the search pieces and rows itself, so search and totals work the same. */
  place: KnPlace;
  /** Who reads PDF and Word files, and who makes search numbers. */
  read: 'cloudflare' | 'device';
  search: 'cloudflare' | 'device' | 'own';
  /** With search 'own': which of their own services makes the search numbers (`key:<id>`, one of their AI keys, or
   *  `self-hosted-ai`, their own model server) and the embedding model's name. */
  own: { ref: string; model: string } | null;
  /** Telegram replies can use Knowledge. */
  telegram: boolean;
  /** Reply drafts can use Knowledge (off keeps drafts quick: they read only the message). */
  drafts: boolean;
  /** How many files are kept in Niko, kept here by the server so an account without files never asks Knowledge. */
  files: number;
  /** Learning from how the person uses Niko (once their plan includes it). Off pauses it; what was learned is still used. */
  learn: boolean;
  /** How many learned notes are kept in Niko (server-kept, like `files`). */
  notes: number;
  /** Use the calendar, the time and the location (where allowed for maps) to understand situations; read per question. */
  situations: boolean;
  /** Habits this person said yes to (server-kept, so the app can apply them without asking Knowledge). */
  habits: string[];
  /** Where what Niko learns is kept: in Niko, on their device only, or in Niko with a copy to read in their own app or
   *  storage. Separate from where their files are kept; matches taught for a file stay with that file. */
  learnPlace: KnPlace;
}
/** Where Knowledge can be kept. The last four keep a copy of each file in the person's own app or storage. */
export type KnPlace = 'niko' | 'device' | KnRemotePlace;
export type KnRemotePlace = 'notion' | 'gdrive' | 'onedrive' | 's3';
export const KN_REMOTE_PLACES: KnRemotePlace[] = ['notion', 'gdrive', 'onedrive', 's3'];
export const isRemotePlace = (v: unknown): v is KnRemotePlace => (KN_REMOTE_PLACES as unknown[]).includes(v);
export const KN_PLACE_NAMES: Record<KnPlace, string> = { niko: 'Niko', device: 'This device only', notion: 'Notion', gdrive: 'Google Drive', onedrive: 'OneDrive', s3: 'Your own storage' };
/** The connection each place writes through (their own storage is set up on the Knowledge screen itself). */
export const KN_PLACE_PROVIDER: Record<KnRemotePlace, string> = { notion: 'notion', gdrive: 'google-drive', onedrive: 'onedrive', s3: 'kn-storage' };
export const KN_PREF_DEFAULTS: KnowledgePrefs = { mode: 'files', modes: {}, place: 'niko', read: 'cloudflare', search: 'cloudflare', own: null, telegram: true, drafts: false, files: 0, learn: true, notes: 0, situations: true, habits: [], learnPlace: 'niko' };
/** Their own search numbers: one of their AI keys or their own model server, and an embedding model's name. */
export function cleanOwnSearch(v: unknown): { ref: string; model: string } | null {
  const o = (v && typeof v === 'object' ? v : {}) as { ref?: unknown; model?: unknown };
  const ref = typeof o.ref === 'string' && /^(key:[A-Za-z0-9_-]{1,40}|self-hosted-ai)$/.test(o.ref) ? o.ref : '';
  const model = typeof o.model === 'string' ? o.model.trim().replace(/[^\w.:/@+-]/g, '').slice(0, 100) : '';
  return ref && model ? { ref, model } : null;
}
/** How close (0 to 1) a piece must be, by search numbers from their own key or server, to lead and to be offered.
 *  Embedding models differ, so these are cautious starting points (most score unrelated text under 0.4). */
export const KN_OWN_LEAD = 0.6;
export const KN_OWN_SIMILAR = 0.45;
const isMode = (v: unknown): v is KnMode => v === 'files' || v === 'only' || v === 'off';
/** How Niko answers from one collection. */
export const knModeOf = (p: KnowledgePrefs, collection: string): KnMode => p.modes[collection] ?? p.mode;
export function cleanKnowledgePrefs(v: unknown): KnowledgePrefs {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>, d = KN_PREF_DEFAULTS;
  const modes: Record<string, KnMode> = {};
  if (o.modes && typeof o.modes === 'object') for (const [k, v] of Object.entries(o.modes as Record<string, unknown>).slice(0, 100)) if (isMode(v) && k.trim() && k.length <= 80) modes[k.trim()] = v;
  return {
    mode: isMode(o.mode) ? o.mode : d.mode, modes,
    place: o.place === 'device' || isRemotePlace(o.place) ? o.place : d.place,
    read: o.read === 'device' ? 'device' : d.read,
    search: o.search === 'device' || o.search === 'own' ? o.search : d.search,
    own: cleanOwnSearch(o.own),
    telegram: typeof o.telegram === 'boolean' ? o.telegram : d.telegram,
    drafts: typeof o.drafts === 'boolean' ? o.drafts : d.drafts,
    files: typeof o.files === 'number' && Number.isInteger(o.files) && o.files >= 0 ? o.files : d.files,
    learn: typeof o.learn === 'boolean' ? o.learn : d.learn,
    notes: typeof o.notes === 'number' && Number.isInteger(o.notes) && o.notes >= 0 ? o.notes : d.notes,
    situations: typeof o.situations === 'boolean' ? o.situations : d.situations,
    habits: Array.isArray(o.habits) ? [...new Set(o.habits.filter((h): h is string => h === 'walk-short' || h === 'inbox-morning'))] : [],
    // Before this was a choice, notes were kept with the files: on the device when the files were.
    learnPlace: o.learnPlace === 'niko' || o.learnPlace === 'device' || isRemotePlace(o.learnPlace) ? o.learnPlace : o.place === 'device' ? 'device' : 'niko',
  };
}

/** What one account may use, from its AI options (see AI_OPTION_GROUPS, group "knowledge"). */
export interface KnowledgeAccess { files: boolean; niko: boolean; device: boolean; cloudflareRead: boolean; cloudflareSearch: boolean; learning: boolean; /** Search numbers from one of their AI keys, or their own model server. */ ownKey: boolean; ownServer: boolean;
  /** Keeping a copy of their files in their own Notion, Google Drive, OneDrive or S3 storage (Niko keeps the pieces). */
  notion: boolean; gdrive: boolean; onedrive: boolean; s3: boolean;
  /** Where they may keep what Niko learns, besides Niko itself (only with learning). */
  learnPlaces: Record<'device' | KnRemotePlace, boolean> }
/** Where what Niko learns is kept now: their choice when their plan allows it, else Niko. Notes kept in Niko or with a copy
 *  elsewhere live in Niko's Knowledge database; 'device' notes live only in that browser. */
export const knLearnPlaceOf = (p: Pick<KnowledgePrefs, 'learnPlace'>, a: Pick<KnowledgeAccess, 'learnPlaces'>): KnPlace =>
  p.learnPlace !== 'niko' && a.learnPlaces[p.learnPlace] ? p.learnPlace : 'niko';
export function knowledgeAccess(allowed: (key: string) => boolean): KnowledgeAccess {
  const files = allowed('kn:files'), learning = allowed('kn:learning');
  return { files, niko: files && allowed('kn:place:niko'), device: files && allowed('kn:place:device'),
    cloudflareRead: files && allowed('kn:cf-read'), cloudflareSearch: files && allowed('kn:cf-search'), learning,
    ownKey: files && allowed('kn:search-key'), ownServer: files && allowed('kn:search-server'),
    // The pieces of files kept elsewhere are still kept in Niko, so those places need Niko's database too.
    ...Object.fromEntries(KN_REMOTE_PLACES.map((p) => [p, files && allowed('kn:place:niko') && allowed(`kn:place:${p}`)])) as Record<KnRemotePlace, boolean>,
    learnPlaces: Object.fromEntries((['device', ...KN_REMOTE_PLACES] as const).map((p) => [p, learning && allowed(`kn:learn:${p}`)])) as Record<'device' | KnRemotePlace, boolean> };
}

/** What a sheet column holds, so counts and totals come out right. */
export type KnColType = 'text' | 'number' | 'date' | 'yesno';
export const KN_COL_TYPES: KnColType[] = ['text', 'number', 'date', 'yesno'];
export const KN_COL_TYPE_NAMES: Record<KnColType, string> = { text: 'Text', number: 'Number', date: 'Date', yesno: 'Yes / no' };
export interface KnColumn { name: string; type: KnColType }

// ---------------------------------------------------------------- answering from files
/** How close (0 to 1, from Cloudflare's search numbers) a piece must be for a file to lead the answer, and to be
 *  offered at all. bge-m3 puts unrelated text around 0.3 to 0.45 and a real answer usually above 0.6. */
export const KN_LEAD = 0.62;
export const KN_SIMILAR = 0.48;
/** "From my files", "according to my handbook", "in my Knowledge": the person wants their files only, this once. */
export function askedFromFiles(text: string, collections: string[] = []): boolean {
  if (/\b(from|in|using|according to|based on|check|search|look in)\s+(my|our)\s+(own\s+)?(files?|knowledge|documents?|docs|notes|records|handbook|spreadsheets?|sheets?)\b/i.test(text)) return true;
  const t = text.toLowerCase();
  return collections.some((c) => c.length > 2 && c.toLowerCase() !== 'general' && new RegExp(`\\b(from|in|according to)\\s+(my|our|the)\\s+${c.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t));
}

/** A look-up Niko asks for in a spreadsheet, as [[table:T1|sum|Spend|Active=Yes;Region~north]]. Only these operations
 *  exist, run by Niko's own code; the AI never writes a query itself. */
export type KnTableOp = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'list';
export type KnCmp = '=' | '!=' | '~' | '>' | '<' | '>=' | '<=';
export interface KnTableAsk { table: string; op: KnTableOp; column: string; filters: { column: string; cmp: KnCmp; value: string }[] }
const TABLE_TAG = /\[\[table:(T\d{1,2})\|(count|sum|avg|min|max|list)\|([^|\]\n]{1,120})(?:\|([^\]\n]{0,400}))?\]\]/gi;
export function tableTags(reply: string): KnTableAsk[] {
  const out: KnTableAsk[] = [];
  for (const m of reply.matchAll(TABLE_TAG)) {
    if (out.length >= 3) break;
    const filters = (m[4] ?? '').split(';').map((f) => /^\s*([^=!~<>]{1,120}?)\s*(!=|>=|<=|=|~|>|<)\s*(.{0,200}?)\s*$/.exec(f)).filter((x): x is RegExpExecArray => !!x)
      .slice(0, 5).map((x) => ({ column: x[1]!.trim(), cmp: x[2] as KnCmp, value: x[3]!.trim().replace(/^["']|["']$/g, '') }));
    out.push({ table: m[1]!.toUpperCase(), op: m[2]!.toLowerCase() as KnTableOp, column: m[3]!.trim(), filters });
  }
  return out;
}
export const stripTableTags = (reply: string) => reply.replace(TABLE_TAG, '').trim();
