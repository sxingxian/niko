// Recording one spoken request for a speech-to-text service: the mic is opened, the recording starts once you speak
// and ends after about a second of quiet (or 15 seconds), and the result is a small 16 kHz mono WAV file.
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

export function captureUtterance(opts: { waitMs: number; maxMs?: number; onSpeech?: () => void; onLevel?: (v: number) => void }): Capture {
  const maxMs = opts.maxMs ?? 15_000;
  let stopNow: (keep: boolean) => void = () => undefined;
  const done = new Promise<Blob | null>((resolve) => {
    let ended = false, stream: MediaStream | null = null, ctx: AudioContext | null = null;
    const chunks: Float32Array[] = [];
    let heard = false, lastLoud = 0, floor = 0.01, frames = 0;
    const t0 = performance.now();
    const end = (keep: boolean) => {
      if (ended) return;
      ended = true;
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => undefined);
      resolve(keep && heard && chunks.length ? toWav(chunks, ctx?.sampleRate ?? 48000) : null);
    };
    stopNow = end;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }).then((s) => {
      if (ended) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(s);
      // ScriptProcessor is old but needs no extra script file, which the app's content policy would have to allow.
      const node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (ev) => {
        if (ended) return;
        const data = ev.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
        const rms = Math.sqrt(sum / data.length), now = performance.now();
        opts.onLevel?.(Math.min(1, rms * 8));
        // The first few frames set how loud the room is; speech is well above that.
        if (frames++ < 4) { floor = Math.max(floor, rms); return; }
        const loud = rms > Math.max(0.015, floor * 2.5);
        if (loud) { if (!heard) { heard = true; opts.onSpeech?.(); } lastLoud = now; }
        if (heard) chunks.push(new Float32Array(data));
        else if (!loud) floor = floor * 0.95 + rms * 0.05;
        if (heard && now - lastLoud > 1000) end(true);          // a second of quiet after speaking
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
