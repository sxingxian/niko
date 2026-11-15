// The particle flow between Home and the workspace (Inbox, Calendar, Notes): the home sphere pours into the
// workspace ring, every fifth particle landing on the ring to become its ticks; going back plays it in reverse.
// Between Inbox, Calendar and Notes ('swap') the ring and its core break up into a loose cloud and the same build runs again.
// Drawn on one full-screen canvas above the pages; the pages' own cores fade in underneath when it ends.
import { useEffect, useRef } from 'react';
import { currentHue, sphereOf, spots } from '@niko/ui';

export const FLOW_SECONDS = 2.2;
/** How long the old screen stays (fading out) before the new one is mounted. */
export const LEAVE_MS = 280;

type Sphere = { x: number; y: number; R: number };

/** Where Home's core will be, before Home is on screen (mirrors the .home layout in app.css). */
function homeEstimate(): Sphere {
  const vw = window.innerWidth, vh = window.innerHeight;
  if (vw <= 900) { const s = Math.min(350, vw * 0.9); return { x: vw / 2, y: 100 + s / 2, R: s * 0.29 }; }
  const s = Math.min(720, vh * 0.8, vw * 0.92), top = Math.max(20, vh / 2 - 430);
  return { x: vw / 2, y: top + s / 2, R: s * 0.29 };
}
/** Where the workspace ring will be, before the workspace is on screen (mirrors the .ws layout in app.css). */
function ringEstimate(): { core: Sphere; ring: number } {
  const vw = window.innerWidth;
  if (vw <= 900) { const size = 220; return { core: { x: vw / 2, y: 84 + 14 + size / 2, R: size * 0.867 * 0.29 }, ring: size * 292 / 600 }; }
  const gap = Math.max(14, Math.min(66, vw * 0.046)), cols = vw - 32 - 40 - 72 - 2 * gap;
  const size = Math.min(600, cols / 2), x = 32 + 72 + gap + size / 2, y = 96 + 14 + size / 2;
  return { core: { x, y, R: size * 0.867 * 0.29 }, ring: size * 292 / 600 };
}
function ringNow(): { core: Sphere; ring: number } | null {
  const core = sphereOf(spots.get('ws')), box = spots.get('ring');
  if (!core || !box || !box.isConnected) return null;
  return { core, ring: box.getBoundingClientRect().width * 292 / 600 };
}

export function FlowLayer({ dir, loose, startedAt, onDone }: { dir: 'in' | 'out' | 'swap'; loose?: boolean; startedAt: number; onDone: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d')!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 0;
    const size = () => { W = window.innerWidth; H = window.innerHeight; cv.width = W * dpr; cv.height = H * dpr; };
    size();
    const phone = W <= 900;
    const N = phone ? 700 : 1000, rnd = Math.random;
    const pts = Array.from({ length: N }, (_, i) => {
      const y = 1 - (2 * (i + 0.5)) / N, r = Math.sqrt(1 - y * y), a = i * 2.399963, j = 0.9 + rnd() * 0.2;
      return { x: Math.cos(a) * r * j, y: y * j, z: Math.sin(a) * r * j, f1: 0.12 + rnd() * 0.45, f2: 0.12 + rnd() * 0.45, f3: 0.12 + rnd() * 0.45, p1: rnd() * 6.283, p2: rnd() * 6.283, p3: rnd() * 6.283,
        ring: i % 5 === 0, theta: 0, swirl: (rnd() < 0.5 ? -1 : 1) * (phone ? 16 + rnd() * 40 : 30 + rnd() * 70), jit: rnd() * 0.1 };
    });
    const ringPts = pts.filter((p) => p.ring);
    ringPts.forEach((p, k) => { p.theta = (k / ringPts.length) * Math.PI * 2 - Math.PI / 2; });
    const links: number[] = [];
    for (let i = 0; i + 34 < N; i += 4) { links.push(i, i + 21); if (i % 8 === 0) links.push(i, i + 34); }
    const px = new Float32Array(N), py = new Float32Array(N), pd = new Float32Array(N), alpha = new Float32Array(N), sz = new Float32Array(N);
    const clamp = (v: number) => Math.max(0, Math.min(1, v)), seg = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
    const smooth = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
    // Home end: known now if Home is the screen being left, else estimated until Home mounts.
    const swap = dir === 'swap';
    let home: Sphere | null = dir === 'in' ? sphereOf(spots.get('home')) : null;
    // The ring being left is measured once, now; for a swap the new ring sits in the same place.
    let ws = dir !== 'in' ? ringNow() : null;
    let rot = 0.6, raf = 0, finished = false;
    const D = FLOW_SECONDS * 1000;
    const frame = (now: number) => {
      const u = clamp((now - startedAt) / D);
      // The same choreography both ways: forwards into the workspace, backwards out of it.
      const p = dir === 'out' ? 1 - u : u;
      if (!swap && !home) home = sphereOf(spots.get('home'));
      if (!ws) ws = ringNow();
      const Bx = ws ?? ringEstimate(), B = Bx.core, RING = Bx.ring;
      // A swap starts from the ring as it stands, loosens it into a cloud the size of the Home sphere, then builds from that cloud.
      const A = swap ? { x: B.x, y: B.y, R: B.R * 1.4 } : home ?? homeEstimate();
      const undo = swap && !loose ? 1 - smooth(seg(u, 0, 0.24)) : 0;
      const dl = Math.hypot(B.x - A.x, B.y - A.y) || 1, dirX = (B.x - A.x) / dl, dirY = (B.y - A.y) / dl;
      const t = now / 1000;
      rot += 0.0012;
      const tilt = 0.38 + 0.18 * Math.sin(t * 0.07), c = Math.cos(rot), s = Math.sin(rot), ct = Math.cos(tilt), st = Math.sin(tilt);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Soft trails while particles travel: each frame fades the last instead of wiping it.
      ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = 'rgba(0,0,0,.42)'; ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      const loosen = Math.sin(Math.PI * seg(p, 0, 0.3));
      let cx = 0, cy = 0;
      for (let i = 0; i < N; i++) {
        const o = pts[i]!;
        const x = o.x + 0.035 * Math.sin(t * o.f1 + o.p1), y = o.y + 0.035 * Math.sin(t * o.f2 + o.p2), z = o.z + 0.035 * Math.sin(t * o.f3 + o.p3);
        const x1 = x * c + z * s, z1 = z * c - x * s, y2 = y * ct - z1 * st, z2 = y * st + z1 * ct, f = 2.6 / (2.6 - z2);
        const ux = x1 * f, uy = y2 * f;
        pd[i] = (z2 + 1.3) / 2.6;
        const grow = 1 + 0.07 * loosen;
        const sx = A.x + ux * A.R * grow + dirX * 14 * loosen, sy = A.y + uy * A.R * grow + dirY * 14 * loosen;
        const ex = o.ring ? B.x + Math.cos(o.theta) * RING : B.x + ux * B.R, ey = o.ring ? B.y + Math.sin(o.theta) * RING : B.y + uy * B.R;
        // The side facing the destination leaves first; the far side follows, so the sphere pours rather than jumps.
        // In a swap there is no direction to pour from, so the rebuild runs round the ring like the sweep.
        const lead = (swap ? ((Math.atan2(uy, ux) + Math.PI * 2.5) % (Math.PI * 2)) / (Math.PI * 2) * 0.3 : (1 - ((ux * dirX + uy * dirY) / 1.2 + 1) / 2) * 0.3) + o.jit + (o.ring ? 0.05 : 0);
        const e = smooth(seg(p, 0.08 + lead, 0.62 + lead * 0.75));
        const dx = ex - sx, dy = ey - sy, l = Math.hypot(dx, dy) || 1, arc = Math.sin(Math.PI * e), bend = arc * o.swirl;
        px[i] = sx + dx * e - (dy / l) * bend; py[i] = sy + dy * e + (dx / l) * bend;
        if (undo > 0) { px[i] = px[i]! + (ex - px[i]!) * undo; py[i] = py[i]! + (ey - py[i]!) * undo; }
        sz[i] = 1 + 0.3 * arc;
        alpha[i] = o.ring ? 1 - seg(p, 0.74, 0.94) : 1;
        cx += px[i]!; cy += py[i]!;
      }
      cx /= N; cy /= N;
      // Hand over to the pages' own cores in the last moments.
      const fade = 1 - seg(u, 0.9, 1);
      const hue = currentHue().toFixed(1), col = (l: number, a: number) => `hsla(${hue},90%,${l}%,${(a * fade).toFixed(3)})`;
      const R = A.R + (B.R - A.R) * smooth(seg(p, 0.1, 0.8));
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.4);
      g.addColorStop(0, col(60, 0.1)); g.addColorStop(1, col(60, 0));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      const settled = swap ? Math.min(1, undo + seg(p, 0.84, 0.98)) : Math.min(1, 1 - seg(p, 0, 0.14) + seg(p, 0.84, 0.98));
      if (settled > 0.01) {
        ctx.strokeStyle = col(70, 0.1 * settled); ctx.lineWidth = 0.6; ctx.beginPath();
        for (let m = 0; m < links.length; m += 2) { const a1 = links[m]!, b1 = links[m + 1]!; if (pts[a1]!.ring || pts[b1]!.ring) continue; ctx.moveTo(px[a1]!, py[a1]!); ctx.lineTo(px[b1]!, py[b1]!); }
        ctx.stroke();
      }
      for (let i = 0; i < N; i++) {
        if (alpha[i]! <= 0) continue;
        const d = clamp(pd[i]!), zz = (0.7 + 1.6 * d) * sz[i]! * (phone ? 0.9 : 1);
        ctx.fillStyle = col(74, (0.2 + 0.8 * d) * alpha[i]!);
        ctx.fillRect(px[i]! - zz / 2, py[i]! - zz / 2, zz, zz);
      }
      if (u >= 1) { if (!finished) { finished = true; ctx.clearRect(0, 0, W, H); onDone(); } return; }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    window.addEventListener('resize', size);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', size); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, startedAt]);
  return <canvas ref={ref} className="flow-layer" aria-hidden="true" />;
}
