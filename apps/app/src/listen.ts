// Recording one spoken request for a speech-to-text service: the mic is opened, the recording starts once you speak
// and ends after a short pause (or 15 seconds), and the result is a small 16 kHz mono WAV file.
// Nothing is kept: the recording goes to Niko's server once, and from there straight to the service.

export interface Capture {
  /** The recording, or null when nothing was said in time (or it was stopped). */
  done: Promise<Blob | null>;
  /** Ends it now: what was said so far is kept if there was speech, else nothing. */
  finish(): void;
  /** Throws it away. */
  cancel(): void;
}

const RATE = 16000;

export function captureSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== 'undefined';
}

/**
 * Deciding when someone starts and stops talking, from how loud each short frame is (RMS, 0–1). Kept separate so it
 * can be tested. Built for phones and tablets, whose mics record quietly and are often further away:
 * - the room's level is the quietest moment of the last 1.5 seconds, so speaking straight away (after a tap, or right
 *   after saying "Niko") isn't mistaken for background noise;
 * - the bar to start is low in a quiet room and rises in a noisy one; a single click or tap doesn't count;
 * - once talking, a lower bar keeps it going, so quieter words and short pauses don't end it;
 * - it ends after a longer quiet, and the moment before speech is kept, so the first word isn't cut off.
 */
export interface Vad { push(rms: number, ms: number): 'wait' | 'start' | 'talk' | 'end' | 'noise' }
export const VAD = { MIN_START: 0.006, MAX_START: 0.06, FLOOR_MIN: 0.0015, FLOOR_MAX: 0.025, START_X: 3, KEEP_X: 1.8, QUIET_MS: 1300, PRE_MS: 800, ROOM_MS: 1500, WARM_MS: 250 } as const;
export function createVad(): Vad {
  let floor: number = VAD.FLOOR_MAX, talking = false, loudMs = 0, lastLoud = 0, peak = 0, t = 0;
  const recent: number[] = [];
  const startBar = () => Math.min(VAD.MAX_START, Math.max(VAD.MIN_START, floor * VAD.START_X));
  const keepBar = () => Math.max(VAD.MIN_START * 0.6, Math.min(startBar(), floor * VAD.KEEP_X));
  return {
    push(rms, ms) {
      t += ms;
      // The first quarter second is the mic settling (often near silent): not the room. (It is still recorded.)
      if (t <= VAD.WARM_MS) return 'wait';
      // The room is the quietest moment of the last 1.5 seconds, kept up to date even while recording. Speech always
      // dips between syllables and steady noise doesn't, so this finds the room whether or not someone is talking.
      // (Slices of about 20 ms see those dips, which longer ones average away.)
      recent.push(rms);
      if (recent.length > Math.max(3, Math.round(VAD.ROOM_MS / ms))) recent.shift();
      floor = Math.min(VAD.FLOOR_MAX, Math.max(VAD.FLOOR_MIN, Math.min(...recent)));
      if (!talking) {
        // About 150 ms of voice (or 60 ms of clearly loud voice) to start, so a tap or a click doesn't count.
        loudMs = rms > startBar() ? loudMs + ms : 0;
        if (loudMs >= 150 || (loudMs >= 60 && rms > startBar() * 2.5)) { talking = true; lastLoud = t; peak = rms; return 'start'; }
        return 'wait';
      }
      peak = Math.max(peak, rms);
      if (rms > keepBar()) lastLoud = t;
      if (t - lastLoud <= VAD.QUIET_MS) return 'talk';
      // Never clearly above the room: a fan or traffic, not someone talking. Nothing is sent.
      return peak > floor * VAD.START_X ? 'end' : 'noise';
    },
  };
}

export function captureUtterance(opts: { waitMs: number; maxMs?: number; onSpeech?: () => void; onLevel?: (v: number) => void }): Capture {
  const maxMs = opts.maxMs ?? 15_000;
  let stopNow: (keep: boolean) => void = () => undefined;
  // Made and resumed now, while the tap that started listening still counts: Safari (iPhone, iPad) otherwise keeps
  // an audio engine made later paused, and nothing is heard.
  let ctx: AudioContext | null = null;
  try { ctx = new AudioContext(); void ctx.resume().catch(() => undefined); } catch { ctx = null; }
  const done = new Promise<Blob | null>((resolve) => {
    let ended = false, stream: MediaStream | null = null;
    const chunks: Float32Array[] = [], before: Float32Array[] = [];
    let heard = false;
    const vad = createVad();
    const t0 = performance.now();
    const end = (keep: boolean) => {
      if (ended) return;
      ended = true;
      stream?.getTracks().forEach((t) => t.stop());
      const rate = ctx?.sampleRate ?? 48000;
      void ctx?.close().catch(() => undefined);
      resolve(keep && heard && chunks.length ? toWav(chunks, rate) : null);
    };
    stopNow = end;
    if (!ctx) { end(false); return; }
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }).then((s) => {
      if (ended || !ctx) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      void ctx.resume().catch(() => undefined);
      const src = ctx.createMediaStreamSource(s);
      // ScriptProcessor is old but needs no extra script file, which the app's content policy would have to allow.
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const frameMs = (4096 / ctx.sampleRate) * 1000, SLICES = 4, SLICE = 4096 / SLICES;
      const preFrames = Math.ceil(VAD.PRE_MS / frameMs);
      node.onaudioprocess = (ev) => {
        if (ended) return;
        const data = new Float32Array(ev.inputBuffer.getChannelData(0));
        const now = performance.now();
        // Loudness is judged in short slices, so the dips between syllables show.
        let v: ReturnType<Vad['push']> = 'wait', top = 0;
        for (let k = 0; k < SLICES; k++) {
          let sum = 0;
          for (let i = k * SLICE; i < (k + 1) * SLICE; i++) sum += data[i]! * data[i]!;
          const rms = Math.sqrt(sum / SLICE);
          top = Math.max(top, rms);
          const r = vad.push(rms, frameMs / SLICES);
          if (r === 'start' || ((r === 'end' || r === 'noise') && v !== 'start')) v = r; else if (v === 'wait') v = r;
        }
        opts.onLevel?.(Math.min(1, top * 12));
        if (v === 'start') { heard = true; chunks.push(...before); before.length = 0; opts.onSpeech?.(); }
        if (heard) chunks.push(data);
        else { before.push(data); if (before.length > preFrames) before.shift(); }
        if (v === 'end') end(true);                              // a pause after speaking
        else if (v === 'noise') end(false);                      // only background noise
        else if (!heard && now - t0 > opts.waitMs) end(false);  // nothing said in time
        else if (now - t0 > maxMs) end(true);
      };
      src.connect(node); node.connect(ctx.destination);
    }).catch(() => end(false));
  });
  return { done, finish: () => stopNow(true), cancel: () => stopNow(false) };
}

/** Joins the recorded frames, brings them down to 16 kHz, and wraps them as a 16-bit WAV file. */
function toWav(chunks: Float32Array[], rate: number): Blob {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  // A quiet recording (a phone at arm's length, a tablet on a stand) is brought up to a clear level, up to 8×, so the
  // speech-to-text service hears it as well as a close one.
  let peak = 0;
  for (let i = 0; i < total; i++) { const x = Math.abs(all[i]!); if (x > peak) peak = x; }
  const gain = peak > 0 ? Math.min(8, 0.9 / peak) : 1;
  if (gain > 1.05) for (let i = 0; i < total; i++) all[i]! *= gain;
  const ratio = rate / RATE, n = Math.floor(total / ratio);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    // Averaging over each step is a simple low-pass, so the lower rate does not alias.
    const a = Math.floor(i * ratio), b = Math.min(total, Math.floor((i + 1) * ratio));
    let s = 0; for (let j = a; j < b; j++) s += all[j]!;
    const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.byteLength), dv = new DataView(buf);
  const str = (off: number, t: string) => { for (let i = 0; i < t.length; i++) dv.setUint8(off + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, RATE, true); dv.setUint32(28, RATE * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

/** Sends a recording to Niko's server to be turned into text. `source`/`key` try one service (the Test button). */
export async function transcribe(wav: Blob, extra: { source?: string; key?: unknown; server?: unknown } = {}): Promise<{ text: string; used: string }> {
  const form = new FormData();
  form.set('audio', wav, 'speech.wav');
  form.set('lang', (navigator.language || 'en').replace(/[^A-Za-z-]/g, '').slice(0, 10));
  if (extra.source) form.set('source', extra.source);
  if (extra.key) form.set('key', JSON.stringify(extra.key));
  if (extra.server) form.set('server', JSON.stringify(extra.server));
  const res = await fetch('/api/voice/stt', { method: 'POST', credentials: 'same-origin', body: form });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error ?? 'That could not be heard.'), { usedUp: !!j.usedUp });
  return { text: String(j.text ?? ''), used: String(j.used ?? '') };
}
