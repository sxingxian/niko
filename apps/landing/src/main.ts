// Niko landing page: particles stay on screen and change formation and colour as you scroll.
// Ported from the approved "Landing page v3 · scroll-animated" mockup.
import Lenis from 'lenis';
import './landing.css';

const SERVICES = ['Gmail', 'iCloud Mail', 'Outlook', 'Synology Mail', 'Google Calendar', 'Apple Calendar', 'Outlook Calendar', 'Synology Calendar', 'Notion', 'OneNote', 'Make.com', 'n8n', 'Power Automate', 'Telegram', 'Slack', 'Discord', 'Other AI systems'];

// ---- links: the app lives at /app on sxingxian.com and on its own host for midnightpoetry.studio
const appRoot = location.hostname === 'niko.midnightpoetry.studio' ? 'https://nikoapp.midnightpoetry.studio' : '/app';
document.querySelectorAll<HTMLAnchorElement>('[data-app]').forEach((a) => { a.href = appRoot + a.dataset.app!; });
const chips = document.querySelector('[data-services]')!;
for (const s of SERVICES) { const el = document.createElement('span'); el.textContent = s; chips.appendChild(el); }
fetch('/api/auth/config').then((r) => r.json()).then((cfg: { registration?: string }) => {
  if (cfg.registration !== 'open') return;
  document.querySelector('[data-reg]')!.textContent = 'Open for sign-up';
  const join = document.querySelector<HTMLAnchorElement>('[data-join]')!;
  join.textContent = 'Create an account'; join.href = appRoot + '/sign-up';
}).catch(() => undefined);

const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (!still) {
  const lenis = new Lenis();
  const loop = (t: number) => { lenis.raf(t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}

// ---- particles
const N = 1400, K = 6, TAU = 6.283185, rnd = Math.random;
const shapes: Float32Array[] = [];
for (let k = 0; k < K; k++) shapes.push(new Float32Array(N * 3));
const wob = new Float32Array(N * 6);
const gauss = () => (rnd() + rnd() + rnd() - 1.5) * 0.8;
for (let i = 0; i < N; i++) {
  const y = 1 - (2 * (i + 0.5)) / N, r = Math.sqrt(1 - y * y), a = i * 2.399963, j = 0.9 + rnd() * 0.2;
  const ux = Math.cos(a) * r, uz = Math.sin(a) * r;
  shapes[0]!.set([ux * j, y * j, uz * j], i * 3); // sphere
  const ring = i % 3, ra = rnd() * TAU, rr = 0.7 + ring * 0.42 + (rnd() - 0.5) * 0.06;
  shapes[1]!.set([Math.cos(ra) * rr, (rnd() - 0.5) * 0.05, Math.sin(ra) * rr], i * 3); // orbiting rings
  const u = (i / N) * 2 - 1, env = Math.exp(-u * u * 2.2), band = i % 4;
  shapes[2]!.set([u * 2.2, Math.sin(u * 14 + band * 0.5) * 0.8 * env * (0.5 + band * 0.17) + (rnd() - 0.5) * 0.04, (rnd() - 0.5) * 0.25], i * 3); // waveform
  const node = i % SERVICES.length, na = (node / SERVICES.length) * TAU, nx = Math.cos(na) * 1.5, ny = Math.sin(na) * 1.1, pick = rnd();
  if (pick < 0.58) shapes[3]!.set([nx + gauss() * 0.1, ny + gauss() * 0.1, gauss() * 0.1], i * 3); // hub with one node per service
  else if (pick < 0.84) { const q = rnd(); shapes[3]!.set([nx * q + gauss() * 0.012, ny * q + gauss() * 0.012, 0], i * 3); }
  else shapes[3]!.set([gauss() * 0.2, gauss() * 0.2, gauss() * 0.2], i * 3);
  if (i % 9 < 5) shapes[4]!.set([ux * 0.5 * j, y * 0.5 * j, uz * 0.5 * j], i * 3); // core inside a shell
  else shapes[4]!.set([ux * 1.3, y * 1.3, uz * 1.3], i * 3);
  shapes[5]!.set([ux * j * 1.15, y * j * 1.15, uz * j * 1.15], i * 3);
  wob.set([0.12 + rnd() * 0.45, 0.12 + rnd() * 0.45, 0.12 + rnd() * 0.45, rnd() * TAU, rnd() * TAU, rnd() * TAU], i * 6);
}
const links: number[] = [];
for (let i = 0; i + 34 < N; i += 4) { links.push(i, i + 21); if (i % 8 === 0) links.push(i, i + 34); }
const offX = [0, 0.21, -0.21, 0.21, -0.21, 0], rotW = [1, 1, 0.1, 0.3, 1, 1], linkW = [1, 0, 0, 0, 0.5, 1], tiltS = [0.38, 1.02, 0.08, 0.12, 0.38, 0.38], hues = [190, 262, 318, 28, 158, 190];
const px = new Float32Array(N), py = new Float32Array(N), pd = new Float32Array(N);
const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const lerpHue = (a: number, b: number, f: number) => (a + (((b - a + 540) % 360) - 180) * f + 360) % 360;
const clamp = (v: number) => Math.max(0, Math.min(1, v));

const root = document.querySelector<HTMLElement>('[data-root]')!;
const stage = document.querySelector<HTMLElement>('[data-stage]')!;
const glow = document.querySelector<HTMLElement>('[data-bg]')!;
const cv = document.querySelector<HTMLCanvasElement>('canvas[data-core]')!;
const reveals = [...document.querySelectorAll<HTMLElement>('[data-reveal]')];
const ctx = cv.getContext('2d')!;
let W = 0, H = 0, dpr = 1, rot = 0.6, ps = 0;
const t0 = performance.now();

function frame(now: number) {
  requestAnimationFrame(frame);
  const t = still ? 0 : Math.max(0, ((now || performance.now()) - t0) / 1000);
  const rect = root.getBoundingClientRect(), vh = window.innerHeight || 800;
  const total = Math.max(1, rect.height - vh);
  const cw = stage.clientWidth, ch = stage.clientHeight, wantDpr = Math.min(window.devicePixelRatio || 1, 1.5);
  if (cw !== W || ch !== H || wantDpr !== dpr) { W = cw; H = ch; dpr = wantDpr; cv.width = Math.max(1, W * dpr); cv.height = Math.max(1, H * dpr); }
  if (!W || !H) return;
  if (!still) rot += 0.0016;
  const p = clamp(-rect.top / total);
  ps += (p - ps) * (still ? 1 : 0.09);
  const seg = ps * (K - 1), i0 = Math.min(K - 2, Math.floor(seg));
  let f = clamp(seg - i0); f = f * f * (3 - 2 * f);
  const wide = W > 760 ? 1 : 0;
  const hue = lerpHue(hues[i0]!, hues[i0 + 1]!, f);
  const ox = lerp(offX[i0]!, offX[i0 + 1]!, f) * wide;
  glow.style.background = `radial-gradient(60% 75% at ${(50 + ox * 100).toFixed(1)}% 46%, hsla(${hue.toFixed(1)},80%,45%,.3), transparent 65%), hsl(${hue.toFixed(1)},55%,6%)`;

  const A = shapes[i0]!, B = shapes[i0 + 1]!;
  const rw = lerp(rotW[i0]!, rotW[i0 + 1]!, f), lw = lerp(linkW[i0]!, linkW[i0 + 1]!, f), tilt = lerp(tiltS[i0]!, tiltS[i0 + 1]!, f);
  const edge = (i0 === 0 ? 1 - f : 0) + (i0 === K - 2 ? f : 0);
  const cx = W / 2 + ox * W, cy = H * (0.5 - 0.12 * edge), R = Math.min(W, H) * 0.25;
  const ang = rot * rw + (1 - rw) * 0.3 * Math.sin(t * 0.2);
  const c = Math.cos(ang), s = Math.sin(ang), ct = Math.cos(tilt), st = Math.sin(tilt);
  const col = (l: number, al: number) => `hsla(${hue.toFixed(1)},90%,${l}%,${al.toFixed(3)})`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.5);
  g.addColorStop(0, col(60, 0.13)); g.addColorStop(1, col(60, 0));
  ctx.fillStyle = g; ctx.fillRect(cx - R * 1.5, cy - R * 1.5, R * 3, R * 3);
  for (let i = 0; i < N; i++) {
    const o = i * 3, w = i * 6;
    const x = lerp(A[o]!, B[o]!, f) + 0.035 * Math.sin(t * wob[w]! + wob[w + 3]!);
    const y = lerp(A[o + 1]!, B[o + 1]!, f) + 0.035 * Math.sin(t * wob[w + 1]! + wob[w + 4]!);
    const z = lerp(A[o + 2]!, B[o + 2]!, f) + 0.035 * Math.sin(t * wob[w + 2]! + wob[w + 5]!);
    const x1 = x * c + z * s, z1 = z * c - x * s, y2 = y * ct - z1 * st, z2 = y * st + z1 * ct;
    const pf = 2.8 / (2.8 - z2);
    px[i] = cx + x1 * R * pf; py[i] = cy + y2 * R * pf; pd[i] = clamp((z2 + 1.4) / 2.8);
  }
  if (lw > 0.03) {
    ctx.strokeStyle = col(70, 0.13 * lw); ctx.lineWidth = 0.6; ctx.beginPath();
    for (let q = 0; q < links.length; q += 2) { ctx.moveTo(px[links[q]!]!, py[links[q]!]!); ctx.lineTo(px[links[q + 1]!]!, py[links[q + 1]!]!); }
    ctx.stroke();
  }
  for (let i = 0; i < N; i++) {
    const d = pd[i]!, z = 0.8 + 1.7 * d;
    ctx.fillStyle = col(74, 0.22 + 0.78 * d);
    ctx.fillRect(px[i]! - z / 2, py[i]! - z / 2, z, z);
  }
  for (const el of reveals) {
    const er = el.getBoundingClientRect();
    const v = clamp((vh * 0.92 - er.top) / (vh * 0.3)) * clamp((er.bottom + vh * 0.1) / (vh * 0.3));
    el.style.opacity = v.toFixed(3);
    el.style.transform = `translateY(${((1 - v) * 36).toFixed(1)}px)`;
  }
}
requestAnimationFrame(frame);
