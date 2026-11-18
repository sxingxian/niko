// Backgrounds behind Niko, drawn on one 2D canvas behind the core. Each style follows the shared hue and answers the
// core's state softly (brighter while listening, livelier while thinking, pulsing with the voice while speaking).
// Light by design: about 30 frames a second, nothing drawn while the page is hidden, one settled still frame when the
// person prefers reduced motion or when a picker tile is paused. Plain JavaScript drawing code; types in backgrounds.d.ts.
/* eslint-disable */
var RM = typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function voice(t, seed) {
    var syll = Math.pow(Math.max(0, Math.sin(t * 7.3 + seed)), 2) * (0.55 + 0.45 * Math.sin(t * 1.7 + seed * 2));
    var word = Math.sin(t * 0.95 + seed) > -0.35 ? 1 : 0.1;
    return Math.min(1, syll * word + 0.08);
  }
  function hsl(h, s, l) {
    s /= 100; l /= 100;
    var k = function (n) { return (n + h / 30) % 12; }, a = s * Math.min(l, 1 - l);
    var f = function (n) { return 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))); };
    return [f(0), f(8), f(4)];
  }

  // ---------------------------------------------------------------- backgrounds behind Niko
  // Each style draws the whole screen behind the core, in the person's colour (hue), and answers the core's state
  // softly: a little brighter while listening, livelier while thinking, pulsing with the voice while speaking.
  // Kept light: one canvas, about 30 frames a second, nothing drawn while the page is hidden, a still frame when the
  // person prefers reduced motion.
  function hsla(h, s, l, a) { return 'hsla(' + (((h % 360) + 360) % 360).toFixed(1) + ',' + s + '%,' + l + '%,' + Math.max(0, Math.min(1, a)).toFixed(3) + ')'; }
  function base(c, W, H, h, k) {
    // The app's own .bg: three soft glows over a deep tint of the colour.
    c.fillStyle = hsla(h, 55, 6, 1); c.fillRect(0, 0, W, H);
    var g = function (x, y, rx, ry, hh, s, l, a) {
      c.save(); c.translate(x, y); c.scale(rx, ry);
      var gr = c.createRadialGradient(0, 0, 0, 0, 0, 1); gr.addColorStop(0, hsla(hh, s, l, a)); gr.addColorStop(0.65, hsla(hh, s, l, 0)); gr.addColorStop(1, hsla(hh, s, l, 0));
      c.fillStyle = gr; c.fillRect(-1, -1, 2, 2); c.restore();
    };
    g(W * 0.5, H * 0.44, W * 0.6 / 0.65 * 0.65, H * 0.75 / 0.65 * 0.65, h, 80, 45, 0.3 * k);
    g(W, 0, W * 0.5, H * 0.65, h + 50, 70, 40, 0.2 * k);
    g(0, H, W * 0.5, H * 0.65, h - 40, 70, 40, 0.16 * k);
  }
  var BGS = {
    glow: { name: 'Glow', note: 'Today’s background. Barely moves, easiest on the battery', init: function () { return {}; },
      draw: function (c, W, H, t, h, S) { base(c, W, H, h, 1 + S.react * 0.25); } },

    aurora: { name: 'Aurora', note: 'Curtains of light drift overhead',
      // Real aurora: folded curtains made of fine vertical rays, brightest along the lower hem and fading upward.
      // Drawn at low resolution and scaled up smoothly, so there are no hard edges; sized by the screen's shorter side
      // so a tall phone gets the same curtains as a wide desktop.
      init: function (r) {
        var B = [], offs = [-30, 0, 25, 55];
        for (var i = 0; i < 4; i++) B.push({ ph: r() * 6.28, sp: 0.05 + r() * 0.05, off: offs[i], y: 0.2 + i * 0.055 + r() * 0.03, amp: 0.06 + r() * 0.05, f: 1.6 + r() * 1.2 });
        return { B: B };
      },
      draw: function (c, W, H, t, h, S, D) {
        base(c, W, H, h, 0.7);
        if (typeof document === 'undefined') return;
        var sc = 4, w = Math.ceil(W / sc), hh = Math.ceil(H / sc);
        if (!D.oc) D.oc = document.createElement('canvas');
        if (D.oc.width !== w || D.oc.height !== hh) { D.oc.width = w; D.oc.height = hh; }
        var o = D.oc.getContext('2d');
        o.setTransform(1, 0, 0, 1, 0, 0); o.globalAlpha = 1; o.globalCompositeOperation = 'source-over';
        o.clearRect(0, 0, w, hh);
        o.globalCompositeOperation = 'lighter';
        // Tall screens (phones): taller curtains reaching up to the top, hems spread around the core, a little brighter.
        var unit = Math.min(W, H), lift = 1 + S.react * 0.7, tall = H > W * 1.3;
        var boost = tall ? 1.7 : 1, ySpread = tall ? 0.07 : 0.055, yBase = tall ? 0.24 : 0.2;
        for (var bi = 0; bi < D.B.length; bi++) {
          var q = D.B[bi], hu = h + q.off;
          var gr = o.createLinearGradient(0, 0, 0, 1);
          gr.addColorStop(0, hsla(hu + 40, 90, 60, 0)); gr.addColorStop(0.55, hsla(hu + 25, 90, 58, 0.25));
          gr.addColorStop(0.88, hsla(hu, 95, 70, 0.9)); gr.addColorStop(0.95, hsla(hu - 10, 100, 82, 1)); gr.addColorStop(1, hsla(hu, 90, 70, 0));
          o.fillStyle = gr;
          for (var i = 0; i < w; i++) {
            var x = i * sc, px = x / unit, u = x / W;
            var bottom = H * (yBase + bi * ySpread + (q.y - 0.2 - bi * 0.055)) + (tall ? H * 0.9 : unit) * (q.amp * Math.sin(px * q.f * (tall ? 1.6 : 1) + t * q.sp * 5 + q.ph) + 0.025 * Math.sin(px * 6.5 - t * q.sp * 8 + q.ph));
            var len = (tall ? H * 0.26 : unit * 0.26) * (1 + 0.38 * Math.sin(px * 2.6 + t * 0.2 + q.ph)) * (1 + S.speak * 0.3);
            var rays = 0.5 + 0.5 * Math.sin(px * 38 + t * 0.9 + q.ph) * Math.sin(px * 15.3 - t * 0.55 + q.ph * 2);
            var edge = Math.pow(Math.max(0, Math.sin(Math.PI * u)), 0.6);
            var a = 0.2 * (0.55 + 0.45 * Math.sin(px * 2.3 + t * 0.35 + q.ph)) * (0.35 + 0.65 * rays) * edge * lift * boost;
            if (a < 0.004) continue;
            o.globalAlpha = Math.min(1, a);
            o.setTransform(1, 0, 0, len / sc, i, (bottom - len) / sc);
            o.fillRect(0, 0, 1, 1);
          }
          o.setTransform(1, 0, 0, 1, 0, 0);
        }
        c.save(); c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; c.globalCompositeOperation = 'lighter';
        c.drawImage(D.oc, 0, 0, w * sc, hh * sc);
        c.restore();
      } },

    stars: { name: 'Stars', note: 'A slow drift through deep space',
      init: function (r, small) { var S = []; for (var i = 0; i < (small ? 110 : 260); i++) S.push({ x: r() * 2 - 1, y: r() * 2 - 1, z: r(), tw: r() * 6.28 }); return { S: S }; },
      draw: function (c, W, H, t, h, St, D, dt) {
        base(c, W, H, h, 0.6);
        var cx = W / 2, cy = H * 0.44, sp = 0.025 + St.think * 0.12 + St.speak * 0.03;
        c.globalCompositeOperation = 'lighter';
        for (var i = 0; i < D.S.length; i++) {
          var s = D.S[i];
          s.z -= dt * sp; if (s.z <= 0.02) { s.z = 1; s.x = Math.random() * 2 - 1; s.y = Math.random() * 2 - 1; }
          var px = cx + (s.x / s.z) * W * 0.35, py = cy + (s.y / s.z) * H * 0.35;
          if (px < -10 || px > W + 10 || py < -10 || py > H + 10) { s.z = 1; continue; }
          var near = 1 - s.z, tw = 0.6 + 0.4 * Math.sin(t * 2 + s.tw);
          var sz = 0.6 + near * 2.2, a = (0.15 + near * 0.75) * tw * (1 + St.react * 0.4);
          c.fillStyle = near > 0.7 ? 'rgba(255,255,255,' + a.toFixed(3) + ')' : hsla(h + 20 * s.x, 70, 85, a);
          c.fillRect(px - sz / 2, py - sz / 2, sz, sz);
        }
        c.globalCompositeOperation = 'source-over';
      } },

    horizon: { name: 'Horizon', note: 'A holographic floor runs toward you',
      init: function () { return { off: 0 }; },
      draw: function (c, W, H, t, h, S, D, dt) {
        base(c, W, H, h, 0.7);
        var hy = H * 0.62, vx = W / 2;
        D.off = (D.off + dt * (0.12 + S.think * 0.5 + S.speak * 0.15)) % 1;
        var hz = c.createLinearGradient(0, hy - 60, 0, hy + 40);
        hz.addColorStop(0, hsla(h, 90, 60, 0)); hz.addColorStop(0.6, hsla(h, 90, 65, 0.16 * (1 + S.react))); hz.addColorStop(1, hsla(h, 90, 60, 0));
        c.fillStyle = hz; c.fillRect(0, hy - 60, W, 100);
        c.lineWidth = 1;
        for (var i = 0; i < 18; i++) {
          var z = (i + 1 - D.off) / 18, y = hy + (H - hy) * Math.pow(z, 2.2);
          c.strokeStyle = hsla(h, 90, 70, 0.04 + 0.22 * z); c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke();
        }
        for (var j = -24; j <= 24; j++) {
          var xb = vx + j * W * 0.07, a = 0.16 * (1 - Math.abs(j) / 26);
          var gr = c.createLinearGradient(0, hy, 0, H); gr.addColorStop(0, hsla(h, 90, 70, 0)); gr.addColorStop(1, hsla(h, 90, 70, a));
          c.strokeStyle = gr; c.beginPath(); c.moveTo(vx + j * 6, hy); c.lineTo(xb, H); c.stroke();
        }
      } },

    clouds: { name: 'Clouds', note: 'Soft colour clouds slowly turn',
      init: function (r) { var B = []; for (var i = 0; i < 6; i++) B.push({ ph: r() * 6.28, sp: 0.03 + r() * 0.04, rx: 0.25 + r() * 0.2, off: [-45, 0, 35, 70, -20, 15][i], s: 0.35 + r() * 0.25 }); return { B: B }; },
      draw: function (c, W, H, t, h, S, D) {
        c.fillStyle = hsla(h, 55, 5, 1); c.fillRect(0, 0, W, H);
        c.globalCompositeOperation = 'lighter';
        var pull = 1 - S.listen * 0.25;
        for (var i = 0; i < D.B.length; i++) {
          var q = D.B[i], ang = t * q.sp + q.ph;
          var x = W / 2 + Math.cos(ang) * W * q.rx * pull, y = H * 0.45 + Math.sin(ang * 1.3) * H * q.rx * 0.6 * pull;
          var R = Math.max(W, H) * q.s * (1 + S.speak * 0.08);
          var g = c.createRadialGradient(x, y, 0, x, y, R);
          g.addColorStop(0, hsla(h + q.off, 80, 45, 0.16 * (1 + S.react * 0.5))); g.addColorStop(1, hsla(h + q.off, 80, 40, 0));
          c.fillStyle = g; c.fillRect(0, 0, W, H);
        }
        c.globalCompositeOperation = 'source-over';
      } },

    dust: { name: 'Dust', note: 'Motes of light float upward',
      init: function (r, small) { var M = []; for (var i = 0; i < (small ? 60 : 150); i++) M.push({ x: r(), y: r(), z: 0.3 + r() * 0.7, ph: r() * 6.28, sp: 0.4 + r() * 0.8 }); return { M: M }; },
      draw: function (c, W, H, t, h, S, D, dt) {
        base(c, W, H, h, 0.85);
        c.globalCompositeOperation = 'lighter';
        for (var i = 0; i < D.M.length; i++) {
          var m = D.M[i];
          m.y -= dt * 0.012 * m.sp * m.z * (1 + S.think * 2); if (m.y < -0.05) { m.y = 1.05; m.x = Math.random(); }
          var x = (m.x + 0.02 * Math.sin(t * 0.3 * m.sp + m.ph)) * W, y = m.y * H;
          var glint = Math.pow(0.5 + 0.5 * Math.sin(t * m.sp * 1.5 + m.ph), 6) * (1 + S.speak * 2 * D.lv);
          var sz = (0.8 + 2.4 * m.z) * (W < 600 ? 0.8 : 1), a = (0.12 + 0.35 * m.z) * (0.5 + glint);
          c.fillStyle = hsla(h, 80, 80, a * 0.35); c.beginPath(); c.arc(x, y, sz * 2.6, 0, 6.283); c.fill();
          c.fillStyle = hsla(h, 70, 90, a); c.beginPath(); c.arc(x, y, sz * 0.6, 0, 6.283); c.fill();
        }
        c.globalCompositeOperation = 'source-over';
      } },

    hex: { name: 'Lattice', note: 'A light wave runs across a hex grid',
      init: function () { return {}; },
      draw: function (c, W, H, t, h, S) {
        base(c, W, H, h, 0.7);
        var size = W < 600 ? 22 : 30, w = size * Math.sqrt(3), cx = W / 2, cy = H * 0.44;
        var spd = 0.18 + S.think * 0.6, wave = (t * spd) % 1.6 - 0.3;
        c.lineWidth = 1;
        for (var row = -1; row * size * 1.5 < H + size; row++) {
          for (var col = -1; col * w < W + w; col++) {
            var x = col * w + (row % 2 ? w / 2 : 0), y = row * size * 1.5;
            var d = Math.hypot(x - cx, y - cy) / Math.hypot(W, H);
            var hit = Math.exp(-Math.pow((d - wave) * 9, 2)) * (0.8 + S.react);
            var vign = 1 - Math.min(1, d * 1.4);
            var a = 0.035 * vign + 0.28 * hit * vign + S.speak * D_LV * 0.05;
            if (a < 0.01) continue;
            c.strokeStyle = hsla(h, 90, 70, a);
            c.beginPath();
            for (var k = 0; k < 6; k++) { var an = Math.PI / 3 * k + Math.PI / 6, px = x + Math.cos(an) * size * 0.92, py = y + Math.sin(an) * size * 0.92; if (k) c.lineTo(px, py); else c.moveTo(px, py); }
            c.closePath(); c.stroke();
          }
        }
      } },

    streams: { name: 'Streams', note: 'Quiet threads of data fall past',
      init: function (r, small) { var L = []; for (var i = 0; i < (small ? 16 : 42); i++) L.push({ x: r(), y: r() * 1.4 - 0.2, sp: 0.04 + r() * 0.08, len: 0.08 + r() * 0.18, z: 0.3 + r() * 0.7 }); return { L: L }; },
      draw: function (c, W, H, t, h, S, D, dt) {
        base(c, W, H, h, 0.75);
        c.globalCompositeOperation = 'lighter';
        for (var i = 0; i < D.L.length; i++) {
          var l = D.L[i];
          l.y += dt * l.sp * (1 + S.think * 2.5 + S.speak * D.lv); if (l.y - l.len > 1.05) { l.y = -0.05; l.x = Math.random(); }
          var x = l.x * W, y1 = (l.y - l.len) * H, y2 = l.y * H;
          var gr = c.createLinearGradient(0, y1, 0, y2);
          gr.addColorStop(0, hsla(h, 90, 70, 0)); gr.addColorStop(1, hsla(h, 90, 75, 0.22 * l.z * (1 + S.react * 0.6)));
          c.strokeStyle = gr; c.lineWidth = 1 + l.z; c.beginPath(); c.moveTo(x, y1); c.lineTo(x, y2); c.stroke();
          c.fillStyle = hsla(h, 60, 92, 0.6 * l.z); c.fillRect(x - 1.2, y2 - 1.2, 2.4, 2.4);
        }
        c.globalCompositeOperation = 'source-over';
      } },

    contours: { name: 'Contours', note: 'Gentle waves of light below',
      init: function () { return {}; },
      draw: function (c, W, H, t, h, S, D) {
        base(c, W, H, h, 0.75);
        c.lineWidth = 1.2;
        for (var k = 0; k < 12; k++) {
          var yb = H * (0.58 + k * 0.038), amp = H * (0.012 + k * 0.004) * (1 + S.speak * D.lv * 1.5 + S.listen * 0.4);
          c.strokeStyle = hsla(h + k * 3, 90, 70, 0.05 + k * 0.012 + S.react * 0.03);
          c.beginPath();
          for (var x = 0; x <= W; x += 8) {
            var u = x / W, y = yb + amp * Math.sin(u * 6.28 * 1.5 + t * (0.25 + S.think * 0.8) + k * 0.5) + amp * 0.5 * Math.sin(u * 6.28 * 3.2 - t * 0.17 + k);
            if (x) c.lineTo(x, y); else c.moveTo(x, y);
          }
          c.stroke();
        }
      } },

    silk: { name: 'Silk', note: 'Ribbons of light flow slowly across',
      // Three wide translucent ribbons, each a band between two flowing curves with a bright leading edge.
      init: function (r) { var R = []; for (var i = 0; i < 3; i++) R.push({ ph: r() * 6.28, sp: 0.08 + r() * 0.06, f: 1.1 + r() * 0.8, off: [-25, 15, 50][i], y: [0.3, 0.52, 0.74][i], tilt: [-0.18, 0.12, -0.08][i] }); return { R: R }; },
      draw: function (c, W, H, t, h, S, D) {
        base(c, W, H, h, 0.7);
        var unit = Math.min(W, H), step = 10;
        c.globalCompositeOperation = 'lighter';
        for (var k = 0; k < D.R.length; k++) {
          var q = D.R[k], top = [], bot = [];
          for (var x = -step; x <= W + step; x += step) {
            var px = x / unit;
            var cy = H * q.y + H * q.tilt * (x / W - 0.5) + unit * 0.09 * Math.sin(px * q.f + t * q.sp * 3 + q.ph) + unit * 0.03 * Math.sin(px * q.f * 2.7 - t * q.sp * 4);
            var th = unit * (0.07 + 0.05 * Math.sin(px * 1.9 + t * q.sp * 2 + q.ph * 2)) * (1 + S.speak * D.lv * 0.7 + S.listen * 0.15);
            top.push([x, cy - th]); bot.push([x, cy + th]);
          }
          var gr = c.createLinearGradient(0, 0, W, 0);
          var a = 0.1 * (1 + S.react * 0.8);
          gr.addColorStop(0, hsla(h + q.off - 20, 90, 60, a * 0.3)); gr.addColorStop(0.5, hsla(h + q.off, 90, 62, a)); gr.addColorStop(1, hsla(h + q.off + 25, 90, 60, a * 0.3));
          c.fillStyle = gr; c.beginPath(); c.moveTo(top[0][0], top[0][1]);
          for (var i = 1; i < top.length; i++) c.lineTo(top[i][0], top[i][1]);
          for (var j = bot.length - 1; j >= 0; j--) c.lineTo(bot[j][0], bot[j][1]);
          c.closePath(); c.fill();
          // The bright leading edge, and a fainter one below, give the ribbon its sheen.
          c.lineWidth = 1.4; c.strokeStyle = hsla(h + q.off, 95, 78, 0.28 * (1 + S.react * 0.6));
          c.beginPath(); c.moveTo(top[0][0], top[0][1]); for (i = 1; i < top.length; i++) c.lineTo(top[i][0], top[i][1]); c.stroke();
          c.lineWidth = 1; c.strokeStyle = hsla(h + q.off, 90, 70, 0.1);
          c.beginPath(); c.moveTo(bot[0][0], bot[0][1]); for (i = 1; i < bot.length; i++) c.lineTo(bot[i][0], bot[i][1]); c.stroke();
        }
        c.globalCompositeOperation = 'source-over';
      } },
    bokeh: { name: 'Bokeh', note: 'Soft lights drift out of focus',
      // Lights at three depths: far ones small and crisp, near ones large, very soft and faint. Each is a filled disc
      // with a soft edge (no bright ring), and they fade out near Niko so the core stays clear.
      init: function (r, small) {
        var B = [], n = small ? 26 : 46;
        for (var i = 0; i < n; i++) {
          var z = r(); // 0 = far, 1 = near
          B.push({ x: r(), y: r(), z: z, r: 0.012 + z * z * 0.11, vx: (r() - 0.5) * 0.006 * (0.4 + z), vy: (-0.3 - r() * 0.7) * 0.004 * (0.4 + z), off: (r() - 0.5) * 60 + (r() < 0.2 ? 150 : 0), ph: r() * 6.28, f: 0.3 + r() * 0.6 });
        }
        B.sort(function (p, q) { return p.z - q.z; });
        return { B: B };
      },
      draw: function (c, W, H, t, h, S, D, dt) {
        base(c, W, H, h, 0.65);
        var unit = Math.min(W, H), cx = W / 2, cy = H * 0.42, clear = unit * 0.3;
        c.globalCompositeOperation = 'lighter';
        for (var i = 0; i < D.B.length; i++) {
          var b = D.B[i], sp = 1 + S.think * 1.5;
          b.x += b.vx * dt * sp; b.y += b.vy * dt * sp;
          if (b.y < -0.15) { b.y = 1.15; b.x = Math.random(); }
          if (b.x < -0.15) b.x = 1.15; else if (b.x > 1.15) b.x = -0.15;
          var x = b.x * W, y = b.y * H, R = b.r * unit * (1 + S.speak * D.lv * 0.15 * b.z);
          var d = Math.hypot(x - cx, y - cy), keep = Math.min(1, Math.max(0, (d - clear * 0.6) / clear));
          var a = (0.36 - b.z * 0.24) * (0.75 + 0.25 * Math.sin(t * b.f + b.ph)) * keep * (1 + S.react * 0.7);
          if (a < 0.004) continue;
          var edge = 0.35 + b.z * 0.55;
          var g = c.createRadialGradient(x, y, 0, x, y, R);
          g.addColorStop(0, hsla(h + b.off, 80, 72, a * 0.85));
          g.addColorStop(Math.max(0, 1 - edge * 0.9), hsla(h + b.off, 80, 72, a));
          g.addColorStop(1, hsla(h + b.off, 80, 70, 0));
          c.fillStyle = g; c.beginPath(); c.arc(x, y, R, 0, 6.283); c.fill();
        }
        c.globalCompositeOperation = 'source-over';
      } },

    plasma: { name: 'Plasma', note: 'Colours melt slowly into each other',
      init: function () { return {}; },
      draw: function (c, W, H, t, h, S, D) {
        if (typeof document === 'undefined') { base(c, W, H, h, 1); return; }
        var sc = 8, w = Math.ceil(W / sc), hh = Math.ceil(H / sc);
        if (!D.oc) D.oc = document.createElement('canvas');
        if (D.oc.width !== w || D.oc.height !== hh) { D.oc.width = w; D.oc.height = hh; D.img = null; }
        var o = D.oc.getContext('2d'); if (!D.img) D.img = o.createImageData(w, hh);
        var px = D.img.data, sp = 1 + S.think * 1.5, tt = t * sp, unit = Math.min(W, H) / sc, cx = w / 2, cy = hh * 0.44;
        for (var y = 0; y < hh; y++) for (var x = 0; x < w; x++) {
          var u = x / unit, v = y / unit;
          var val = (Math.sin(u * 6 + tt * 0.3) + Math.sin(v * 7 - tt * 0.22) + Math.sin((u + v) * 4.5 + tt * 0.26) + Math.sin(Math.hypot(x - cx, y - cy) / unit * 9 - tt * 0.4)) / 4;
          var band = Math.pow(0.5 + 0.5 * Math.sin(val * 6.28 + tt * 0.2), 2);
          var rgb = hsl(h + val * 40, 65, 4 + 8 * band * (1 + S.react * 0.35));
          var k = (y * w + x) * 4; px[k] = rgb[0]; px[k + 1] = rgb[1]; px[k + 2] = rgb[2]; px[k + 3] = 255;
        }
        o.putImageData(D.img, 0, 0);
        c.save(); c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; c.drawImage(D.oc, 0, 0, w * sc, hh * sc); c.restore();
      } },

    cosmos: { name: 'Cosmos', note: 'A galaxy’s band of stars across the sky',
      init: function (r, small) {
        var P = [];
        for (var i = 0; i < (small ? 520 : 1300); i++) { var g = (r() + r() + r() - 1.5) * 0.9; P.push({ s: r() * 2.4 - 1.2, d: g * (0.5 + r() * 0.5) * 0.35, z: r(), tw: r() * 6.28, warm: r() < 0.25 }); }
        return { P: P };
      },
      draw: function (c, W, H, t, h, S, D) {
        base(c, W, H, h, 0.5);
        var ang = (H > W ? -1.05 : -0.5) + t * 0.006, ca = Math.cos(ang), sa = Math.sin(ang), cx = W / 2, cy = H * 0.45, L = Math.hypot(W, H) * 0.55, wdt = Math.min(W, H) * 0.75;
        c.save(); c.translate(cx, cy); c.rotate(ang); c.scale(L, wdt * 0.32);
        var g = c.createRadialGradient(0, 0, 0, 0, 0, 1); g.addColorStop(0, hsla(h + 15, 60, 60, 0.3 * (1 + S.react * 0.6))); g.addColorStop(0.45, hsla(h, 70, 48, 0.12)); g.addColorStop(1, hsla(h, 70, 40, 0));
        c.fillStyle = g; c.fillRect(-1, -1, 2, 2); c.restore();
        c.globalCompositeOperation = 'lighter';
        for (var i = 0; i < D.P.length; i++) {
          var p = D.P[i], bx = p.s * L, by = p.d * wdt;
          var x = cx + bx * ca - by * sa, y = cy + bx * sa + by * ca;
          var tw = 0.6 + 0.4 * Math.sin(t * (1.5 + p.z) + p.tw), sz = 0.8 + p.z * 1.8, a = (0.4 + p.z * 0.6) * tw * (1 + S.react * 0.4);
          c.fillStyle = p.warm ? hsla(h + 160, 60, 85, a) : hsla(h, 50, 88, a);
          c.fillRect(x - sz / 2, y - sz / 2, sz, sz);
        }
        c.globalCompositeOperation = 'source-over';
      } },

    circuit: { name: 'Circuit', note: 'Signals race along glowing traces',
      init: function (r, small) {
        var T = [], n = small ? 22 : 34, g = 24;
        for (var i = 0; i < n; i++) {
          var x = Math.round(r() * 60) * g, y = Math.round(r() * 60) * g, pts = [[x, y]], dir = Math.floor(r() * 4);
          for (var k = 0; k < 6 + r() * 8; k++) {
            if (r() < 0.35) dir = (dir + (r() < 0.5 ? 1 : 3)) % 4;
            var len = (2 + Math.floor(r() * 5)) * g;
            x += [len, 0, -len, 0][dir]; y += [0, len, 0, -len][dir]; pts.push([x, y]);
          }
          var tot = 0; for (k = 1; k < pts.length; k++) tot += Math.abs(pts[k][0] - pts[k - 1][0]) + Math.abs(pts[k][1] - pts[k - 1][1]);
          T.push({ pts: pts, len: tot, p: r(), sp: 0.05 + r() * 0.08 });
        }
        return { T: T };
      },
      draw: function (c, W, H, t, h, S, D, dt) {
        base(c, W, H, h, 0.65);
        // Traces live in a 1440-wide square, scaled the same both ways and centred, so nothing is squashed on a phone.
        var sx = Math.max(W, H) / 1440, sy = sx, ox = (W - 1440 * sx) / 2, oy = (H - 1440 * sy) / 2;
        c.save(); c.translate(ox, oy);
        c.lineWidth = 1.2; c.lineCap = 'round'; c.lineJoin = 'round';
        for (var i = 0; i < D.T.length; i++) {
          var q = D.T[i], pts = q.pts;
          c.strokeStyle = hsla(h, 75, 62, 0.16 + S.react * 0.06); c.beginPath(); c.moveTo(pts[0][0] * sx, pts[0][1] * sy);
          for (var k = 1; k < pts.length; k++) c.lineTo(pts[k][0] * sx, pts[k][1] * sy);
          c.stroke();
          c.fillStyle = hsla(h, 80, 70, 0.25); c.beginPath(); c.arc(pts[0][0] * sx, pts[0][1] * sy, 2.5, 0, 6.283); c.arc(pts[pts.length - 1][0] * sx, pts[pts.length - 1][1] * sy, 2.5, 0, 6.283); c.fill();
          q.p = (q.p + dt * q.sp * (1 + S.think * 3 + S.speak * D.lv * 2)) % 1;
          // A pulse: a bright short stretch travelling along the trace.
          var at = q.p * q.len, run = 0, seg = 40;
          c.strokeStyle = hsla(h, 100, 80, 0.75); c.lineWidth = 2; c.beginPath();
          var started = false;
          for (k = 1; k < pts.length; k++) {
            var a0 = pts[k - 1], a1 = pts[k], L = Math.abs(a1[0] - a0[0]) + Math.abs(a1[1] - a0[1]);
            var s0 = Math.max(at - seg, run), s1 = Math.min(at, run + L);
            if (s1 > s0) {
              var f0 = (s0 - run) / L, f1 = (s1 - run) / L;
              var x0 = a0[0] + (a1[0] - a0[0]) * f0, y0 = a0[1] + (a1[1] - a0[1]) * f0, x1 = a0[0] + (a1[0] - a0[0]) * f1, y1 = a0[1] + (a1[1] - a0[1]) * f1;
              if (!started) { c.moveTo(x0 * sx, y0 * sy); started = true; }
              c.lineTo(x1 * sx, y1 * sy);
            }
            run += L;
          }
          c.stroke(); c.lineWidth = 1.2;
        }
        c.restore();
      } },

    peaks: { name: 'Peaks', note: 'Wireframe mountains roll toward you',
      // Ridges seen from just above, rows drawn far to near so each one hides what's behind it. A valley runs
      // down the middle of the screen so Niko sits above open ground.
      init: function () { return { off: 0 }; },
      draw: function (c, W, H, t, h, S, D, dt) {
        base(c, W, H, h, 0.6);
        D.off += dt * (0.6 + S.think * 1.6);
        var hy = H * 0.6, f = Math.min(W, H) * 0.35, camH = 1, rows = 34, cols = W < 600 ? 40 : 72, halfW = (W / 2) / f * 1.05;
        var noise = function (x, z) { var v = 0.5 * Math.sin(x * 1.7 + z * 0.53) + 0.3 * Math.sin(x * 3.9 - z * 0.91 + 1.3) + 0.2 * Math.sin(x * 8.1 + z * 1.7); return Math.pow(0.5 + 0.5 * v, 1.4); };
        var fill = hsla(h, 55, 6, 1), boost = 1 + S.speak * D.lv * 0.3;
        for (var ri = rows; ri >= 1; ri--) {
          var z = (ri - (D.off % 1)) * 0.8 + 1.2, zw = ri + Math.floor(D.off), depth = ri / rows, pts = [];
          for (var ci = 0; ci <= cols; ci++) {
            var X = (ci / cols * 2 - 1) * halfW * z, px = W / 2 + X * f / z;
            var side = Math.min(1, Math.pow(Math.abs(px - W / 2) / (W * 0.3), 1.8));
            var hg = side * (0.25 + 1.9 * noise(X, zw)) * boost;
            pts.push([px, hy + (camH - hg) * f / z]);
          }
          c.fillStyle = fill; c.beginPath(); c.moveTo(pts[0][0], H);
          for (var k = 0; k < pts.length; k++) c.lineTo(pts[k][0], pts[k][1]);
          c.lineTo(pts[pts.length - 1][0], H); c.closePath(); c.fill();
          c.strokeStyle = hsla(h, 90, 68, Math.pow(1 - depth, 1.3) * 0.6 * (1 + S.react * 0.5)); c.lineWidth = 1;
          c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (k = 1; k < pts.length; k++) c.lineTo(pts[k][0], pts[k][1]); c.stroke();
        }
        var hz = c.createLinearGradient(0, hy - 120, 0, hy);
        hz.addColorStop(0, hsla(h, 90, 60, 0)); hz.addColorStop(1, hsla(h, 90, 62, 0.08 * (1 + S.react)));
        c.globalCompositeOperation = 'lighter'; c.fillStyle = hz; c.fillRect(0, hy - 120, W, 120); c.globalCompositeOperation = 'source-over';
      } },

    beams: { name: 'Beams', note: 'Light pours down from above',
      init: function (r) { var B = []; for (var i = 0; i < 7; i++) B.push({ a: (i - 3) * 0.17 + (r() - 0.5) * 0.08, w: 0.04 + r() * 0.05, ph: r() * 6.28, sp: 0.1 + r() * 0.15 }); return { B: B }; },
      draw: function (c, W, H, t, h, S, D) {
        base(c, W, H, h, 0.65);
        var ox = W / 2, oy = -H * 0.25, L = H * 1.5;
        c.globalCompositeOperation = 'lighter';
        for (var i = 0; i < D.B.length; i++) {
          var b = D.B[i], ang = Math.PI / 2 + b.a + 0.05 * Math.sin(t * b.sp + b.ph), wd = b.w * (1 + 0.3 * Math.sin(t * b.sp * 1.7 + b.ph));
          var a = (0.1 + 0.05 * Math.sin(t * b.sp * 2 + b.ph)) * (1 + S.react);
          var x1 = ox + Math.cos(ang - wd) * L, y1 = oy + Math.sin(ang - wd) * L, x2 = ox + Math.cos(ang + wd) * L, y2 = oy + Math.sin(ang + wd) * L;
          var g = c.createLinearGradient(ox, oy, ox, oy + L * 0.75);
          g.addColorStop(0, hsla(h, 90, 75, a)); g.addColorStop(0.45, hsla(h, 90, 65, a * 0.6)); g.addColorStop(1, hsla(h, 90, 60, 0));
          c.fillStyle = g; c.beginPath(); c.moveTo(ox, oy); c.lineTo(x1, y1); c.lineTo(x2, y2); c.closePath(); c.fill();
        }
        c.globalCompositeOperation = 'source-over';
      } },

    smoke: { name: 'Smoke', note: 'Wisps of light rise and fade',
      init: function (r, small) { var P = []; for (var i = 0; i < (small ? 26 : 50); i++) P.push({ x: r(), life: r(), sp: 0.04 + r() * 0.05, ph: r() * 6.28, sz: 0.08 + r() * 0.1, off: (r() - 0.5) * 50 }); return { P: P }; },
      draw: function (c, W, H, t, h, S, D, dt) {
        base(c, W, H, h, 0.65);
        var unit = Math.min(W, H);
        c.globalCompositeOperation = 'lighter';
        for (var i = 0; i < D.P.length; i++) {
          var p = D.P[i];
          p.life += dt * p.sp * (1 + S.think * 1.5); if (p.life > 1) { p.life = 0; p.x = Math.random(); }
          var L = p.life, x = (p.x + 0.08 * Math.sin(L * 5 + p.ph + t * 0.2)) * W, y = H * (1.05 - L * 1.1);
          var R = unit * p.sz * (0.5 + L * 1.5), a = Math.sin(Math.PI * L) * 0.07 * (1 + S.react * 0.8);
          var g = c.createRadialGradient(x, y, 0, x, y, R);
          g.addColorStop(0, hsla(h + p.off, 70, 65, a)); g.addColorStop(1, hsla(h + p.off, 70, 60, 0));
          c.fillStyle = g; c.fillRect(x - R, y - R, R * 2, R * 2);
        }
        c.globalCompositeOperation = 'source-over';
      } },

    caustics: { name: 'Caustics', note: 'Light dances like sun under water',
      init: function () { return {}; },
      draw: function (c, W, H, t, h, S, D) {
        base(c, W, H, h, 0.6);
        if (typeof document === 'undefined') return;
        var sc = 3, w = Math.ceil(W / sc), hh = Math.ceil(H / sc);
        if (!D.oc) D.oc = document.createElement('canvas');
        if (D.oc.width !== w || D.oc.height !== hh) { D.oc.width = w; D.oc.height = hh; D.img = null; }
        var o = D.oc.getContext('2d'); if (!D.img) D.img = o.createImageData(w, hh);
        var px = D.img.data, unit = Math.min(W, H) / sc, tt = t * (0.5 + S.think * 0.8), col = hsl(h, 90, 72), gain = 1 + S.react * 0.8;
        for (var y = 0; y < hh; y++) for (var x = 0; x < w; x++) {
          var u = x / unit * 14, v = y / unit * 14;
          var a1 = Math.sin(u + Math.sin(v * 0.8 + tt) * 1.4), a2 = Math.sin(v * 1.1 + Math.sin(u * 0.9 - tt * 0.8) * 1.4), a3 = Math.sin((u + v) * 0.7 + Math.sin(u * 0.5 + tt * 0.6));
          var val = Math.pow(1 - Math.abs(a1 + a2 + a3) / 3, 9);
          var fade = 1 - Math.min(1, Math.abs(y / hh - 0.55) * 1.3);
          var k = (y * w + x) * 4, al = Math.min(1, val * 0.45 * gain * fade);
          px[k] = col[0]; px[k + 1] = col[1]; px[k + 2] = col[2]; px[k + 3] = al * 255;
        }
        o.putImageData(D.img, 0, 0);
        c.save(); c.globalCompositeOperation = 'lighter'; c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; c.drawImage(D.oc, 0, 0, w * sc, hh * sc); c.restore();
      } },

    flow: { name: 'Flow', note: 'Threads of light follow an unseen current',
      init: function (r, small) { var P = []; for (var i = 0; i < (small ? 260 : 650); i++) P.push({ x: r(), y: r(), age: r() * 200 }); return { P: P }; },
      draw: function (c, W, H, t, h, S, D, dt) {
        base(c, W, H, h, 0.65);
        if (typeof document === 'undefined') return;
        var sc = 2, w = Math.ceil(W / sc), hh = Math.ceil(H / sc);
        if (!D.tc) D.tc = document.createElement('canvas');
        if (D.tc.width !== w || D.tc.height !== hh) { D.tc.width = w; D.tc.height = hh; }
        var o = D.tc.getContext('2d'), unit = Math.min(W, H);
        o.globalCompositeOperation = 'destination-out'; o.fillStyle = 'rgba(0,0,0,0.06)'; o.fillRect(0, 0, w, hh);
        o.globalCompositeOperation = 'lighter'; o.lineWidth = 1; o.strokeStyle = hsla(h, 90, 72, 0.35 * (1 + S.react * 0.6));
        var sp = 40 * (1 + S.think * 1.5 + S.speak * D.lv) * dt / unit;
        o.beginPath();
        for (var i = 0; i < D.P.length; i++) {
          var p = D.P[i], X = p.x * W / unit, Y = p.y * H / unit;
          var ang = Math.sin(X * 2.2 + t * 0.08) * 1.6 + Math.cos(Y * 2.6 - t * 0.06) * 1.6 + Math.sin((X + Y) * 1.3 + t * 0.05);
          var nx = p.x + Math.cos(ang) * sp * unit / W, ny = p.y + Math.sin(ang) * sp * unit / H;
          o.moveTo(p.x * w, p.y * hh); o.lineTo(nx * w, ny * hh);
          p.x = nx; p.y = ny; p.age -= 1;
          if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1 || p.age < 0) { p.x = Math.random(); p.y = Math.random(); p.age = 100 + Math.random() * 200; }
        }
        o.stroke();
        c.save(); c.globalCompositeOperation = 'lighter'; c.imageSmoothingEnabled = true; c.drawImage(D.tc, 0, 0, w * sc, hh * sc); c.restore();
      } },

    equalizer: { name: 'Equalizer', note: 'Bars of light move with Niko’s voice',
      init: function (r, small) { var B = []; for (var i = 0; i < (small ? 24 : 64); i++) B.push({ ph: r() * 6.28, f: 0.7 + r() * 1.6, v: 0 }); return { B: B }; },
      draw: function (c, W, H, t, h, S, D, dt) {
        base(c, W, H, h, 0.65);
        var n = D.B.length, gap = W / n, bw = gap * 0.55, floor = H * 0.86, maxH = H * 0.28;
        c.globalCompositeOperation = 'lighter';
        for (var i = 0; i < n; i++) {
          var b = D.B[i], u = i / (n - 1), env = Math.pow(Math.sin(Math.PI * u), 0.8);
          var idle = 0.12 + 0.07 * Math.sin(t * b.f * 0.8 + b.ph + u * 6);
          var voice = (S.speak * D.lv + S.listen * D.lv * 0.7) * (0.4 + 0.6 * Math.abs(Math.sin(t * b.f * 6 + b.ph)));
          var think = S.think * 0.25 * Math.pow(0.5 + 0.5 * Math.sin(u * 12 - t * 4), 3);
          var goal = (idle + voice * 0.9 + think) * env;
          b.v += (goal - b.v) * Math.min(1, dt * 10);
          var x = i * gap + (gap - bw) / 2, bh = Math.max(2, b.v * maxH);
          var g = c.createLinearGradient(0, floor - bh, 0, floor);
          g.addColorStop(0, hsla(h, 95, 78, 0.55)); g.addColorStop(1, hsla(h, 90, 55, 0.12));
          c.fillStyle = g; c.fillRect(x, floor - bh, bw, bh);
          var gr = c.createLinearGradient(0, floor, 0, floor + bh * 0.5);
          gr.addColorStop(0, hsla(h, 90, 60, 0.12)); gr.addColorStop(1, hsla(h, 90, 60, 0));
          c.fillStyle = gr; c.fillRect(x, floor + 2, bw, bh * 0.5);
        }
        c.globalCompositeOperation = 'source-over';
      } }
  };
  var D_LV = 0;

export var BACKGROUND_STYLES = Object.keys(BGS);

/** Starts a background on a canvas. getHue() is read every frame (the app's shared, drifting hue). */
export function runBackground(canvas, style, getHue, opts) {
  opts = opts || {};
  var ctx = canvas.getContext('2d'), alive = true, raf = 0, last = 0, acc = 0, t = 0, drawn = false;
  var paused = !!opts.paused, react = opts.react !== false, mode = opts.mode || 'idle', level = null, lv = 0;
  var w = { idle: 1, listening: 0, thinking: 0, speaking: 0 }, M = ['idle', 'listening', 'thinking', 'speaking'];
  var cur = BGS[style] ? style : 'glow', D = null;
  // Particle styles are made for a whole screen; on a small canvas (a picker tile) only a share of the particles is
  // kept, so a tile looks like the full background in miniature instead of a crowded smudge.
  var THIN = { stars: 'S', dust: 'M', bokeh: 'B', cosmos: 'P', smoke: 'P', flow: 'P' };
  function init() {
    var cw = canvas.clientWidth || 400, ch = canvas.clientHeight || 400;
    D = BGS[cur].init(Math.random, cw < 600);
    var key = THIN[cur], share = Math.max(0.12, Math.min(1, (cw * ch) / (390 * 844)));
    if (key && D[key] && share < 1) { var step = Math.round(1 / share); D[key] = D[key].filter(function (_, i) { return i % step === 0; }); }
    drawn = false;
  }
  function frame(dt) {
    var W = canvas.clientWidth, H = canvas.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    if (!W || !H || !ctx) return;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); drawn = false; }
    if (!D) init();
    if (!RM) t += dt;
    var m = react ? mode : 'idle', ease = 1 - Math.exp(-dt * 3.2);
    for (var i = 0; i < 4; i++) w[M[i]] += ((M[i] === m ? 1 : 0) - w[M[i]]) * ease;
    var goal = !react ? 0 : level != null ? level : m === 'speaking' ? voice(t, 0) : m === 'listening' ? voice(t * 0.9, 2.1) : 0;
    lv += (goal - lv) * (1 - Math.exp(-dt * (goal > lv ? 18 : 6)));
    var S = { listen: w.listening, think: w.thinking, speak: w.speaking, react: w.listening * 0.5 + w.speaking * (0.3 + 0.7 * lv) + w.thinking * 0.3 };
    D_LV = lv; D.lv = lv;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    BGS[cur].draw(ctx, W, H, t, getHue(), S, D, RM ? 0 : dt);
    drawn = true;
  }
  function loop(now) {
    if (!alive) return;
    raf = requestAnimationFrame(loop);
    if (typeof document !== 'undefined' && document.hidden) { last = 0; return; }
    var dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016; last = now; acc += dt;
    if (paused || RM) {
      // One settled frame, then nothing until something changes.
      if (!drawn) { for (var k = 0; k < (RM ? 1 : 45); k++) frame(1 / 30); }
      acc = 0; return;
    }
    if (acc < 1 / 30 && drawn) return;   // about 30 frames a second is plenty for a background
    frame(acc); acc = 0;
  }
  raf = requestAnimationFrame(loop);
  return {
    stop: function () { alive = false; cancelAnimationFrame(raf); },
    setStyle: function (s) { var n = BGS[s] ? s : 'glow'; if (n !== cur) { cur = n; init(); } },
    setMode: function (m) { if (m !== mode) { mode = m; if (paused || RM) drawn = false; } },
    setLevel: function (v) { level = v == null ? null : Math.max(0, Math.min(1, v)); },
    setPaused: function (p) { paused = !!p; },
    setReact: function (r) { react = r !== false; },
  };
}
