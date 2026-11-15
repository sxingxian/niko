// The Niko particle core and colour engine, ported from the approved mockup (I · Adaptive Core).
// One shared hue drifts between the user's chosen colours; the particles, glow and accents all read it.
import { COLOURS, type Appearance } from '@niko/shared';

export type CoreMode = 'idle' | 'listening' | 'speaking';

const hueState = { value: 190, appearance: null as Appearance | null, running: false, t0: 0 };

function targetHue(a: Appearance | null, t: number): number {
  if (!a) return 190;
  const hueOf = (name: string) => (name === 'custom' ? a.customHue : COLOURS[name] ?? 190);
  if (a.mode === 'single') return hueOf(a.single);
  const list = a.colours.length ? a.colours : ['cyan'];
  return hueOf(list[Math.floor(t / Math.max(4, a.seconds || 8)) % list.length]!);
}

/** Sets the colours to drift between and starts the shared hue loop (idempotent). */
export function setAppearance(a: Appearance | null) {
  hueState.appearance = a;
  if (hueState.running || typeof window === 'undefined') return;
  hueState.running = true;
  hueState.t0 = performance.now();
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const tick = (now: number) => {
    const t = Math.max(0, ((now || performance.now()) - hueState.t0) / 1000);
    const goal = targetHue(hueState.appearance, t);
    if (!(hueState.value >= 0)) hueState.value = 190;
    const d = ((goal - hueState.value + 540) % 360) - 180;
    hueState.value = (hueState.value + d * (still ? 1 : 0.006) + 360) % 360;
    document.documentElement.style.setProperty('--h', hueState.value.toFixed(1));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
export const currentHue = () => hueState.value;

export interface CoreHandle { stop(): void; setMode(m: CoreMode): void; setShift(px: number): void }

/** Where each core and ring is on screen, for the transition that carries particles between screens. */
export const spots = new Map<string, HTMLElement>();
/** A sphere's screen centre and radius, from the canvas it is drawn on (the sphere is 0.29 of the canvas height). */
export function sphereOf(el: HTMLElement | undefined | null): { x: number; y: number; R: number } | null {
  if (!el || !el.isConnected) return null;
  const b = el.getBoundingClientRect();
  if (!b.width || !b.height) return null;
  return { x: b.left + b.width / 2, y: b.top + b.height / 2, R: b.height * 0.29 };
}

/** Starts drawing the particle sphere on a canvas. Returns a handle to change its state or stop it. */
export function startCore(canvas: HTMLCanvasElement, opts: { particles?: number; mode?: CoreMode } = {}): CoreHandle {
  const N = opts.particles ?? 1200;
  let mode: CoreMode = opts.mode ?? 'idle';
  const rnd = Math.random;
  const pts: { x: number; y: number; z: number; f1: number; f2: number; f3: number; fr: number; p1: number; p2: number; p3: number; pr: number; jit: number; arc: number }[] = [];
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N, r = Math.sqrt(1 - y * y), a = i * 2.399963, j = 0.9 + rnd() * 0.2;
    pts.push({
      x: Math.cos(a) * r * j, y: y * j, z: Math.sin(a) * r * j,
      f1: 0.12 + rnd() * 0.45, f2: 0.12 + rnd() * 0.45, f3: 0.12 + rnd() * 0.45, fr: 0.1 + rnd() * 0.4,
      p1: rnd() * 6.283, p2: rnd() * 6.283, p3: rnd() * 6.283, pr: rnd() * 6.283,
      jit: rnd() * 0.12, arc: (rnd() - 0.5) * 50,
    });
  }
  const links: number[] = [];
  for (let i = 0; i + 34 < N; i += 4) { links.push(i, i + 21); if (i % 8 === 0) links.push(i, i + 34); }
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const px = new Float32Array(N), py = new Float32Array(N), pd = new Float32Array(N);
  const ctx = canvas.getContext('2d')!;
  let W = 0, H = 0, dpr = 1, rot = 0.6, amp = 0, raf = 0, alive = true;
  // Moving aside: each particle drifts on its own arc, the leading side first, so the sphere flows rather than slides.
  const SHIFT_S = 1.0, STAGGER = 0.35;
  let shiftFrom = 0, shiftTo = 0, shiftAt = -1e9;
  const smooth = (v: number) => v * v * v * (v * (v * 6 - 15) + 10);
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const t0 = performance.now();

  const frame = (now: number) => {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    const t = still ? 0 : Math.max(0, ((now || performance.now()) - t0) / 1000);
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const wantDpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cw !== W || ch !== H || wantDpr !== dpr) { W = cw; H = ch; dpr = wantDpr; canvas.width = Math.max(1, W * dpr); canvas.height = Math.max(1, H * dpr); }
    if (!W || !H) return;
    const S = H; // the sphere is sized by the height; a wider canvas leaves room to drift sideways
    const sinceShift = (now - shiftAt) / 1000, dir = Math.sign(shiftTo - shiftFrom) || 1;
    const hue = currentHue();
    const target = mode === 'speaking' ? 0.45 + 0.45 * Math.abs(Math.sin(t * 3.1) * Math.sin(t * 1.3) + 0.3 * Math.sin(t * 5.2)) : mode === 'listening' ? 0.2 : 0.05;
    amp += (target - amp) * 0.05;
    if (!still) rot += mode === 'speaking' ? 0.0035 : mode === 'listening' ? 0.002 : 0.001;
    const tilt = 0.38 + 0.18 * Math.sin(t * 0.07);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    const c = Math.cos(rot), s = Math.sin(rot), ct = Math.cos(tilt), st = Math.sin(tilt), R = S * 0.29;
    let cx = 0;
    const k = 0.035 + amp * 0.13;
    for (let i = 0; i < N; i++) {
      const p = pts[i]!, w = 1 + amp * 0.08 * Math.sin(t * p.fr + p.pr);
      const x = p.x * w + k * Math.sin(t * p.f1 + p.p1), y = p.y * w + k * Math.sin(t * p.f2 + p.p2), z = p.z * w + k * Math.sin(t * p.f3 + p.p3);
      const x1 = x * c + z * s, z1 = z * c - x * s, y2 = y * ct - z1 * st, z2 = y * st + z1 * ct;
      const f = 2.6 / (2.6 - z2);
      let dx = shiftTo, dy = 0;
      if (!still && sinceShift < SHIFT_S + STAGGER + 0.2) {
        const lead = ((1 - dir * x1) / 2) * STAGGER + p.jit;
        const e = smooth(clamp01((sinceShift - lead) / SHIFT_S));
        dx = shiftFrom + (shiftTo - shiftFrom) * e; dy = Math.sin(Math.PI * e) * p.arc;
      }
      px[i] = W / 2 + dx + x1 * R * f; py[i] = H / 2 + dy + y2 * R * f; pd[i] = (z2 + 1.3) / 2.6;
      cx += px[i]!;
    }
    cx /= N;
    const col = (l: number, a: number) => `hsla(${hue.toFixed(1)},90%,${l}%,${a.toFixed(3)})`;
    const g = ctx.createRadialGradient(cx, H / 2, 0, cx, H / 2, R * 1.3);
    g.addColorStop(0, col(60, 0.1 + amp * 0.2)); g.addColorStop(1, col(60, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = col(70, 0.1 + amp * 0.14);
    ctx.lineWidth = 0.6; ctx.beginPath();
    for (let q = 0; q < links.length; q += 2) { const a1 = links[q]!, b1 = links[q + 1]!; if (Math.abs(px[a1]! - px[b1]!) > R * 0.6) continue; ctx.moveTo(px[a1]!, py[a1]!); ctx.lineTo(px[b1]!, py[b1]!); }
    ctx.stroke();
    for (let i = 0; i < N; i++) {
      const d = Math.max(0, Math.min(1, pd[i]!)), z = (0.7 + 1.6 * d) * (1 + amp * 0.4);
      ctx.fillStyle = col(74, 0.2 + 0.8 * d);
      ctx.fillRect(px[i]! - z / 2, py[i]! - z / 2, z, z);
    }
  };
  raf = requestAnimationFrame(frame);
  return {
    stop() { alive = false; cancelAnimationFrame(raf); },
    setMode(m) { mode = m; },
    setShift(v) {
      if (v === shiftTo) return;
      // Start from where the particles are now (approximately), so a quick open-then-close never jumps.
      const since = (performance.now() - shiftAt) / 1000;
      const done = since >= SHIFT_S + STAGGER;
      shiftFrom = done ? shiftTo : shiftFrom + (shiftTo - shiftFrom) * smooth(clamp01(since / (SHIFT_S + STAGGER)));
      shiftTo = v; shiftAt = performance.now();
    },
  };
}
