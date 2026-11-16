// WebCrypto helpers: tokens, hashing, AES-GCM for stored secrets, TOTP. (Password hashing lives in password.ts and runs in Postgres.)

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
  return btoa(s);
}
export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---- AES-GCM for connection credentials and TOTP secrets
async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = unb64(secret);
  if (raw.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(secret: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(JSON.stringify(value)));
  return `v1.${b64(iv)}.${b64(ct)}`;
}
export async function unseal<T>(secret: string, sealed: string | null): Promise<T | null> {
  if (!sealed) return null;
  const [v, iv, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !ct) return null;
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(secret), unb64(ct));
  return JSON.parse(dec.decode(pt)) as T;
}

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30 s)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function b32decode(s: string): Uint8Array {
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v >= 0) bits += v.toString(2).padStart(5, '0');
  }
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}
async function totpAt(secret: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', b32decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new ArrayBuffer(8);
  new DataView(msg).setUint32(4, counter);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[19]! & 0xf;
  const code = (((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000;
  return code.toString().padStart(6, '0');
}
/** Returns the time step the code matches (current, previous or next), or null. The caller must refuse a step it has already accepted. */
export async function totpStep(secret: string, code: string): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(Date.now() / 30_000);
  let hit: number | null = null;
  for (const d of [0, -1, 1]) if (safeEqual(await totpAt(secret, step + d), code)) hit = step + d;
  return hit;
}

// ---- recovery codes: 10 single-use codes, xxxxx-xxxxx, stored only as SHA-256
const HUMAN = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/l/i
function humanChars(n: number): string {
  let out = '';
  while (out.length < n) {
    // Rejection sampling: no modulo bias.
    for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) if (b < 248 && out.length < n) out += HUMAN[b % HUMAN.length];
  }
  return out;
}
export function makeRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => `${humanChars(5)}-${humanChars(5)}`);
}
export async function hashRecoveryCode(code: string): Promise<string> {
  return sha256(`niko/recovery/v1\u0000${code.toLowerCase().replace(/[^a-z0-9]/g, '')}`);
}

export function totpUri(secret: string, email: string): string {
  return `otpauth://totp/Niko%20Admin:${encodeURIComponent(email)}?secret=${secret}&issuer=Niko%20Admin&digits=6&period=30`;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Random characters from an alphabet, without modulo bias (for invite and email codes). */
export function randomChars(alphabet: string, n: number): string {
  let out = '';
  const limit = 256 - (256 % alphabet.length);
  while (out.length < n) for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) if (b < limit && out.length < n) out += alphabet[b % alphabet.length];
  return out;
}
