// Searching files kept on this device: words and, when the search model is here, meaning, merged by rank the same way
// the server does (each list's rank counts, 1 / (60 + rank)), so neither has to be calibrated against the other.
// Pure code with no browser APIs, so it is tested in Node.

/** Words for searching: letters and digits, lower-cased; Chinese, Japanese and Korean text as pairs of characters. */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const m of text.normalize('NFKC').toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0];
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(w)) {
      const chars = [...w];
      if (chars.length === 1) out.push(w);
      for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
    } else if (w.length > 1 || /\p{N}/u.test(w)) out.push(w);
  }
  return out;
}

export interface LocalDoc { id: string; text: string; vector?: number[] | null }
export interface LocalHit { id: string; similarity: number; score: number }

/** An index of pieces kept in memory while the app is open. */
export class LocalIndex {
  private docs: { id: string; tf: Map<string, number>; len: number; vector: number[] | null }[] = [];
  private df = new Map<string, number>();
  private total = 0;
  constructor(docs: LocalDoc[] = []) { for (const d of docs) this.add(d); }
  get size() { return this.docs.length; }
  add(d: LocalDoc) {
    const ws = words(d.text);
    const tf = new Map<string, number>();
    for (const w of ws) tf.set(w, (tf.get(w) ?? 0) + 1);
    for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
    this.docs.push({ id: d.id, tf, len: ws.length, vector: d.vector?.length ? d.vector : null });
    this.total += ws.length;
  }
  /** The best pieces for a question: up to `limit`, with how close the closest meaning was (0 when searched by words). */
  search(query: string, vector: number[] | null, limit = 10): LocalHit[] {
    const n = this.docs.length;
    if (!n) return [];
    const avg = this.total / n || 1;
    const q = [...new Set(words(query))];
    const byWords: { i: number; s: number }[] = [];
    if (q.length) this.docs.forEach((d, i) => {
      let s = 0;
      for (const w of q) {
        const f = d.tf.get(w);
        if (!f) continue;
        const df = this.df.get(w) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        s += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.len / avg))));
      }
      if (s > 0) byWords.push({ i, s });
    });
    byWords.sort((a, b) => b.s - a.s);
    const near: { i: number; s: number }[] = [];
    if (vector) this.docs.forEach((d, i) => { if (d.vector && d.vector.length === vector.length) near.push({ i, s: cosine(vector, d.vector) }); });
    near.sort((a, b) => b.s - a.s);
    const score = new Map<number, number>(), sim = new Map<number, number>();
    byWords.slice(0, 30).forEach((x, r) => score.set(x.i, (score.get(x.i) ?? 0) + 1 / (61 + r)));
    near.slice(0, 30).forEach((x, r) => { score.set(x.i, (score.get(x.i) ?? 0) + 1 / (61 + r)); sim.set(x.i, x.s); });
    return [...score.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit)
      .map(([i, s]) => ({ id: this.docs[i]!.id, similarity: Math.max(0, Math.min(1, sim.get(i) ?? 0)), score: s }));
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
