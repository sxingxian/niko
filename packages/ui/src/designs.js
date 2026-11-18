// The designs other than Nebula, drawn on a 2D canvas. Nebula is startCore() in core.ts, unchanged.
// Each design reads the same things as Nebula: how much of each state is showing (they blend over about half a second),
// the loudness of the voice, and the shared hue. Plain JavaScript drawing code; its types are in designs.d.ts.
/* eslint-disable */
var RM = typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function rgb(h) {
    h = String(h || '#5ce1e6').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16); if (isNaN(n)) n = 0x5ce1e6;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function css(c, a) { a = a < 0 ? 0 : a > 1 ? 1 : a; return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a.toFixed(3) + ')'; }
  function rnd(seed) { var s = seed || 1; return function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }
  function fib(n) {
    var p = [], g = Math.PI * (3 - Math.sqrt(5));
    for (var i = 0; i < n; i++) { var y = 1 - (i / (n - 1)) * 2, r = Math.sqrt(1 - y * y), t = g * i; p.push([Math.cos(t) * r, y, Math.sin(t) * r]); }
    return p;
  }
  function rotY(p, a) { var c = Math.cos(a), s = Math.sin(a); return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; }
  function rotX(p, a) { var c = Math.cos(a), s = Math.sin(a); return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]; }
  function speech(t) { var v = Math.sin(t * 6.3) * 0.5 + Math.sin(t * 11.7 + 1.3) * 0.35 + Math.sin(t * 2.2) * 0.45; return Math.max(0, Math.min(1, v * 0.9 + 0.15)); }
  function micl(t) { var v = Math.sin(t * 4.1) * 0.4 + Math.sin(t * 9.3 + 0.7) * 0.3 + Math.sin(t * 1.3) * 0.5; return Math.max(0, Math.min(1, v * 0.7 + 0.25)); }
  function dot(c, x, y, r) { c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill(); }
  var F = 2.8; // perspective

  function geo() {
    var t = (1 + Math.sqrt(5)) / 2;
    var v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    var f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    function nz(p) { var l = Math.hypot(p[0], p[1], p[2]); return [p[0] / l, p[1] / l, p[2] / l]; }
    function edges(faces) {
      var E = {};
      faces.forEach(function (tr) { for (var i = 0; i < 3; i++) { var a = tr[i], b = tr[(i + 1) % 3]; E[a < b ? a + '_' + b : b + '_' + a] = [a, b]; } });
      return Object.keys(E).map(function (k) { return E[k]; });
    }
    v = v.map(nz);
    var iv = v.slice(0, 12), ie = edges(f), cache = {};
    function mid(a, b) {
      var k = a < b ? a + '_' + b : b + '_' + a;
      if (cache[k] != null) return cache[k];
      v.push(nz([(v[a][0] + v[b][0]) / 2, (v[a][1] + v[b][1]) / 2, (v[a][2] + v[b][2]) / 2]));
      return (cache[k] = v.length - 1);
    }
    var f2 = [];
    f.forEach(function (tr) { var a = mid(tr[0], tr[1]), b = mid(tr[1], tr[2]), c = mid(tr[2], tr[0]); f2.push([tr[0], a, c], [tr[1], b, a], [tr[2], c, b], [a, b, c]); });
    return { v: v, e: edges(f2), iv: iv, ie: ie };
  }

  var STYLES = {
    /* 2 — Prism: geodesic lattice with a counter-rotating inner crystal */
    prism: {
      init: function (r) {
        var g = geo();
        return { v: g.v.map(function (p) { return { p: p, ph: r() * 6.283 }; }), e: g.e, iv: g.iv, ie: g.ie, ia: 0 };
      },
      draw: function (c, W, H, t, P, C, D) {
        var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.3, ax = 0.4 + Math.sin(t * 0.11) * 0.15;
        var e = speech(t) * P.s, m = micl(t) * P.l, dp = D.dpr, i, a, b, v, sc;
        var pr = [];
        for (i = 0; i < D.v.length; i++) {
          var q = D.v[i], p = q.p;
          var rad = 1 + 0.03 * Math.sin(t * 0.8 + q.ph) + e * 0.14 * Math.max(0, Math.sin(q.ph + t * 7)) - P.l * 0.06 + m * 0.05;
          v = rotX(rotY([p[0] * rad, p[1] * rad, p[2] * rad], D.ay), ax);
          sc = F / (F + v[2]); pr.push([cx + v[0] * R * sc, cy + v[1] * R * sc, v[2]]);
        }
        c.lineWidth = dp * (D.small ? 0.6 : 0.9);
        var la = 0.1 + 0.18 * P.l * (0.5 + m) + 0.1 * P.k + 0.15 * e;
        for (i = 0; i < D.e.length; i++) {
          a = pr[D.e[i][0]]; b = pr[D.e[i][1]];
          var d = 1 - ((a[2] + b[2]) / 2 + 1) / 2;
          c.strokeStyle = css(C, (la + 0.12) * (0.3 + 0.7 * d));
          c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
        }
        for (i = 0; i < pr.length; i++) {
          var z = 1 - (pr[i][2] + 1) / 2;
          c.fillStyle = css(C, 0.35 + 0.65 * z);
          dot(c, pr[i][0], pr[i][1], (1 + 1.8 * z) * dp * (D.small ? 0.7 : 1));
        }
        D.ia += D.dt * (0.3 + P.k * 2.4);
        var ir = 0.42 + 0.05 * Math.sin(t * 1.3) + e * 0.08, ip = [];
        for (i = 0; i < D.iv.length; i++) {
          v = rotX(rotY([D.iv[i][0] * ir, D.iv[i][1] * ir, D.iv[i][2] * ir], -D.ia), -ax * 0.7 + t * 0.05);
          sc = F / (F + v[2]); ip.push([cx + v[0] * R * sc, cy + v[1] * R * sc]);
        }
        c.strokeStyle = css(mix(C, [255, 255, 255], 0.35), 0.25 + 0.35 * P.k + 0.3 * e);
        for (i = 0; i < D.ie.length; i++) {
          a = ip[D.ie[i][0]]; b = ip[D.ie[i][1]];
          c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
        }
      }
    },

    /* 3 — Ribbon: braided strands that ripple with the voice */
    ribbon: {
      init: function (r, small) {
        var S = [];
        for (var s = 0; s < 6; s++) S.push({ ph: r() * 6.283, k: 1.2 + r() * 1.4, dir: r() < 0.5 ? -1 : 1, a: 0.7 + r() * 0.5 });
        return { S: S, N: small ? 70 : 160 };
      },
      draw: function (c, W, H, t, P, C, D) {
        var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.34, e = speech(t) * P.s, m = micl(t) * P.l, dp = D.dpr, N = D.N;
        for (var s = 0; s < D.S.length; s++) {
          var S = D.S[s];
          var amp = (0.12 + 0.05 * Math.sin(t * 0.4 + s)) * S.a + P.l * m * 0.32 + P.s * e * 0.55 + P.k * 0.12;
          var spd = 0.6 + P.k * 2.6 + P.s * 0.8;
          for (var i = 0; i < N; i++) {
            var u = i / (N - 1) * 2 - 1, win = Math.exp(-u * u * 2.4);
            var ang = u * S.k * Math.PI + t * spd * S.dir + S.ph;
            var v = rotY(rotX([u * 1.3, Math.sin(ang) * amp * win, Math.cos(ang) * amp * win], 0.2), Math.sin(t * 0.15) * 0.25);
            var sc = F / (F + v[2]), z = 1 - (v[2] + 1) / 2;
            c.fillStyle = css(C, (0.25 + 0.6 * z) * (0.3 + 0.7 * win));
            dot(c, cx + v[0] * R * sc, cy + v[1] * R * sc, (0.7 + 1.5 * z) * dp * (D.small ? 0.7 : 1) * (0.5 + win * 0.7));
          }
        }
      }
    },

    /* 4 — Flux: a liquid drop that reshapes as it listens and speaks */
    flux: {
      init: function (r, small) {
        return { pts: fib(small ? 420 : 1400).map(function (p) { return { p: p }; }), ph: 0 };
      },
      draw: function (c, W, H, t, P, C, D) {
        var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.29, e = speech(t) * P.s, m = micl(t) * P.l, dp = D.dpr;
        D.ph += D.dt * (0.7 + P.k * 2.2 + P.s * 0.6);
        var T = D.ph, A = 1 + P.k * 0.6 + e * 1.6 + m * 0.9 - P.l * 0.1;
        var g = c.createRadialGradient(cx, cy, 0, cx, cy, R * 1.25);
        g.addColorStop(0, css(C, 0.16 + 0.1 * e)); g.addColorStop(1, css(C, 0));
        c.fillStyle = g; c.fillRect(0, 0, W, H);
        for (var i = 0; i < D.pts.length; i++) {
          var p = D.pts[i].p;
          var d = 0.11 * Math.sin(p[0] * 3 + T * 1.1) * Math.sin(p[1] * 2.6 + T * 0.9) + 0.07 * Math.sin(p[2] * 4 - T * 1.3 + p[0] * 2) + 0.04 * Math.sin(p[1] * 7 + T * 2);
          var rad = (1 + d * A) * (1 - P.l * 0.05);
          var v = rotX(rotY([p[0] * rad, p[1] * rad, p[2] * rad], D.ay), 0.3);
          var sc = F / (F + v[2]), z = 1 - (v[2] + 1) / 2, hi = Math.max(0, d * A * 4);
          c.fillStyle = css(mix(C, [255, 255, 255], Math.min(0.6, hi * 0.5)), 0.2 + 0.7 * z);
          dot(c, cx + v[0] * R * sc, cy + v[1] * R * sc, (0.5 + 1.1 * z) * dp * (D.small ? 0.7 : 1));
        }
      }
    },

    /* 5 — Constellation: drifting stars that link up as Niko reasons */
    constellation: {
      init: function (r, small) {
        var n = small ? 34 : 72, N = [];
        for (var i = 0; i < n; i++) {
          var th = r() * 6.283, ph = Math.acos(2 * r() - 1), rr = Math.cbrt(r()) * 0.95;
          N.push({ p: [Math.sin(ph) * Math.cos(th) * rr, Math.cos(ph) * rr, Math.sin(ph) * Math.sin(th) * rr], v: [(r() - 0.5) * 0.18, (r() - 0.5) * 0.18, (r() - 0.5) * 0.18], ph: r() * 6.283, sz: 0.7 + r() * 0.8 });
        }
        return { N: N };
      },
      draw: function (c, W, H, t, P, C, D) {
        var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.32, e = speech(t) * P.s, m = micl(t) * P.l, dp = D.dpr, n = D.N.length;
        var spd = 0.35 + P.k * 1.6, S = 1 - P.l * (0.18 + 0.12 * m) + P.s * e * 0.12, pr = [], i, j, k, q, z;
        for (i = 0; i < n; i++) {
          q = D.N[i]; var p = q.p;
          for (k = 0; k < 3; k++) p[k] += q.v[k] * D.dt * spd;
          var l = Math.hypot(p[0], p[1], p[2]);
          if (l > 1) {
            var dd = (q.v[0] * p[0] + q.v[1] * p[1] + q.v[2] * p[2]) / l;
            if (dd > 0) for (k = 0; k < 3; k++) q.v[k] -= 2 * dd * p[k] / l;
            for (k = 0; k < 3; k++) p[k] /= l;
          }
          var v = rotX(rotY([p[0] * S, p[1] * S, p[2] * S], D.ay), 0.25);
          var sc = F / (F + v[2]); pr.push([cx + v[0] * R * sc, cy + v[1] * R * sc, v[2]]);
        }
        var thr = 0.5 + P.k * 0.25 + P.s * e * 0.1;
        c.lineWidth = dp * (D.small ? 0.5 : 0.8);
        for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) {
          var a = D.N[i].p, b = D.N[j].p, dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
          var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < thr) {
            z = 1 - ((pr[i][2] + pr[j][2]) / 2 + 1) / 2;
            c.strokeStyle = css(C, (1 - d / thr) * (0.25 + 0.35 * P.k + 0.2 * e) * (0.4 + 0.6 * z));
            c.beginPath(); c.moveTo(pr[i][0], pr[i][1]); c.lineTo(pr[j][0], pr[j][1]); c.stroke();
          }
        }
        for (i = 0; i < n; i++) {
          q = D.N[i]; z = 1 - (pr[i][2] + 1) / 2;
          var pulse = 0.5 + 0.5 * Math.sin(t * 2 + q.ph), br = 0.35 + 0.5 * z + e * 0.4 * pulse;
          var s = (1.2 + 2.2 * z) * q.sz * dp * (D.small ? 0.7 : 1) * (1 + e * 0.5 * pulse);
          c.fillStyle = css(C, br * 0.22); dot(c, pr[i][0], pr[i][1], s * 2.6);
          c.fillStyle = css(mix(C, [255, 255, 255], 0.3), br); dot(c, pr[i][0], pr[i][1], s);
        }
      }
    }
    ,

    /* 6 — Vortex: a tilted spiral galaxy; inner arms turn faster */
    vortex: {
      init: function (r, small) {
        var n = small ? 520 : 1500, P = [];
        for (var i = 0; i < n; i++) {
          var rr = 0.06 + Math.pow(r(), 0.65) * 0.94, arm = i % 3;
          var g = (r() + r() + r() - 1.5) * (0.5 * (1 - rr) + 0.18);
          P.push({ r: rr, a: arm * 2.094 + rr * 3.4 + g, y: (r() - 0.5) * 0.1 * (1 - rr * 0.6), b: 0.4 + r() * 0.6, ph: r() * 6.283 });
        }
        return { P: P };
      },
      draw: function (c, W, H, t, P, C, D) {
        var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.36, dp = D.dpr, lv = D.lv * P.s, i;
        var g = c.createRadialGradient(cx, cy, 0, cx, cy, R * 0.55);
        g.addColorStop(0, css(mix(C, [255, 255, 255], 0.5), 0.35 + 0.25 * lv + 0.1 * P.k)); g.addColorStop(1, css(C, 0));
        c.fillStyle = g; c.fillRect(0, 0, W, H);
        var tilt = 1.05 + 0.08 * Math.sin(t * 0.2), spin = 0.18 + P.k * 1.2 + P.s * 0.15;
        for (i = 0; i < D.P.length; i++) {
          var q = D.P[i];
          q.a += D.dt * spin / (0.35 + q.r);
          var rr = q.r * (1 - 0.14 * P.l * (0.6 + 0.4 * D.lv)) * (1 + lv * 0.14 * Math.sin(q.r * 12 - t * 8));
          var v = rotX([Math.cos(q.a) * rr, q.y, Math.sin(q.a) * rr], tilt);
          v = rotY(v, Math.sin(t * 0.11) * 0.2);
          var sc = F / (F + v[2]), z = 1 - (v[2] + 1) / 2;
          var tw = 0.75 + 0.25 * Math.sin(t * 2 + q.ph);
          c.fillStyle = css(mix(C, [255, 255, 255], (1 - q.r) * 0.45), (0.25 + 0.6 * z) * q.b * tw);
          dot(c, cx + v[0] * R * sc, cy + v[1] * R * sc, (0.5 + 1.2 * z) * dp * (D.small ? 0.7 : 1) * (1.4 - q.r * 0.6));
        }
      }
    },

    /* 7 — Hologram: a dotted globe swept by a scan line */
    hologram: {
      init: function (r, small) {
        var L = [], lats = small ? 11 : 17, base = small ? 34 : 72;
        for (var a = 0; a < lats; a++) {
          var lat = -1.35 + (2.7 * a) / (lats - 1), n = Math.max(6, Math.round(base * Math.cos(lat)));
          for (var b = 0; b < n; b++) L.push({ lat: lat, lon: (b / n) * 6.2832 + a * 0.3, ph: r() * 6.283 });
        }
        return { L: L };
      },
      draw: function (c, W, H, t, P, C, D) {
        var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.3, dp = D.dpr, lv = D.lv;
        var scanS = 0.7 + P.k * 2.2;
        var band1 = Math.sin(t * scanS), band2 = Math.sin(t * scanS * 1.37 + 2) * P.k;
        for (var i = 0; i < D.L.length; i++) {
          var q = D.L[i];
          var y0 = Math.sin(q.lat), rl = Math.cos(q.lat);
          var push = 1 + P.s * lv * 0.12 * Math.sin(q.lat * 5 - t * 8) - P.l * 0.05 + P.l * lv * 0.04 * Math.sin(q.lat * 9 + t * 6);
          var v = [Math.cos(q.lon) * rl * push, y0 * push, Math.sin(q.lon) * rl * push];
          v = rotX(rotY(v, D.ay * 1.6), 0.32);
          var sc = F / (F + v[2]), z = 1 - (v[2] + 1) / 2;
          var hit = Math.exp(-Math.pow((y0 - band1) * 7, 2)) + Math.exp(-Math.pow((y0 - band2) * 7, 2)) * P.k;
          var a = (0.12 + 0.55 * z) * (0.6 + 0.4 * Math.sin(t * 3 + q.ph) * 0.3) + hit * 0.8 * (0.4 + z);
          var s = (0.9 + 1.2 * z) * dp * (D.small ? 0.7 : 1) * (1 + hit * 0.6);
          c.fillStyle = css(mix(C, [255, 255, 255], Math.min(0.6, hit * 0.6)), a);
          c.fillRect(cx + v[0] * R * sc - s / 2, cy + v[1] * R * sc - s / 2, s, s);
        }
      }
    },

    /* 8 — Helix: a turning double strand; signals climb the rungs as it thinks */
    helix: {
      init: function (r, small) { return { N: small ? 26 : 46, S: small ? 4 : 7 }; },
      draw: function (c, W, H, t, P, C, D) {
        var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.36, dp = D.dpr, lv = D.lv, N = D.N, S = D.S, k = D.small ? 0.7 : 1;
        var rot = D.ay * 3, ys = 1 - 0.1 * P.l, sig = (t * (0.5 + P.k * 1.2)) % 2.4 - 1.2;
        function pt(y, side) {
          var a = y * Math.PI * 2.1 + rot + side * Math.PI;
          var rad = 0.42 * (1 + P.s * lv * 0.35 * Math.sin(y * 6 - t * 9));
          var v = rotX([Math.cos(a) * rad, y * ys * 0.95, Math.sin(a) * rad], 0.18);
          var sc = F / (F + v[2]);
          return [cx + v[0] * R * sc, cy + v[1] * R * sc, 1 - (v[2] + 1) / 2];
        }
        c.lineWidth = dp * 0.8 * k;
        for (var i = 0; i < N; i++) {
          var y = -1 + (2 * i) / (N - 1), A = pt(y, 0), B = pt(y, 1);
          var hit = Math.exp(-Math.pow((y - sig) * 6, 2)) * (0.25 + P.k);
          c.strokeStyle = css(C, 0.08 + 0.18 * (A[2] + B[2]) / 2 + hit * 0.7 + P.l * lv * 0.25);
          c.beginPath(); c.moveTo(A[0], A[1]); c.lineTo(B[0], B[1]); c.stroke();
          if (hit > 0.15) { c.fillStyle = css(mix(C, [255, 255, 255], 0.5), hit); dot(c, (A[0] + B[0]) / 2, (A[1] + B[1]) / 2, 2 * dp * k); }
        }
        for (var side = 0; side < 2; side++) {
          for (var j = 0; j < N * S; j++) {
            var yy = -1 + (2 * j) / (N * S - 1), p = pt(yy, side), fade = 1 - Math.pow(Math.abs(yy), 6);
            c.fillStyle = css(C, (0.2 + 0.75 * p[2]) * fade);
            dot(c, p[0], p[1], (0.7 + 1.6 * p[2]) * dp * k);
          }
        }
      }
    },

    /* 9 — Bloom: layered petals that close as it listens and open as it speaks */
    bloom: {
      init: function (r, small) {
        var pts = [], layers = [{ n: 6, len: 1, off: 0, w: 0.34 }, { n: 6, len: 0.66, off: 0.5236, w: 0.3 }, { n: 5, len: 0.36, off: 0.2, w: 0.28 }];
        var per = small ? 40 : 110;
        layers.forEach(function (L, li) {
          for (var p = 0; p < L.n; p++) for (var i = 0; i < per; i++) {
            pts.push({ li: li, ang: L.off + (p / L.n) * 6.2832, len: L.len, s: Math.sqrt(r()), w: (r() * 2 - 1), wd: L.w, ph: r() * 6.283 });
          }
        });
        return { pts: pts, twirl: 0 };
      },
      draw: function (c, W, H, t, P, C, D) {
        var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.36, dp = D.dpr, lv = D.lv * P.s;
        D.twirl += D.dt * (0.08 + P.k * 1.1);
        var open = 0.62 + 0.06 * Math.sin(t * 0.9) - 0.28 * P.l + 0.4 * lv - 0.2 * P.k;
        var g = c.createRadialGradient(cx, cy, 0, cx, cy, R * 0.4);
        g.addColorStop(0, css(mix(C, [255, 255, 255], 0.5), 0.3 + 0.3 * lv)); g.addColorStop(1, css(C, 0));
        c.fillStyle = g; c.fillRect(0, 0, W, H);
        for (var i = 0; i < D.pts.length; i++) {
          var q = D.pts[i], s = q.s, len = q.len * (0.85 + 0.15 * open);
          var lx = s * len, ly = Math.sin(Math.PI * s) * q.wd * q.w * len, lz = -s * s * len * (1.2 - open * 1.1);
          var a = q.ang + D.twirl * (1 + q.li * 0.4);
          var ca = Math.cos(a), sa = Math.sin(a);
          var v = [lx * ca - ly * sa, lx * sa + ly * ca, lz];
          v = rotX(v, 0.55 + 0.05 * Math.sin(t * 0.3));
          var sc = F / (F + v[2]), z = 1 - (v[2] + 1) / 2;
          var edge = Math.abs(q.w) > 0.85 ? 0.35 : 0;
          c.fillStyle = css(mix(C, [255, 255, 255], (1 - s) * 0.4 + edge * 0.5), (0.25 + 0.55 * z) * (0.6 + 0.4 * Math.sin(t * 1.5 + q.ph)));
          dot(c, cx + v[0] * R * sc, cy + v[1] * R * sc, (0.6 + 1.1 * z) * dp * (D.small ? 0.7 : 1));
        }
      }
    },

    /* 10 — Swarm: fireflies that follow a wandering point of focus */
    swarm: {
      init: function (r, small) {
        var n = small ? 110 : 300, S = [];
        for (var i = 0; i < n; i++) S.push({ p: [(r() - 0.5) * 1.2, (r() - 0.5) * 1.2, (r() - 0.5) * 1.2], v: [0, 0, 0], ph: r() * 6.283, f: 0.6 + r() * 1.8, a: i % 3 });
        return { S: S, rr: r };
      },
      draw: function (c, W, H, t, P, C, D) {
        var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.32, dp = D.dpr, lv = D.lv, dt = Math.min(D.dt, 0.033);
        var spd = 0.5 + P.k * 1.6, roam = (1 - P.l * 0.85) * 0.55;
        var at = [];
        for (var k = 0; k < 3; k++) {
          var ph = t * spd * (0.7 + k * 0.23) + k * 2.1, spread = k === 0 ? 1 : P.k;
          at.push([Math.sin(ph * 1.3) * roam * spread, Math.sin(ph * 0.9 + 1) * roam * 0.7 * spread, Math.cos(ph * 1.1) * roam * spread]);
        }
        for (var i = 0; i < D.S.length; i++) {
          var q = D.S[i], A = at[P.k > 0.3 ? q.a : 0], d = [A[0] - q.p[0], A[1] - q.p[1], A[2] - q.p[2]];
          var dl = Math.hypot(d[0], d[1], d[2]) || 1e-3, pull = 2.2 + P.l * 2.5 - P.s * lv * 3.2;
          for (var j = 0; j < 3; j++) {
            q.v[j] += (d[j] / dl * pull + Math.sin(t * q.f + q.ph + j * 2) * 1.4) * dt;
            q.v[j] *= 1 - 1.6 * dt;
            q.p[j] += q.v[j] * dt;
          }
          var pl = Math.hypot(q.p[0], q.p[1], q.p[2]);
          if (pl > 1.1) for (j = 0; j < 3; j++) { q.p[j] *= 1.1 / pl; q.v[j] *= -0.4; }
        }
        for (i = 0; i < D.S.length; i++) {
          q = D.S[i];
          var v = rotY(q.p, D.ay * 0.6), sc = F / (F + v[2]), z = 1 - (v[2] + 1) / 2;
          var fl = Math.pow(0.5 + 0.5 * Math.sin(t * q.f * 2 + q.ph), 3);
          var br = (0.2 + 0.5 * z) * (0.35 + 0.65 * fl) + P.s * lv * 0.3;
          var x = cx + v[0] * R * sc, y = cy + v[1] * R * sc, s = (0.8 + 1.6 * z) * dp * (D.small ? 0.7 : 1);
          c.fillStyle = css(C, br * 0.25); dot(c, x, y, s * 3);
          c.fillStyle = css(mix(C, [255, 255, 255], 0.35 * fl), br); dot(c, x, y, s);
        }
      }
    }
    ,

    /* 11 — Aurora: curtains of light that sway, and brighten with the voice */
    aurora: {
      init: function (r, small) {
        var C = [];
        for (var c = 0; c < 4; c++) C.push({ ph: r() * 6.283, f: 1.6 + r() * 1.6, z: (c - 1.5) * 0.28 });
        return { C: C, N: small ? 46 : 110, K: small ? 5 : 8 };
      },
      draw: function (c, W, H, t, P, C, D) {
        var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.36, dp = D.dpr, lv = D.lv, N = D.N, K = D.K, sk = D.small ? 0.7 : 1;
        var spd = 0.5 + P.k * 1.8;
        for (var ci = 0; ci < D.C.length; ci++) {
          var Q = D.C[ci], cz = Q.z * (1 - 0.6 * P.l);
          for (var i = 0; i < N; i++) {
            var u = i / (N - 1) * 2 - 1, win = Math.exp(-u * u * 1.8);
            var top = -0.35 + 0.18 * Math.sin(u * Q.f + t * 0.3 + Q.ph);
            var wz = cz + 0.22 * Math.sin(u * 3 + t * spd + Q.ph);
            for (var k = 0; k < K; k++) {
              var y = top + k * (0.75 / K) * (1 + P.s * lv * 0.6 + P.l * lv * 0.2);
              var v = rotY([u * 1.15, y, wz], Math.sin(t * 0.1) * 0.35);
              v = rotX(v, 0.15);
              var sc = F / (F + v[2]), z = 1 - (v[2] + 1) / 2, fall = 1 - k / K;
              var shimmer = 0.6 + 0.4 * Math.sin(t * 2 + i * 0.4 + ci + k);
              c.fillStyle = css(mix(C, [255, 255, 255], k === 0 ? 0.5 : 0), (0.12 + 0.5 * z) * win * fall * shimmer * (1 + P.s * lv));
              dot(c, cx + v[0] * R * sc, cy + v[1] * R * sc, (0.6 + 1.2 * z) * dp * sk);
            }
          }
        }
      }
    },

    /* 12 — Pulsar: a beating core with two sweeping jets */
    pulsar: {
      init: function (r, small) {
        var J = [], n = small ? 70 : 180;
        for (var i = 0; i < n * 2; i++) J.push({ s: r(), a: r() * 6.283, w: r(), side: i < n ? 1 : -1, sp: 0.6 + r() * 0.8 });
        return { core: fib(small ? 260 : 700), J: J };
      },
      draw: function (c, W, H, t, P, C, D) {
        var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.3, dp = D.dpr, lv = D.lv, sk = D.small ? 0.7 : 1, i, v, sc, z;
        D.bt = (D.bt || 0) + D.dt * (2.2 + P.k * 4);
        var beat = Math.pow(Math.max(0, Math.sin(D.bt)), 10);
        var cs = 0.36 * (1 + beat * 0.12 + P.s * lv * 0.22 - P.l * 0.06);
        var g = c.createRadialGradient(cx, cy, 0, cx, cy, R * 0.9);
        g.addColorStop(0, css(mix(C, [255, 255, 255], 0.4), 0.25 + beat * 0.25 + P.s * lv * 0.2)); g.addColorStop(1, css(C, 0));
        c.fillStyle = g; c.fillRect(0, 0, W, H);
        for (i = 0; i < D.core.length; i++) {
          var p = D.core[i];
          v = rotX(rotY([p[0] * cs, p[1] * cs, p[2] * cs], D.ay), 0.3);
          sc = F / (F + v[2]); z = 1 - (v[2] + 1) / 2;
          c.fillStyle = css(C, 0.25 + 0.7 * z);
          dot(c, cx + v[0] * R * sc, cy + v[1] * R * sc, (0.5 + 1.1 * z) * dp * sk);
        }
        var len = 1.15 * (1 - 0.55 * P.l) * (1 + P.s * lv * 0.3), ax = 0.45, sweep = D.ay * 4;
        for (i = 0; i < D.J.length; i++) {
          var q = D.J[i];
          q.s += D.dt * q.sp * (0.35 + P.k * 0.9 + P.s * lv * 1.6);
          if (q.s > 1) { q.s -= 1; q.a = Math.random() * 6.283; }
          var d = cs + q.s * len, spread = q.s * 0.13 * q.w;
          v = [Math.cos(q.a) * spread, q.side * d, Math.sin(q.a) * spread];
          v = rotY(rotX(v, ax), sweep);
          v = rotX(v, 0.3);
          sc = F / (F + v[2]); z = 1 - (v[2] + 1) / 2;
          c.fillStyle = css(mix(C, [255, 255, 255], (1 - q.s) * 0.5), Math.pow(1 - q.s, 1.4) * (0.4 + 0.6 * z));
          dot(c, cx + v[0] * R * sc, cy + v[1] * R * sc, (0.6 + 1.4 * z) * dp * sk * (1 - q.s * 0.5));
        }
      }
    },

    /* 13 — Tesseract: a four-dimensional cube turning through itself */
    tesseract: {
      init: function (r, small) {
        var V = [], E = [], i, j, k;
        for (i = 0; i < 16; i++) V.push([i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1, i & 8 ? 1 : -1]);
        for (i = 0; i < 16; i++) for (j = i + 1; j < 16; j++) { var x = i ^ j; if ((x & (x - 1)) === 0) E.push([i, j]); }
        var S = [], per = small ? 5 : 11;
        E.forEach(function (e) { for (k = 1; k < per; k++) S.push([e[0], e[1], k / per]); });
        return { V: V, E: E, S: S, aw: 0 };
      },
      draw: function (c, W, H, t, P, C, D) {
        var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.3, dp = D.dpr, lv = D.lv, sk = D.small ? 0.7 : 1, i;
        D.aw += D.dt * (0.35 * (1 - 0.7 * P.l) + P.k * 1.1 + P.s * 0.15);
        var a = D.aw, b = D.aw * 0.6, ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
        var scl = 0.5 * (1 + P.s * lv * 0.16);
        var pr = D.V.map(function (p) {
          var x = p[0] * ca - p[3] * sa, w = p[0] * sa + p[3] * ca;
          var zz = p[2] * cb - w * sb; w = p[2] * sb + w * cb;
          var k = 1 / (2.4 - w);
          var v = rotX(rotY([x * k * scl * 1.6, p[1] * k * scl * 1.6, zz * k * scl * 1.6], D.ay), 0.4);
          var sc = F / (F + v[2]);
          return [cx + v[0] * R * sc, cy + v[1] * R * sc, 1 - (v[2] + 1) / 2, w];
        });
        for (i = 0; i < D.S.length; i++) {
          var s = D.S[i], A = pr[s[0]], B = pr[s[1]], f = s[2];
          var z = A[2] + (B[2] - A[2]) * f;
          c.fillStyle = css(C, 0.15 + 0.55 * z + P.k * 0.1);
          dot(c, A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, (0.5 + 1 * z) * dp * sk);
        }
        for (i = 0; i < pr.length; i++) {
          var q = pr[i], inner = (q[3] + 1) / 2;
          c.fillStyle = css(mix(C, [255, 255, 255], 0.3 + 0.3 * inner), 0.45 + 0.5 * q[2]);
          dot(c, q[0], q[1], (1.4 + 2 * q[2]) * dp * sk);
        }
      }
    },

    /* 14 — Knot: light flowing round a trefoil knot */
    knot: {
      init: function (r, small) {
        var n = small ? 280 : 760, K = [];
        for (var i = 0; i < n; i++) K.push({ u: (i / n) * 6.2832, o: [(r() - 0.5), (r() - 0.5), (r() - 0.5)], b: 0.5 + r() * 0.5 });
        return { K: K, flow: 0 };
      },
      draw: function (c, W, H, t, P, C, D) {
        var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.3, dp = D.dpr, lv = D.lv, sk = D.small ? 0.7 : 1;
        D.flow += D.dt * (0.18 + P.k * 1.1 + P.s * 0.2);
        var tube = 0.16 * (1 - 0.5 * P.l) * (1 + P.s * lv * 1.6);
        for (var i = 0; i < D.K.length; i++) {
          var q = D.K[i], u = q.u + D.flow;
          var x = (Math.sin(u) + 2 * Math.sin(2 * u)) / 3.1, y = (Math.cos(u) - 2 * Math.cos(2 * u)) / 3.1, zz = -Math.sin(3 * u) / 3.1;
          var v = [x + q.o[0] * tube, y + q.o[1] * tube, zz + q.o[2] * tube];
          v = rotX(rotY(v, D.ay), 0.45);
          var sc = F / (F + v[2]), z = 1 - (v[2] + 1) / 2;
          var glint = Math.pow(0.5 + 0.5 * Math.sin(u * 3 - t * 2), 6) * (0.3 + P.k);
          c.fillStyle = css(mix(C, [255, 255, 255], glint * 0.6), (0.2 + 0.7 * z) * q.b + glint * 0.3);
          dot(c, cx + v[0] * R * sc, cy + v[1] * R * sc, (0.6 + 1.2 * z) * dp * sk);
        }
      }
    },

    /* 15 — Ember: a glowing core that throws up sparks */
    ember: {
      init: function (r, small) {
        var S = [], n = small ? 110 : 320;
        for (var i = 0; i < n; i++) S.push({ life: r(), ph: r() * 6.283, d: fib(2)[0], dir: [r() - 0.5, -r() * 0.4, r() - 0.5], sp: 0.6 + r() * 0.8 });
        return { core: fib(small ? 160 : 420), S: S };
      },
      draw: function (c, W, H, t, P, C, D) {
        var cx = W / 2, cy = H / 2 + Math.min(W, H) * 0.12, R = Math.min(W, H) * 0.3, dp = D.dpr, lv = D.lv, sk = D.small ? 0.7 : 1, i, v, sc, z;
        var flick = 0.85 + 0.15 * Math.sin(t * 9) * Math.sin(t * 5.3);
        var cr = 0.24 * (1 + P.s * lv * 0.25 - P.l * 0.05);
        var g = c.createRadialGradient(cx, cy, 0, cx, cy, R * 0.8);
        g.addColorStop(0, css(mix(C, [255, 255, 255], 0.45), (0.3 + 0.25 * P.s * lv) * flick)); g.addColorStop(1, css(C, 0));
        c.fillStyle = g; c.fillRect(0, 0, W, H);
        for (i = 0; i < D.core.length; i++) {
          var p = D.core[i];
          v = rotY([p[0] * cr, p[1] * cr, p[2] * cr], D.ay * 2);
          sc = F / (F + v[2]); z = 1 - (v[2] + 1) / 2;
          c.fillStyle = css(mix(C, [255, 255, 255], 0.3), (0.3 + 0.6 * z) * flick);
          dot(c, cx + v[0] * R * sc, cy + v[1] * R * sc, (0.5 + 1 * z) * dp * sk);
        }
        var rise = 1.15 * (1 - 0.5 * P.l) * (1 + P.s * lv * 0.5);
        for (i = 0; i < D.S.length; i++) {
          var q = D.S[i];
          q.life += D.dt * q.sp * (0.28 + P.k * 0.5 + P.s * lv * 0.9 - P.l * 0.12);
          if (q.life > 1) { q.life -= 1; q.ph = Math.random() * 6.283; }
          var L = q.life, sw = Math.sin(q.ph + L * 5 + t) * 0.12 * L * (1 + P.k * 1.5);
          v = [q.dir[0] * cr * 1.6 + q.dir[0] * L * 0.5 + sw, -cr * 0.5 - L * rise, q.dir[2] * cr * 1.6 + q.dir[2] * L * 0.5 + Math.cos(q.ph + L * 4) * 0.08 * L];
          v = rotY(v, D.ay);
          sc = F / (F + v[2]); z = 1 - (v[2] + 1) / 2;
          c.fillStyle = css(mix(C, [255, 255, 255], (1 - L) * 0.55), Math.pow(1 - L, 1.5) * (0.5 + 0.5 * z));
          dot(c, cx + v[0] * R * sc, cy + v[1] * R * sc, (0.7 + 1.5 * (1 - L)) * dp * sk);
        }
      }
    },

    /* 16 — Tide: a field of light that ripples out as it speaks and in as it listens */
    tide: {
      init: function (r, small) {
        var G = small ? 20 : 40, pts = [];
        for (var i = 0; i < G; i++) for (var j = 0; j < G; j++) {
          var x = i / (G - 1) * 2 - 1, z = j / (G - 1) * 2 - 1;
          if (x * x + z * z <= 1) pts.push([x, z]);
        }
        return { pts: pts };
      },
      draw: function (c, W, H, t, P, C, D) {
        var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.4, dp = D.dpr, lv = D.lv, sk = D.small ? 0.7 : 1;
        var s1 = [Math.sin(t * 0.9) * 0.5, Math.cos(t * 0.7) * 0.5], s2 = [Math.cos(t * 1.1) * 0.5, Math.sin(t * 0.8) * 0.5];
        for (var i = 0; i < D.pts.length; i++) {
          var x = D.pts[i][0], zz = D.pts[i][1], r = Math.hypot(x, zz);
          var y = 0.05 * Math.sin(x * 3 + t) * Math.cos(zz * 3 + t * 0.8) * (1 - P.k)
            + P.s * (0.06 + lv * 0.22) * Math.sin(r * 11 - t * 7) * Math.exp(-r * 1.4)
            + P.l * (0.04 + lv * 0.12) * Math.sin(r * 11 + t * 6)
            + P.k * 0.07 * (Math.sin(Math.hypot(x - s1[0], zz - s1[1]) * 14 - t * 6) + Math.sin(Math.hypot(x - s2[0], zz - s2[1]) * 14 - t * 6));
          var v = rotX(rotY([x, -y, zz], D.ay * 0.5), 1.0);
          var sc = F / (F + v[2]), z = 1 - (v[2] + 1) / 2, hi = Math.max(0, y * 6);
          c.fillStyle = css(mix(C, [255, 255, 255], Math.min(0.6, hi)), (0.15 + 0.6 * z) * (1 - r * 0.5) + hi * 0.3);
          dot(c, cx + v[0] * R * sc, cy + v[1] * R * sc, (0.6 + 1.1 * z) * dp * sk);
        }
      }
    },

    /* 17 — Echo: shells of light that travel out as it speaks and in as it listens */
    echo: {
      init: function (r, small) { return { shell: fib(small ? 120 : 300), core: fib(small ? 80 : 200), ph: 0 }; },
      draw: function (c, W, H, t, P, C, D) {
        var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.3, dp = D.dpr, lv = D.lv, sk = D.small ? 0.7 : 1, i, k, v, sc, z;
        D.ph += D.dt * (0.12 + P.s * (0.25 + lv * 0.5) + P.l * 0.3 + P.k * 0.45);
        for (k = 0; k < 4; k++) {
          var p = (D.ph + k / 4) % 1, pp = P.l > 0.5 ? 1 - p : p;
          var rad = 0.22 + pp * 0.95, a = Math.sin(Math.PI * pp) * (0.5 + 0.5 * (P.s * lv + 0.4));
          for (i = 0; i < D.shell.length; i++) {
            var q = D.shell[i];
            v = rotX(rotY([q[0] * rad, q[1] * rad, q[2] * rad], D.ay + k * 0.7), 0.3 + k * 0.2);
            sc = F / (F + v[2]); z = 1 - (v[2] + 1) / 2;
            c.fillStyle = css(C, a * (0.2 + 0.7 * z));
            dot(c, cx + v[0] * R * sc, cy + v[1] * R * sc, (0.5 + 1 * z) * dp * sk);
          }
        }
        var cr = 0.2 * (1 + P.s * lv * 0.2);
        for (i = 0; i < D.core.length; i++) {
          var q2 = D.core[i];
          v = rotY([q2[0] * cr, q2[1] * cr, q2[2] * cr], -D.ay * 2);
          sc = F / (F + v[2]); z = 1 - (v[2] + 1) / 2;
          c.fillStyle = css(mix(C, [255, 255, 255], 0.35), 0.4 + 0.6 * z);
          dot(c, cx + v[0] * R * sc, cy + v[1] * R * sc, (0.6 + 1.1 * z) * dp * sk);
        }
      }
    },

    /* 18 — Shard: glass fragments orbiting a light; they scatter as it speaks */
    shard: {
      init: function (r, small) {
        var n = small ? 16 : 30, S = [];
        for (var i = 0; i < n; i++) {
          var th = r() * 6.283, ph = Math.acos(2 * r() - 1);
          S.push({ d: [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)], dist: 0.55 + r() * 0.4, size: 0.08 + r() * 0.1, spin: (0.4 + r()) * (r() < 0.5 ? -1 : 1), a0: r() * 6.283, tilt: r() * 3 });
        }
        return { S: S };
      },
      draw: function (c, W, H, t, P, C, D) {
        var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.32, dp = D.dpr, lv = D.lv, sk = D.small ? 0.7 : 1;
        var g = c.createRadialGradient(cx, cy, 0, cx, cy, R * 0.6);
        g.addColorStop(0, css(mix(C, [255, 255, 255], 0.5), 0.35 + 0.3 * P.s * lv + 0.1 * P.k)); g.addColorStop(1, css(C, 0));
        c.fillStyle = g; c.fillRect(0, 0, W, H);
        var spread = 1 + P.s * lv * 0.35 - P.l * 0.28;
        c.lineWidth = dp * 0.9 * sk;
        for (var i = 0; i < D.S.length; i++) {
          var q = D.S[i], ang = q.a0 + t * q.spin * (1 + P.k * 2.5);
          var ctr = [q.d[0] * q.dist * spread, q.d[1] * q.dist * spread, q.d[2] * q.dist * spread];
          var pts = [];
          for (var k = 0; k < 3; k++) {
            var a = ang + k * 2.094, l = [Math.cos(a) * q.size, Math.sin(a) * q.size, 0];
            l = rotX(l, q.tilt + t * 0.3);
            var v = rotX(rotY([ctr[0] + l[0], ctr[1] + l[1], ctr[2] + l[2]], D.ay), 0.3);
            var sc = F / (F + v[2]);
            pts.push([cx + v[0] * R * sc, cy + v[1] * R * sc, 1 - (v[2] + 1) / 2]);
          }
          var z = (pts[0][2] + pts[1][2] + pts[2][2]) / 3;
          c.fillStyle = css(C, 0.05 + 0.12 * z);
          c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); c.lineTo(pts[1][0], pts[1][1]); c.lineTo(pts[2][0], pts[2][1]); c.closePath(); c.fill();
          c.strokeStyle = css(mix(C, [255, 255, 255], 0.3), 0.25 + 0.6 * z);
          c.stroke();
        }
      }
    },

    /* 19 — Comet: comets with long tails circling a small star */
    comet: {
      init: function (r, small) {
        var M = [];
        for (var i = 0; i < 3; i++) {
          var ax = [r() - 0.5, r() * 0.6 + 0.4, r() - 0.5], al = Math.hypot(ax[0], ax[1], ax[2]);
          var n = ax.map(function (x) { return x / al; }), tmp = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
          var u = [n[1] * tmp[2] - n[2] * tmp[1], n[2] * tmp[0] - n[0] * tmp[2], n[0] * tmp[1] - n[1] * tmp[0]], ul = Math.hypot(u[0], u[1], u[2]);
          u = u.map(function (x) { return x / ul; });
          var w = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
          M.push({ u: u, w: w, a: r() * 6.283, sp: 0.7 + r() * 0.5, rad: 0.62 + i * 0.12 });
        }
        return { M: M, core: fib(small ? 90 : 220), L: small ? 36 : 90 };
      },
      draw: function (c, W, H, t, P, C, D) {
        var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.34, dp = D.dpr, lv = D.lv, sk = D.small ? 0.7 : 1, i, v, sc, z;
        var cr = 0.14 * (1 + P.s * lv * 0.3);
        for (i = 0; i < D.core.length; i++) {
          var p = D.core[i];
          v = rotY([p[0] * cr, p[1] * cr, p[2] * cr], D.ay);
          sc = F / (F + v[2]); z = 1 - (v[2] + 1) / 2;
          c.fillStyle = css(mix(C, [255, 255, 255], 0.4), 0.4 + 0.6 * z);
          dot(c, cx + v[0] * R * sc, cy + v[1] * R * sc, (0.6 + 1 * z) * dp * sk);
        }
        for (var m = 0; m < D.M.length; m++) {
          var Q = D.M[m];
          Q.a += D.dt * Q.sp * (0.55 + P.k * 1.8 + P.s * lv * 0.8);
          var rad = Q.rad * (1 - 0.3 * P.l) * (1 + P.s * lv * 0.12);
          for (var j = 0; j < D.L; j++) {
            var a = Q.a - j * 0.03, ca = Math.cos(a) * rad, sa = Math.sin(a) * rad, fd = 1 - j / D.L;
            v = [Q.u[0] * ca + Q.w[0] * sa, Q.u[1] * ca + Q.w[1] * sa, Q.u[2] * ca + Q.w[2] * sa];
            v = rotX(v, 0.25);
            sc = F / (F + v[2]); z = 1 - (v[2] + 1) / 2;
            c.fillStyle = css(mix(C, [255, 255, 255], fd * 0.6), Math.pow(fd, 1.6) * (0.4 + 0.6 * z));
            dot(c, cx + v[0] * R * sc, cy + v[1] * R * sc, ((j === 0 ? 2.6 : 0.5) + 1.6 * fd) * (0.6 + 0.6 * z) * dp * sk);
          }
        }
      }
    },

    /* 20 — Iris: a living aperture; it opens to listen and narrows to speak */
    iris: {
      init: function (r, small) {
        var F2 = [], n = small ? 48 : 110, per = small ? 7 : 14;
        for (var i = 0; i < n; i++) for (var k = 0; k < per; k++) F2.push({ a: (i / n) * 6.2832 + (r() - 0.5) * 0.04, f: (k + r() * 0.5) / per, ring: i % 2 });
        return { F: F2, spin: 0 };
      },
      draw: function (c, W, H, t, P, C, D) {
        var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.34, dp = D.dpr, lv = D.lv, sk = D.small ? 0.7 : 1;
        D.spin += D.dt * (0.05 + P.k * 0.9);
        var pupil = 0.3 + P.l * (0.08 + lv * 0.08) - P.s * lv * 0.1 - P.k * 0.05 + 0.015 * Math.sin(t * 0.9);
        var tx = Math.sin(t * 0.2) * 0.18, ty = Math.sin(t * 0.17) * 0.22;
        for (var i = 0; i < D.F.length; i++) {
          var q = D.F[i], r = pupil + q.f * (1 - pupil);
          var a = q.a + D.spin * (q.ring ? 1 : -1) * (1 - q.f * 0.5) + Math.sin(q.f * 6 + t) * 0.03;
          var v = rotY(rotX([Math.cos(a) * r, Math.sin(a) * r, -0.08 * (1 - q.f)], tx), ty);
          var sc = F / (F + v[2]), near = 1 - q.f;
          c.fillStyle = css(mix(C, [255, 255, 255], near * near * 0.6), 0.15 + 0.7 * near * near + P.s * lv * 0.15);
          dot(c, cx + v[0] * R * sc, cy + v[1] * R * sc, (0.6 + 1.3 * near) * dp * sk);
        }
      }
    }
  };

  /* The app's own loudness rhythm (core.ts voice()). */
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

var MODES = ['idle', 'listening', 'thinking', 'speaking'];
var SPIN = { idle: 0.12, listening: 0.16, thinking: 0.7, speaking: 0.22 };
var SHIFT_S = 1.0;
function smooth(v) { return v * v * v * (v * (v * 6 - 15) + 10); }

/** Samples a design for the screen-to-screen flow: runs its own drawing into a recorder instead of a canvas, and returns
 * every dot it would draw (centre, size, colour) and every line, in units of the core's radius (0.29 of the canvas
 * height, as everywhere in the app). The order is the same every frame, so dot i can be followed across the screen. */
export function sampleDesign(design, small) {
  var style = STYLES[design] ? design : 'prism';
  var D = STYLES[style].init(Math.random, !!small);
  D.small = !!small; D.ay = 0.6; D.dpr = 1;
  var w = { idle: 1, listening: 0, thinking: 0, speaking: 0 };
  return {
    take: function (t, dt, hue) {
      var S = 600, R = S * 0.29, pts = [], segs = [], fs = '', ss = '', path = [], arcAt = null;
      var rec = {
        set fillStyle(v) { fs = v; }, get fillStyle() { return fs; },
        set strokeStyle(v) { ss = v; }, get strokeStyle() { return ss; },
        lineWidth: 1, globalCompositeOperation: '', globalAlpha: 1,
        setTransform: function () {}, clearRect: function () {}, closePath: function () {},
        createRadialGradient: function () { return { addColorStop: function () {} }; },
        beginPath: function () { path = []; arcAt = null; },
        moveTo: function (x, y) { path.push([x, y, 0]); }, lineTo: function (x, y) { path.push([x, y, 1]); },
        arc: function (x, y, r) { arcAt = [x, y, r]; },
        fill: function () { if (arcAt && typeof fs === 'string') pts.push({ x: (arcAt[0] - S / 2) / R, y: (arcAt[1] - S / 2) / R, s: arcAt[2] * 2, c: fs }); arcAt = null; },
        stroke: function () {
          if (arcAt) { arcAt = null; return; }
          for (var i = 1; i < path.length; i++) if (path[i][2]) segs.push({ x1: (path[i - 1][0] - S / 2) / R, y1: (path[i - 1][1] - S / 2) / R, x2: (path[i][0] - S / 2) / R, y2: (path[i][1] - S / 2) / R, c: ss });
        },
        fillRect: function (x, y, ww, h) { if (typeof fs === 'string' && ww < 24) pts.push({ x: (x + ww / 2 - S / 2) / R, y: (y + h / 2 - S / 2) / R, s: ww, c: fs }); },
      };
      D.dt = dt; D.w = w; D.lv = 0; D.ay += dt * 0.12;
      STYLES[style].draw(rec, S, S, t, { spin: 0.12, l: 0, k: 0, s: 0 }, hsl(hue, 90, 74), D);
      return { pts: pts, segs: segs };
    },
  };
}

/** The designs this file can draw. */
export var DESIGN_STYLES = Object.keys(STYLES);

/** Starts a design on a canvas. Same handle as startCore: stop, setMode, setShift, setLevel, state. */
export function runDesign(canvas, design, getHue, opts) {
  opts = opts || {};
  var style = STYLES[design] ? design : 'prism';
  var ctx = canvas.getContext('2d');
  var mode = opts.mode || 'idle';
  var w = { idle: 0, listening: 0, thinking: 0, speaking: 0 }; w[mode] = 1;
  var P = { spin: SPIN[mode], l: 0, k: 0, s: 0 }, D = null, raf = 0, last = 0, t = 0, lv = 0, level = null, alive = true;
  var shiftFrom = 0, shiftTo = 0, shiftAt = -1e9;
  function frame(now) {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    var dt = last ? Math.min(0.05, Math.max(0, (now - last) / 1000)) : 0.016; last = now;
    if (!RM) t += dt;
    var cw = canvas.clientWidth, ch = canvas.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!cw || !ch || !ctx) return;
    var Wp = Math.round(cw * dpr), Hp = Math.round(ch * dpr);
    if (canvas.width !== Wp || canvas.height !== Hp) { canvas.width = Wp; canvas.height = Hp; }
    if (!D) { D = STYLES[style].init(Math.random, Math.min(cw, ch) < 260); D.small = Math.min(cw, ch) < 260; D.ay = Math.random() * 6; }
    var ease = RM ? 1 : 1 - Math.exp(-dt * 3.2);
    for (var i = 0; i < 4; i++) { var m = MODES[i]; w[m] += ((m === mode ? 1 : 0) - w[m]) * ease; }
    var goal = level != null ? level : mode === 'speaking' ? voice(t, 0) : mode === 'listening' ? voice(t * 0.9, 2.1) : 0;
    lv += (goal - lv) * (1 - Math.exp(-dt * (goal > lv ? 18 : 6)));
    P.l = w.listening; P.k = w.thinking; P.s = w.speaking;
    P.spin = SPIN.idle * w.idle + SPIN.listening * w.listening + SPIN.thinking * w.thinking + SPIN.speaking * w.speaking;
    var sd = RM ? 0 : dt;
    D.ay += sd * P.spin; D.dpr = dpr; D.dt = sd; D.w = w; D.lv = lv;
    var since = (now - shiftAt) / 1000, dx = shiftTo;
    if (!RM && since < SHIFT_S) dx = shiftFrom + (shiftTo - shiftFrom) * smooth(Math.max(0, Math.min(1, since / SHIFT_S)));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, Wp, Hp);
    ctx.setTransform(1, 0, 0, 1, dx * dpr, 0);
    ctx.globalCompositeOperation = 'lighter';
    STYLES[style].draw(ctx, Wp, Hp, t, P, hsl(getHue(), 90, 74), D);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }
  raf = requestAnimationFrame(frame);
  return {
    stop: function () { alive = false; cancelAnimationFrame(raf); },
    setMode: function (m) { mode = m; },
    setLevel: function (v) { level = v == null ? null : Math.max(0, Math.min(1, v)); },
    state: function () { return { w: w, level: lv, t: t }; },
    setShift: function (v) {
      if (v === shiftTo) return;
      var since = (performance.now() - shiftAt) / 1000;
      shiftFrom = since >= SHIFT_S ? shiftTo : shiftFrom + (shiftTo - shiftFrom) * smooth(Math.max(0, Math.min(1, since / SHIFT_S)));
      shiftTo = v; shiftAt = performance.now();
    },
  };
}
