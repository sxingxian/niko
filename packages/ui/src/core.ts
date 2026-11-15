// The Niko particle core, its ring and the colour engine. One shared hue drifts between the user's chosen colours;
// the particles, glow and accents all read it. Each state has its own motion. Standing by breathes; Listening draws ripples inward to the centre; Thinking pulls in,
// wrings back and forth, and sends sparks orbiting with signals along the links; Replying swells with the
// voice and sends ripples outward. States blend into each other over about half a second.
import { COLOURS, type Appearance } from '@niko/shared';

export type CoreMode = 'idle' | 'listening' | 'thinking' | 'speaking';

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

export interface CoreHandle {
  stop(): void;
  setMode(m: CoreMode): void;
  setShift(px: number): void;
  /** Loudness 0–1 of the voice being heard or spoken, when the app can measure it; null uses a natural rhythm. */
  setLevel(v: number | null): void;
  /** What the core is doing right now, so a ring around it can move in step. */
  state(): CoreState;
}
export interface CoreState { w: Record<CoreMode, number>; level: number; t: number }

export const spots = new Map<string, HTMLElement>();
export function sphereOf(el: HTMLElement | undefined | null): { x: number; y: number; R: number } | null {
  if (!el || !el.isConnected) return null;
  const b = el.getBoundingClientRect();
  if (!b.width || !b.height) return null;
  return { x: b.left + b.width / 2, y: b.top + b.height / 2, R: b.height * 0.29 };
}

const MODES: CoreMode[] = ['idle', 'listening', 'thinking', 'speaking'];

/** A speech-like loudness: syllables inside words, with short pauses between words. */
function voice(t: number, seed: number) {
  const syll = Math.max(0, Math.sin(t * 7.3 + seed)) ** 2 * (0.55 + 0.45 * Math.sin(t * 1.7 + seed * 2));
  const word = Math.sin(t * 0.95 + seed) > -0.35 ? 1 : 0.1;
  return Math.min(1, syll * word + 0.08);
}

export function startCore(canvas: HTMLCanvasElement, opts: { particles?: number; mode?: CoreMode } = {}): CoreHandle {
  const N = opts.particles ?? 1200;
  let mode: CoreMode = opts.mode ?? 'idle';
  const rnd = Math.random;
  const pts: { x: number; y: number; z: number; f1: number; f2: number; f3: number; p1: number; p2: number; p3: number; jit: number; arc: number }[] = [];
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N, r = Math.sqrt(1 - y * y), a = i * 2.399963, j = 0.9 + rnd() * 0.2;
    pts.push({
      x: Math.cos(a) * r * j, y: y * j, z: Math.sin(a) * r * j,
      f1: 0.12 + rnd() * 0.45, f2: 0.12 + rnd() * 0.45, f3: 0.12 + rnd() * 0.45,
      p1: rnd() * 6.283, p2: rnd() * 6.283, p3: rnd() * 6.283,
      jit: rnd() * 0.12, arc: (rnd() - 0.5) * 50,
    });
  }
  const links: number[] = [];
  for (let i = 0; i + 34 < N; i += 4) { links.push(i, i + 21); if (i % 8 === 0) links.push(i, i + 34); }
  // Thinking: a few bright sparks, each on its own great circle around the sphere.
  const SPARKS = 14, TRAIL = 12;
  const sparks = Array.from({ length: SPARKS }, () => {
    const ax = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5], al = Math.hypot(ax[0]!, ax[1]!, ax[2]!) || 1;
    const n = ax.map((v) => v / al);
    const tmp = Math.abs(n[0]!) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = [n[1]! * tmp[2]! - n[2]! * tmp[1]!, n[2]! * tmp[0]! - n[0]! * tmp[2]!, n[0]! * tmp[1]! - n[1]! * tmp[0]!];
    const ul = Math.hypot(u[0]!, u[1]!, u[2]!);
    const uu = u.map((v) => v / ul), v = [n[1]! * uu[2]! - n[2]! * uu[1]!, n[2]! * uu[0]! - n[0]! * uu[2]!, n[0]! * uu[1]! - n[1]! * uu[0]!];
    return { u: uu, v, a: rnd() * 6.283, sp: (1.3 + rnd() * 1.1) * (rnd() < 0.5 ? -1 : 1), r: 1.02 + rnd() * 0.06 };
  });
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const px = new Float32Array(N), py = new Float32Array(N), pd = new Float32Array(N), pb = new Float32Array(N);
  const ctx = canvas.getContext('2d')!;
  let W = 0, H = 0, dpr = 1, rot = 0.6, raf = 0, alive = true, last = performance.now(), t = 0;
  let level: number | null = null, lv = 0;
  const w: Record<CoreMode, number> = { idle: 0, listening: 0, thinking: 0, speaking: 0 };
  w[mode] = 1;
  const SHIFT_S = 1.0, STAGGER = 0.35;
  let shiftFrom = 0, shiftTo = 0, shiftAt = -1e9;
  const smooth = (v: number) => v * v * v * (v * (v * 6 - 15) + 10);
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

  const frame = (now: number) => {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000)); last = now;
    if (!still) t += dt;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const wantDpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cw !== W || ch !== H || wantDpr !== dpr) { W = cw; H = ch; dpr = wantDpr; canvas.width = Math.max(1, W * dpr); canvas.height = Math.max(1, H * dpr); }
    if (!W || !H) return;
    // Each state's weight eases towards 1 for the current state and 0 for the others.
    const ease = still ? 1 : 1 - Math.exp(-dt * 3.2);
    for (const m of MODES) w[m] += ((m === mode ? 1 : 0) - w[m]) * ease;
    const wI = w.idle, wL = w.listening, wT = w.thinking, wS = w.speaking;
    // Loudness of the voice: measured when the app gives it, otherwise a natural speech rhythm.
    const goal = level ?? (mode === 'speaking' ? voice(t, 0) : mode === 'listening' ? voice(t * 0.9, 2.1) : 0);
    lv += (goal - lv) * (1 - Math.exp(-dt * (goal > lv ? 18 : 6)));
    const S = H, R = S * 0.29;
    const sinceShift = (now - shiftAt) / 1000, dir = Math.sign(shiftTo - shiftFrom) || 1;
    const hue = currentHue();
    rot += dt * (0.06 * wI + 0.025 * wL + 0.32 * wT + 0.16 * wS);
    const tilt = 0.38 + 0.18 * Math.sin(t * 0.07);
    const c = Math.cos(rot), s = Math.sin(rot), ct = Math.cos(tilt), st = Math.sin(tilt);
    // Whole-sphere size: breathing when standing by, leaning in when listening, drawn in when thinking, swelling with the voice when replying.
    const scale = (1 + 0.03 * Math.sin(t * 0.9) * wI) * (1 + 0.045 * wL) * (1 - 0.13 * wT) * (1 + 0.11 * lv * wS);
    const k = 0.035 * (wI + wL * 0.7 + wS) + 0.01 * wT;
    const twistA = wT * 0.95 * Math.sin(t * 0.85);
    const ripL = wL * 0.045 * (0.35 + 0.65 * lv), ripS = wS * 0.055 * (0.2 + 0.8 * lv);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    let cx = 0;
    const offsetFor = (p: { jit: number; arc: number }, x1: number) => {
      let dx = shiftTo, dy = 0;
      if (!still && sinceShift < SHIFT_S + STAGGER + 0.2) {
        const lead = ((1 - dir * x1) / 2) * STAGGER + p.jit;
        const e = smooth(clamp01((sinceShift - lead) / SHIFT_S));
        dx = shiftFrom + (shiftTo - shiftFrom) * e; dy = Math.sin(Math.PI * e) * p.arc;
      }
      return [dx, dy] as const;
    };
    for (let i = 0; i < N; i++) {
      const p = pts[i]!;
      let x = p.x * scale + k * Math.sin(t * p.f1 + p.p1), y = p.y * scale + k * Math.sin(t * p.f2 + p.p2), z = p.z * scale + k * Math.sin(t * p.f3 + p.p3);
      // Thinking: the top and bottom turn against each other and back again, like wringing a thought out.
      if (twistA) { const a = twistA * p.y, ca = Math.cos(a), sa = Math.sin(a); const xx = x * ca + z * sa; z = z * ca - x * sa; x = xx; }
      const x1 = x * c + z * s, z1 = z * c - x * s;
      let y2 = y * ct - z1 * st, z2 = y * st + z1 * ct, x2 = x1;
      // Rings across the face towards you: particles bunch into circles that run inward to the centre while
      // listening and outward from it while replying, and the particles on each ring light up.
      pb[i] = 0;
      if (ripL || ripS) {
        // Measured as seen on screen (with perspective), and lit only on the near side, so the rings read cleanly.
        const rho = Math.hypot(x2, y2) || 1e-6, seen = rho * (2.6 / (2.6 - z2));
        const wl = Math.sin(seen * 9 + t * 5), ws = Math.sin(seen * 8 - t * 7);
        const push = ripL * wl + ripS * ws;
        x2 += (x2 / rho) * push; y2 += (y2 / rho) * push;
        const near = clamp01(z2 * 1.5 + 0.3);
        pb[i] = near * (Math.max(0, wl) ** 3 * (ripL / 0.045) + Math.max(0, ws) ** 3 * (ripS / 0.055));
      }
      const f = 2.6 / (2.6 - z2);
      const [dx, dy] = offsetFor(p, x1);
      px[i] = W / 2 + dx + x2 * R * f; py[i] = H / 2 + dy + y2 * R * f; pd[i] = (z2 + 1.3) / 2.6;
      cx += px[i]!;
    }
    cx /= N;
    const energy = 0.05 * wI + 0.22 * wL + (0.28 + 0.08 * Math.sin(t * 2.4)) * wT + (0.3 + 0.55 * lv) * wS;
    const col = (l: number, a: number) => `hsla(${hue.toFixed(1)},90%,${l}%,${a.toFixed(3)})`;
    const g = ctx.createRadialGradient(cx, H / 2, 0, cx, H / 2, R * 1.3);
    g.addColorStop(0, col(60, 0.1 + energy * 0.22)); g.addColorStop(1, col(60, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = col(70, 0.1 + energy * 0.12 + 0.05 * wT);
    ctx.lineWidth = 0.6; ctx.beginPath();
    for (let q = 0; q < links.length; q += 2) { const a1 = links[q]!, b1 = links[q + 1]!; if (Math.abs(px[a1]! - px[b1]!) > R * 0.6) continue; ctx.moveTo(px[a1]!, py[a1]!); ctx.lineTo(px[b1]!, py[b1]!); }
    ctx.stroke();
    // Thinking: signals flash along the links, a few at a time.
    if (wT > 0.02 && !still) {
      ctx.strokeStyle = col(85, 0.75 * wT); ctx.lineWidth = 1.1; ctx.beginPath();
      for (let q = 0; q < links.length; q += 2) {
        const ph = (q * 0.3090169 + t * 0.55) % 1;
        if (ph > 0.022) continue;
        const a1 = links[q]!, b1 = links[q + 1]!; if (Math.abs(px[a1]! - px[b1]!) > R * 0.6) continue;
        ctx.moveTo(px[a1]!, py[a1]!); ctx.lineTo(px[b1]!, py[b1]!);
      }
      ctx.stroke();
    }
    // A faint line of light along each ring, so the direction of travel reads even at a glance.
    const ring = (k: number, w: number, strength: number, maxSeen: number) => {
      if (strength < 0.02) return;
      const n0 = Math.floor((w * t) / (2 * Math.PI));
      for (let n = n0 - 1; n <= n0 + 3; n++) {
        const seen = (Math.PI / 2 + 2 * Math.PI * n - w * t) / k;
        if (seen <= 0.05 || seen > maxSeen) continue;
        const fade = Math.sin(Math.PI * Math.min(1, seen / maxSeen));
        ctx.strokeStyle = col(80, 0.32 * strength * fade); ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(cx, H / 2, seen * R, 0, Math.PI * 2); ctx.stroke();
      }
    };
    if (!still) { ring(9, 5, ripL / 0.045, 1.35); ring(8, -7, ripS / 0.055, 1.55); }
    const grow = 1 + 0.12 * wL + 0.5 * lv * wS + 0.1 * wT;
    for (let i = 0; i < N; i++) {
      const d = Math.max(0, Math.min(1, pd[i]!)), lit = Math.min(1, pb[i]!), z = (0.7 + 1.6 * d) * grow * (1 + 0.9 * lit);
      ctx.fillStyle = col(74 + 18 * lit, Math.min(1, (0.2 + 0.8 * d) * (1 - 0.35 * (wL + wS)) + 0.9 * lit));
      ctx.fillRect(px[i]! - z / 2, py[i]! - z / 2, z, z);
    }
    if (wT > 0.02) {
      for (const sp of sparks) {
        if (!still) sp.a += sp.sp * dt;
        for (let j = 0; j < TRAIL; j++) {
          const a = sp.a - Math.sign(sp.sp) * j * 0.05, ca = Math.cos(a) * sp.r * scale, sa = Math.sin(a) * sp.r * scale;
          const x = sp.u[0]! * ca + sp.v[0]! * sa, y = sp.u[1]! * ca + sp.v[1]! * sa, z = sp.u[2]! * ca + sp.v[2]! * sa;
          const x1 = x * c + z * s, z1 = z * c - x * s, y2 = y * ct - z1 * st, z2 = y * st + z1 * ct, f = 2.6 / (2.6 - z2);
          const [dx, dy] = offsetFor({ jit: 0, arc: 0 }, x1);
          const d = clamp01((z2 + 1.3) / 2.6), fade = 1 - j / TRAIL, size = (1.2 + 2.2 * d) * fade + 0.4;
          ctx.fillStyle = `hsla(${hue.toFixed(1)},100%,${88 - j * 1.5}%,${(wT * fade * (0.35 + 0.65 * d)).toFixed(3)})`;
          ctx.fillRect(W / 2 + dx + x1 * R * f - size / 2, H / 2 + dy + y2 * R * f - size / 2, size, size);
        }
      }
    }
  };
  raf = requestAnimationFrame(frame);
  return {
    stop() { alive = false; cancelAnimationFrame(raf); },
    setMode(m) { mode = m; },
    setLevel(v) { level = v == null ? null : clamp01(v); },
    state: () => ({ w, level: lv, t }),
    setShift(v) {
      if (v === shiftTo) return;
      const since = (performance.now() - shiftAt) / 1000;
      const done = since >= SHIFT_S + STAGGER;
      shiftFrom = done ? shiftTo : shiftFrom + (shiftTo - shiftFrom) * smooth(clamp01(since / (SHIFT_S + STAGGER)));
      shiftTo = v; shiftAt = performance.now();
    },
  };
}

/**
 * The ring of ticks around the core, moving in step with it. The canvas is 1.2 times the ring's box and centred on
 * it, so echoes can spread past the ring. Sizes are in the ring's own 600-unit square. The plain inner line is
 * drawn by the page (so the screen-to-screen transition can draw it in); this adds its light on top.
 *   Standing by: turns slowly; the inner line breathes with the core.
 *   Listening:   almost stops and draws in a little; the ticks become a level meter for your voice.
 *   Thinking:    turns faster; two bright arcs chase round the ticks and the inner line, in opposite directions.
 *   Replying:    the ticks lift with each syllable, and on the strongest ones an echo of the ring spreads outwards.
 */
export function startRing(canvas: HTMLCanvasElement, core: CoreHandle): { stop(): void } {
  const TICKS = 120, still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const ctx = canvas.getContext('2d')!;
  let W = 0, dpr = 1, raf = 0, alive = true, rotR = 0, last = performance.now(), prevLv = 0, lastEcho = -1;
  const echoes: { at: number }[] = [];
  const frame = (now: number) => {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000)); last = now;
    const cw = canvas.clientWidth, wantDpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cw !== W || wantDpr !== dpr) { W = cw; dpr = wantDpr; canvas.width = Math.max(1, W * dpr); canvas.height = Math.max(1, W * dpr); }
    if (!W) return;
    const { w, level: lv, t } = core.state();
    const wI = w.idle, wL = w.listening, wT = w.thinking, wS = w.speaking;
    const hue = currentHue().toFixed(1);
    const acc = (a: number, l = 75) => `hsla(${hue},100%,${l}%,${Math.max(0, Math.min(1, a)).toFixed(3)})`;
    const wht = (a: number) => `rgba(255,255,255,${Math.max(0, Math.min(1, a)).toFixed(3)})`;
    if (!still) rotR += dt * (2 * Math.PI / 90) * (wI + 0.08 * wL + 3.2 * wT + 0.7 * wS);
    // Echoes start on the strongest syllables while replying.
    if (!still && wS > 0.5 && lv > 0.62 && prevLv <= 0.62 && t - lastEcho > 0.22) { echoes.push({ at: t }); lastEcho = t; }
    prevLv = lv;
    const k = (W / 1.2) / 600; // ring units to pixels
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * W / 2, dpr * W / 2);
    ctx.clearRect(-360, -360, 720, 720);
    const draw = 1 - 0.012 * wL; // listening draws the whole ring in a little
    // Echoes: copies of the ring that spread out and fade.
    for (let i = echoes.length - 1; i >= 0; i--) {
      const e = (t - echoes[i]!.at) / 0.9;
      if (e >= 1 || e < 0) { echoes.splice(i, 1); continue; }
      ctx.strokeStyle = acc(0.45 * (1 - e) * (1 - e)); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 0, 292 + e * 54, 0, Math.PI * 2); ctx.stroke();
    }
    // Thinking: two chasing heads, one on the ticks and one on the inner line.
    const head1 = t * 2.6, head2 = -t * 1.7 + Math.PI;
    ctx.lineCap = 'round';
    for (let i = 0; i < TICKS; i++) {
      const a = rotR + (i / TICKS) * Math.PI * 2;
      const meter = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(i * 1.7 + t * 9) * Math.sin(i * 0.37 - t * 3.1));
      // How far behind the thinking head this tick is (0 at the head), for a tail that fades behind it.
      const back = (((head1 - (i / TICKS) * Math.PI * 2) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const chase = wT * Math.exp(-back * 2.2);
      const lift = wL * 16 * (0.25 + 0.75 * lv) * meter + wS * 11 * lv + chase * 8;
      const glow = Math.min(1, wL * (0.25 + 0.6 * lv * meter) + wS * (0.2 + 0.6 * lv) + chase);
      const r0 = 289 * draw, r1 = (295 + lift) * draw;
      ctx.strokeStyle = glow > 0.05 ? acc(0.35 + 0.65 * glow, 75 + 15 * glow) : wht(0.35 + 0.05 * Math.sin(t * 0.9) * wI);
      ctx.lineWidth = 1.5 + 1.2 * glow;
      const c = Math.cos(a), s = Math.sin(a);
      ctx.beginPath(); ctx.moveTo(c * r0, s * r0); ctx.lineTo(c * r1, s * r1); ctx.stroke();
    }
    // Light on the inner line: breathes when standing by, brighter when listening, carries a bright arc when thinking.
    const rIn = 276;
    const extra = 0.06 * (0.5 + 0.5 * Math.sin(t * 0.9)) * wI + 0.12 * wL + 0.1 * wS * lv;
    if (extra > 0.005) { ctx.lineWidth = 1; ctx.strokeStyle = wht(extra); ctx.beginPath(); ctx.arc(0, 0, rIn, 0, Math.PI * 2); ctx.stroke(); }
    if (wT > 0.02) {
      for (let j = 0; j < 14; j++) {
        const a0 = head2 + j * 0.05;
        ctx.strokeStyle = acc(wT * (1 - j / 14) * 0.9, 80); ctx.lineWidth = 2.2 - j * 0.1;
        ctx.beginPath(); ctx.arc(0, 0, rIn, a0, a0 + 0.055); ctx.stroke();
      }
    }
  };
  raf = requestAnimationFrame(frame);
  return { stop() { alive = false; cancelAnimationFrame(raf); } };
}
