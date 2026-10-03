/* InsertPress Planner — shaded part thumbnails without WebGL.
 * A small z-buffer rasterizer, isometric from the front left. It draws both
 * sides of every triangle, so meshes with flipped winding still show. It is lit
 * like the 3D view (sky light plus a key light from the left), with
 * screen-space ambient occlusion so holes and inside corners read dark, crease
 * and outline lines, and a soft contact shadow. Rendered at 2x and scaled down
 * for smooth edges. The background is transparent; the dark stage comes from CSS.
 * render(positions, w, h, opts) returns a PNG data URL.
 */
(function () {
  'use strict';
  const IP = window.IP;
  const EL = (32 * Math.PI) / 180;
  const R = [Math.SQRT1_2, -Math.SQRT1_2, 0]; // screen right
  const U = [Math.sin(EL) * Math.SQRT1_2, Math.sin(EL) * Math.SQRT1_2, Math.cos(EL)]; // screen up
  const V = [Math.cos(EL) * Math.SQRT1_2, Math.cos(EL) * Math.SQRT1_2, -Math.sin(EL)]; // into the screen
  const KEY = (() => { const l = [-0.6, -0.3, 0.8]; const n = Math.hypot(...l); return l.map((v) => v / n); })();
  const SS = 2; // supersampling

  /** Fill every triangle's screen coverage (no depth) into a mask. */
  function cover(mask, mw, mh, ax, ay, bx, by, cx, cy) {
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) return;
    const inv = 1 / area;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(mw - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(mh - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) {
      const sy = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const sx = x + 0.5;
        const w0 = ((bx - sx) * (cy - sy) - (by - sy) * (cx - sx)) * inv;
        const w1 = ((cx - sx) * (ay - sy) - (cy - sy) * (ax - sx)) * inv;
        if (w0 >= -1e-4 && w1 >= -1e-4 && 1 - w0 - w1 >= -1e-4) mask[y * mw + x] = 1;
      }
    }
  }

  /** Three box-blur passes each way: close to a Gaussian. */
  function blur(src, w, h, r) {
    let a = src, b = new Float32Array(w * h);
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < h; y++) {
        let acc = 0;
        const row = y * w;
        for (let x = -r; x <= r; x++) acc += a[row + Math.min(w - 1, Math.max(0, x))];
        for (let x = 0; x < w; x++) {
          b[row + x] = acc / (2 * r + 1);
          acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
        }
      }
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let y = -r; y <= r; y++) acc += b[Math.min(h - 1, Math.max(0, y)) * w + x];
        for (let y = 0; y < h; y++) {
          a[y * w + x] = acc / (2 * r + 1);
          acc += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
        }
      }
    }
    return a;
  }

  function render(pos, w, h, opts) {
    opts = opts || {};
    const dpr = 2;
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    const BW = W * SS, BH = H * SS, NP = BW * BH;
    const n = (pos.length / 9) | 0;
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    if (!n) return out.toDataURL('image/png');

    // project every vertex, and its footprint on the bed (z = 0) for the shadow
    const nv = n * 3;
    const px = new Float32Array(nv), py = new Float32Array(nv), pz = new Float32Array(nv), fy = new Float32Array(nv);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < nv; i++) {
      const X = pos[i * 3], Y = pos[i * 3 + 1], Z = pos[i * 3 + 2];
      const sx = R[0] * X + R[1] * Y;
      const sy = -(U[0] * X + U[1] * Y + U[2] * Z);
      px[i] = sx; py[i] = sy; pz[i] = V[0] * X + V[1] * Y + V[2] * Z;
      fy[i] = -(U[0] * X + U[1] * Y);
      if (sx < x0) x0 = sx; if (sx > x1) x1 = sx;
      if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
      if (fy[i] > y1) y1 = fy[i];
    }
    const pad = (opts.pad == null ? 8 : opts.pad) * dpr * SS;
    const bw = Math.max(1e-6, x1 - x0), bh = Math.max(1e-6, y1 - y0);
    const k = Math.min((BW - 2 * pad) / bw, (BH - 2 * pad) / bh);
    const ox = (BW - bw * k) / 2 - x0 * k, oy = (BH - bh * k) / 2 - y0 * k;
    for (let i = 0; i < nv; i++) { px[i] = px[i] * k + ox; py[i] = py[i] * k + oy; fy[i] = fy[i] * k + oy; }
    const mmpp = 1 / k; // mm of depth per buffer pixel

    // rasterize: nearest triangle per pixel, flat lit
    const zb = new Float32Array(NP).fill(Infinity);
    const tb = new Int32Array(NP).fill(-1);
    const lit = new Float32Array(n), nn = new Float32Array(n * 3), gx = new Float32Array(n), gy = new Float32Array(n);
    for (let t = 0; t < n; t++) {
      const b = t * 9;
      const ux = pos[b + 3] - pos[b], uy = pos[b + 4] - pos[b + 1], uz = pos[b + 5] - pos[b + 2];
      const vx = pos[b + 6] - pos[b], vy = pos[b + 7] - pos[b + 1], vz = pos[b + 8] - pos[b + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz);
      if (!l) continue;
      nx /= l; ny /= l; nz /= l;
      if (V[0] * nx + V[1] * ny + V[2] * nz > 0) { nx = -nx; ny = -ny; nz = -nz; } // the side facing us
      nn[t * 3] = nx; nn[t * 3 + 1] = ny; nn[t * 3 + 2] = nz;
      const key = Math.max(0, KEY[0] * nx + KEY[1] * ny + KEY[2] * nz);
      lit[t] = 0.34 + 0.14 * (1 + nz) + 0.4 * key;
      const i0 = t * 3;
      const ax = px[i0], ay = py[i0], az = pz[i0];
      const bx = px[i0 + 1], by = py[i0 + 1], bz = pz[i0 + 1];
      const cx = px[i0 + 2], cy = py[i0 + 2], cz = pz[i0 + 2];
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-9) continue; // seen edge-on
      const inv = 1 / area;
      // depth as a plane in screen space: z = az + gzx (x - ax) + gzy (y - ay)
      const gzx = ((bz - az) * (cy - ay) - (by - ay) * (cz - az)) * inv;
      const gzy = ((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) * inv;
      gx[t] = gzx; gy[t] = gzy;
      const mx0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), mx1 = Math.min(BW - 1, Math.ceil(Math.max(ax, bx, cx)));
      const my0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), my1 = Math.min(BH - 1, Math.ceil(Math.max(ay, by, cy)));
      let hit = false;
      for (let y = my0; y <= my1; y++) {
        const sy = y + 0.5;
        for (let x = mx0; x <= mx1; x++) {
          const sx = x + 0.5;
          const w0 = ((bx - sx) * (cy - sy) - (by - sy) * (cx - sx)) * inv;
          const w1 = ((cx - sx) * (ay - sy) - (cy - sy) * (ax - sx)) * inv;
          if (w0 < -1e-4 || w1 < -1e-4 || 1 - w0 - w1 < -1e-4) continue;
          hit = true;
          const z = az + gzx * (sx - ax) + gzy * (sy - ay);
          const i = y * BW + x;
          if (z < zb[i]) { zb[i] = z; tb[i] = t; }
        }
      }
      if (!hit && mx1 - mx0 <= 2 && my1 - my0 <= 2) {
        // smaller than a pixel: keep its centre so dense meshes don't get pinholes
        const x = Math.min(BW - 1, Math.max(0, Math.floor((ax + bx + cx) / 3))), y = Math.min(BH - 1, Math.max(0, Math.floor((ay + by + cy) / 3)));
        const z = (az + bz + cz) / 3, i = y * BW + x;
        if (z < zb[i]) { zb[i] = z; tb[i] = t; }
      }
    }

    // ambient occlusion: a neighbour nearer than this pixel's own plane shades it
    const rad = Math.max(3, Math.round(Math.min(BW, BH) * 0.022));
    const NS = 12, sdx = new Int32Array(NS), sdy = new Int32Array(NS);
    for (let s = 0; s < NS; s++) {
      const a = (s / NS) * Math.PI * 2 + (s % 2) * 0.26, r = rad * (s % 2 ? 0.5 : 1);
      sdx[s] = Math.round(Math.cos(a) * r); sdy[s] = Math.round(Math.sin(a) * r);
    }
    const eps = mmpp * 0.75, range = rad * mmpp * 3;
    const shade = new Float32Array(NP);
    for (let y = 0; y < BH; y++) {
      for (let x = 0; x < BW; x++) {
        const i = y * BW + x, t = tb[i];
        if (t < 0) continue;
        const d = zb[i], a = gx[t], b = gy[t];
        let occ = 0, cnt = 0;
        for (let s = 0; s < NS; s++) {
          const dx = sdx[s], dy = sdy[s], xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= BW || yy >= BH) continue;
          cnt++;
          const j = yy * BW + xx;
          if (tb[j] < 0) continue;
          const diff = d + a * dx + b * dy - zb[j];
          if (diff > eps && diff < range) occ += 1 - (diff / range) * 0.5;
        }
        const ao = cnt ? Math.min(1, (occ / cnt) * 1.6) : 0;
        // lines: outline against the stage, creases between faces, steps in depth
        let e = 1;
        const n0 = t * 3;
        for (let q = 0; q < 4; q++) {
          const xx = x + (q === 0 ? 1 : q === 1 ? -1 : 0), yy = y + (q === 2 ? 1 : q === 3 ? -1 : 0);
          const j = xx < 0 || yy < 0 || xx >= BW || yy >= BH ? -1 : yy * BW + xx;
          const tj = j < 0 ? -1 : tb[j];
          if (tj < 0) { e = Math.min(e, 0.82); continue; }
          if (tj === t) continue;
          const nd = nn[n0] * nn[tj * 3] + nn[n0 + 1] * nn[tj * 3 + 1] + nn[n0 + 2] * nn[tj * 3 + 2];
          if (nd < 0.86) e = Math.min(e, 0.7);
          if (zb[j] - (d + a * (xx - x) + b * (yy - y)) > mmpp * 4) e = Math.min(e, 0.6);
        }
        shade[i] = lit[t] * (1 - 0.62 * ao) * e;
      }
    }

    // contact shadow: the footprint on the bed, blurred, nudged down the screen
    const mask = new Float32Array(W * H);
    const drop = Math.max(1, Math.round(Math.min(W, H) * 0.025));
    for (let t = 0; t < n; t++) {
      const i0 = t * 3;
      cover(mask, W, H, px[i0] / SS, fy[i0] / SS + drop, px[i0 + 1] / SS, fy[i0 + 1] / SS + drop, px[i0 + 2] / SS, fy[i0 + 2] / SS + drop);
    }
    const soft = blur(mask, W, H, Math.max(2, Math.round(Math.min(W, H) * 0.035)));

    const base = opts.color || [236, 239, 240];
    const big = document.createElement('canvas');
    big.width = BW; big.height = BH;
    const bx = big.getContext('2d');
    const img = bx.createImageData(BW, BH);
    const D = img.data;
    for (let y = 0; y < BH; y++) {
      for (let x = 0; x < BW; x++) {
        const i = y * BW + x, o = i * 4;
        if (tb[i] >= 0) {
          const v = shade[i];
          D[o] = Math.min(255, base[0] * v); D[o + 1] = Math.min(255, base[1] * v); D[o + 2] = Math.min(255, base[2] * v); D[o + 3] = 255;
        } else {
          const s = soft[(y >> 1) * W + (x >> 1)];
          D[o] = 4; D[o + 1] = 7; D[o + 2] = 9; D[o + 3] = Math.round(Math.min(1, s * 1.25) * 205);
        }
      }
    }
    bx.putImageData(img, 0, 0);
    const ox2 = out.getContext('2d');
    ox2.imageSmoothingEnabled = true;
    ox2.imageSmoothingQuality = 'high';
    ox2.drawImage(big, 0, 0, W, H);
    return out.toDataURL('image/png');
  }

  IP.thumb = { render };
})();
