// The on-device search model's files, pinned. A file whose fingerprint or size differs is refused rather than run.
// The model and tokenizer are pinned by SHA-256 and exact size; the small settings files must be JSON under a size cap.
// MODEL_SHA256 and TOKENIZER_SHA256 come from Hugging Face's file list for the repository at the revision below
// (https://huggingface.co/api/models/Xenova/multilingual-e5-small/tree/main/onnx and …/tree/main). Until both are
// filled in, "Download to this device" stays unavailable and Knowledge searches by words. (Pinned 2026-11-18.)
export const EMBED_MODEL_ID = 'Xenova/multilingual-e5-small';
const MODEL_SHA256 = 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193';
const MODEL_BYTES = 118_308_185;
const TOKENIZER_SHA256 = '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39';
const TOKENIZER_BYTES = 17_082_730;

export interface EmbedFile { name: string; test: RegExp; sha256: string; bytes: number; json: boolean }
const repo = EMBED_MODEL_ID.replace('/', '\\/');
const at = (path: string) => new RegExp(`^https://huggingface\\.co/${repo}/resolve/main/${path.replace(/[.]/g, '\\.')}(\\?|$)`);
export const EMBED_FILES: EmbedFile[] = [
  { name: 'model', test: at('onnx/model_quantized.onnx'), sha256: MODEL_SHA256, bytes: MODEL_BYTES, json: false },
  { name: 'tokenizer', test: at('tokenizer.json'), sha256: TOKENIZER_SHA256, bytes: TOKENIZER_BYTES, json: false },
  { name: 'config', test: at('config.json'), sha256: '', bytes: 64 * 1024, json: true },
  { name: 'tokenizer settings', test: at('tokenizer_config.json'), sha256: '', bytes: 64 * 1024, json: true },
];
/** True once the model and tokenizer fingerprints are in place. */
export const EMBED_PINNED = !!(MODEL_SHA256 && MODEL_BYTES && TOKENIZER_SHA256 && TOKENIZER_BYTES);
export const embedFileFor = (url: string): EmbedFile | null => EMBED_FILES.find((f) => f.test.test(url)) ?? null;
export const hexOf = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
