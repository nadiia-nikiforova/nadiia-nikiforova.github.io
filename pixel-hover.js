/* Pixel hover for the story game card, drawn the way the game is: a cloud
   of cells grows around the pointer and lives by the Game of Life, in 3
   textures (solid, dithered and outlined) and in the cover's own colours.
   It spills past the card's edges and dies away when the pointer leaves.
   Cards opt in with data-pixel. Off for touch and for reduced motion, which
   keep the normal card hover. */
(() => {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const BLEED = 140;   // room past the cover's edges for the cells to spill into
  const RADIUS = 90;   // how far the pointer reaches

  // Draw an image into a box the way object-fit: cover does.
  function fitCover(g, img, x, y, w, h, posX, posY) {
    const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    g.drawImage(img, x + (w - dw) * posX, y + (h - dh) * posY, dw, dh);
  }

  // The grid covers the card and the room around it, so the cloud
  // spills past the edges. Cells step at a fixed beat, not every frame, so
  // the cloud moves in chunky steps like the game, never a smooth blur.
  const LIFE_CELL = 8;   // cell size, CSS px
  const DOT = 2;         // dither square inside a cell
  const BEAT = 80;       // ms per generation
  const TONES = 5;       // flat colours taken from the cover's gradient

  const rgb = (c) => `rgb(${c.map(Math.round).join(',')})`;
  const dist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  function nearest(palette, c) {
    let best = 0;
    for (let t = 1; t < palette.length; t++) if (dist(palette[t], c) < dist(palette[best], c)) best = t;
    return best;
  }
  // A few rounds of k-means: the handful of colours that best stand for all
  // the samples, started from samples spread evenly through the list.
  function flatTones(samples, count) {
    let palette = Array.from({ length: count }, (_, t) => samples[Math.floor((t + 0.5) * samples.length / count)].slice());
    for (let round = 0; round < 8; round++) {
      const sum = palette.map(() => [0, 0, 0, 0]);
      for (const c of samples) {
        const s = sum[nearest(palette, c)];
        s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; s[3]++;
      }
      palette = palette.map((p, t) => (sum[t][3] ? sum[t].slice(0, 3).map((v) => v / sum[t][3]) : p));
    }
    return palette;
  }

  function setupLife(card) {
    const cover = card.querySelector('.cover');
    const canvas = document.createElement('canvas');
    canvas.className = 'cover__pixels';
    canvas.setAttribute('aria-hidden', 'true');
    card.append(canvas);
    card.classList.add('card--pixel');
    const ctx = canvas.getContext('2d');

    let cols = 0, rows = 0, floor = 0, ready = false;
    let alive, next, age, span, energy, heat, accent, edge, blocked, tone, inks, papers, solids, dithers;
    let W = 0, H = 0, round = 0, shots = [];   // the cover, and the screenshots on it
    let bx = BLEED;   // room at the sides: less where the cover already reaches the screen edge
    let px = -1e4, py = -1e4, mvx = 0, mvy = 0, inside = false;
    let raf = 0, beat = 0;

    // A cell drawn once at full resolution, then stamped wherever it lives.
    function sprite(dpr, paint) {
      const s = document.createElement('canvas');
      s.width = s.height = LIFE_CELL * dpr;
      const g = s.getContext('2d');
      g.scale(dpr, dpr);
      paint(g);
      return s;
    }

    function build() {
      const art = cover.querySelector('.cover__img');
      if (!art.complete || !art.naturalWidth) return false;
      W = cover.clientWidth; H = cover.clientHeight;
      round = parseFloat(getComputedStyle(cover).borderTopLeftRadius) || 0;
      // Cells live on the artwork only, never on a screenshot.
      shots = [...cover.querySelectorAll('.cover__inset')].map((el) => {
        const cs = getComputedStyle(el);
        const m = new DOMMatrix(cs.transform === 'none' ? undefined : cs.transform);
        return {
          cx: el.offsetLeft + el.offsetWidth / 2, cy: el.offsetTop + el.offsetHeight / 2,
          w: el.offsetWidth, h: el.offsetHeight, a: Math.atan2(m.b, m.a),
          r: parseFloat(cs.borderTopLeftRadius) || 0,
        };
      });
      // A cover that already runs edge to edge (the game band) gets no room
      // at the sides: pixels past the screen edge would only make the page
      // scroll sideways.
      const box = cover.getBoundingClientRect();
      bx = Math.max(0, Math.min(BLEED, box.left, document.documentElement.clientWidth - box.right));
      const dpr = window.devicePixelRatio || 1;
      Object.assign(canvas.style, {
        left: `${cover.offsetLeft - bx}px`, top: `${cover.offsetTop - BLEED}px`,
        width: `${W + bx * 2}px`, height: `${H + BLEED * 2}px`,
      });
      canvas.width = Math.round((W + bx * 2) * dpr);
      canvas.height = Math.round((H + BLEED * 2) * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // origin at the canvas corner, BLEED outside the cover
      floor = BLEED + H + 16;   // the cloud may spill only a little below, onto the title

      cols = Math.ceil((W + bx * 2) / LIFE_CELL); rows = Math.ceil((H + BLEED * 2) / LIFE_CELL);
      const n = cols * rows;
      alive = new Uint8Array(n); next = new Uint8Array(n); age = new Uint8Array(n);
      span = new Uint8Array(n); energy = new Float32Array(n); accent = new Uint8Array(n); edge = new Float32Array(n); heat = new Float32Array(n);
      blocked = new Uint8Array(n);
      for (let k = 0; k < n; k++) {
        const i = k % cols, j = (k - i) / cols;
        blocked[k] = onShot(i * LIFE_CELL + LIFE_CELL / 2 - bx, j * LIFE_CELL + LIFE_CELL / 2 - BLEED) ? 1 : 0;
        span[k] = 4 + Math.floor(Math.random() * 9);   // each cell lives 4 to 12 beats
        accent[k] = Math.random() < 0.07 ? 1 : 0;      // a few cells go solid
        edge[k] = Math.random();                       // ragged rim of the core
      }

      // Colours from the cover's own gradient: sample it under every cell
      // (cells past the edge take the nearest edge colour), then boil the
      // samples down to a few flat tones, like the game's palette.
      const sw = Math.ceil(W / LIFE_CELL), sh = Math.ceil(H / LIFE_CELL);
      const sc = document.createElement('canvas');
      sc.width = sw; sc.height = sh;
      const sg = sc.getContext('2d', { willReadFrequently: true });
      fitCover(sg, art, 0, 0, sw, sh, 0.5, 0.5);
      const data = sg.getImageData(0, 0, sw, sh).data;
      const sample = new Array(n);
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const ci = Math.min(sw - 1, Math.max(0, Math.floor((i * LIFE_CELL + LIFE_CELL / 2 - bx) / LIFE_CELL)));
        const cj = Math.min(sh - 1, Math.max(0, Math.floor((j * LIFE_CELL + LIFE_CELL / 2 - BLEED) / LIFE_CELL)));
        const q = (cj * sw + ci) * 4;
        sample[j * cols + i] = [data[q], data[q + 1], data[q + 2]];
      }
      const palette = flatTones(sample, TONES);
      tone = new Uint8Array(n);
      for (let k = 0; k < n; k++) tone[k] = nearest(palette, sample[k]);

      // Each tone gets a deeper ink, so the cells read against the cover,
      // and a paler ground for the checker and the outlined cells.
      inks = palette.map((c) => {
        const m = (c[0] + c[1] + c[2]) / 3;
        return rgb(c.map((v) => Math.min(255, Math.max(0, m + (v - m) * 3.2)) * 0.82));
      });
      papers = palette.map((c) => rgb(c.map((v) => v + (255 - v) * 0.4)));
      solids = inks.map((ink) => sprite(dpr, (g) => { g.fillStyle = ink; g.fillRect(0, 0, LIFE_CELL, LIFE_CELL); }));
      dithers = inks.map((ink, t) => sprite(dpr, (g) => {
        g.fillStyle = papers[t]; g.fillRect(0, 0, LIFE_CELL, LIFE_CELL);
        g.fillStyle = ink;
        for (let y = 0; y < LIFE_CELL; y += DOT) for (let x = 0; x < LIFE_CELL; x += DOT)
          if ((x + y) / DOT % 2 === 0) g.fillRect(x, y, DOT, DOT);
      }));
      return true;
    }

    // Is this point (cover coordinates) on a screenshot? Only where the
    // screenshot shows: past the cover's edge it is cut off, so the gradient
    // room around the card stays open to the cells.
    function onShot(x, y) {
      if (x < 0 || y < 0 || x > W || y > H) return false;
      return shots.some((s) => {
        const dx = x - s.cx, dy = y - s.cy, c = Math.cos(s.a), n = Math.sin(s.a);
        return Math.abs(dx * c + dy * n) <= s.w / 2 && Math.abs(dy * c - dx * n) <= s.h / 2;
      });
    }

    // One generation: seed around the pointer, then the Game of Life rules.
    // The pointer leaves heat behind it, and cells can only live where it is
    // warm, so the cloud keeps the shape of the path and never takes over
    // the page. An age limit makes sure nothing lingers once it has gone.
    function step() {
      const speed = Math.min(20, Math.hypot(mvx, mvy));
      if (inside) {
        const reach = RADIUS * (0.85 + speed / 60);   // faster moves spread wider, up to a point
        const cx = px + bx, cy = py + BLEED;
        const i0 = Math.max(0, Math.floor((cx - reach) / LIFE_CELL)), i1 = Math.min(cols - 1, Math.floor((cx + reach) / LIFE_CELL));
        const j0 = Math.max(0, Math.floor((cy - reach) / LIFE_CELL)), j1 = Math.min(rows - 1, Math.floor((cy + reach) / LIFE_CELL));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const d = Math.hypot(i * LIFE_CELL + LIFE_CELL / 2 - cx, j * LIFE_CELL + LIFE_CELL / 2 - cy);
          if (d >= reach || j * LIFE_CELL > floor || blocked[j * cols + i]) continue;
          const f = 1 - d / reach, k = j * cols + i;
          heat[k] = Math.max(heat[k], f);
          if (Math.random() < f * (0.22 + speed * 0.01)) { if (!alive[k]) age[k] = 0; alive[k] = 1; }
          // The core near the pointer holds steady, so it reads as a shape,
          // with a ragged rim instead of a circle.
          if (d < reach * (0.38 + 0.22 * edge[k])) energy[k] = Math.max(energy[k], 0.86);
        }
      }

      let busy = false;
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        let nb = 0;
        for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
          if (!a && !b) continue;
          const ii = i + a, jj = j + b;
          if (ii >= 0 && jj >= 0 && ii < cols && jj < rows) nb += alive[jj * cols + ii];
        }
        let live = alive[k] ? nb === 2 || nb === 3 : nb === 3 && heat[k] > 0.2;
        if (heat[k] < 0.06 || blocked[k]) live = false;
        heat[k] = Math.max(0, heat[k] - 0.05);
        if (live && alive[k] && age[k] >= span[k]) live = false;
        next[k] = live ? 1 : 0;
        age[k] = live ? (alive[k] ? age[k] + 1 : 0) : 0;
        // Energy smooths the flicker: a cell darkens over a few beats and
        // fades out through the textures, solid to dithered to outline.
        energy[k] = live ? Math.min(1, energy[k] + 0.34) : Math.max(0, energy[k] - 0.1);
        if (energy[k] > 0 || live || heat[k] > 0) busy = true;
      }
      [alive, next] = [next, alive];
      mvx *= 0.4; mvy *= 0.4;   // a resting pointer calms down
      return busy;
    }

    function draw() {
      ctx.clearRect(0, 0, cols * LIFE_CELL, rows * LIFE_CELL);
      const outlines = inks.map(() => new Path2D());
      for (let k = 0; k < energy.length; k++) {
        const e = energy[k];
        if (e <= 0.1) continue;
        const i = k % cols, j = (k - i) / cols, x = i * LIFE_CELL, y = j * LIFE_CELL, t = tone[k];
        if (e > 0.8 && accent[k]) ctx.drawImage(solids[t], x, y, LIFE_CELL, LIFE_CELL);
        else if (e > 0.45) ctx.drawImage(dithers[t], x, y, LIFE_CELL, LIFE_CELL);
        else { ctx.fillStyle = papers[t]; ctx.fillRect(x, y, LIFE_CELL, LIFE_CELL); outlines[t].rect(x + 0.5, y + 0.5, LIFE_CELL, LIFE_CELL); }
      }
      // Outlines last, one pass per tone, so neighbours share one thin line.
      ctx.lineWidth = 1;
      outlines.forEach((path, t) => { ctx.strokeStyle = inks[t]; ctx.stroke(path); });

      // Cut the screenshots out exactly, along their angled edges, so the
      // cells sit in the gradient behind them and never cover the interface.
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath(); ctx.roundRect(bx, BLEED, W, H, round); ctx.clip();
      for (const s of shots) {
        ctx.save();
        ctx.translate(bx + s.cx, BLEED + s.cy); ctx.rotate(s.a);
        ctx.beginPath(); ctx.roundRect(-s.w / 2, -s.h / 2, s.w, s.h, s.r); ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }

    function frame(now) {
      let busy = true;
      if (now - beat >= BEAT) { beat = now; busy = step() || inside; draw(); }
      raf = busy ? requestAnimationFrame(frame) : 0;
    }

    function track(e) {
      if (!ready && !(ready = build())) return;
      const r = cover.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const was = inside;
      // Only the gradient reacts: over a screenshot the cloud just dies away.
      inside = x >= 0 && y >= 0 && x <= r.width && y <= r.height && !onShot(x, y);
      mvx = was ? x - px : 0; mvy = was ? y - py : 0;
      px = x; py = y;
      if (!raf) raf = requestAnimationFrame(frame);
    }

    card.addEventListener('pointermove', track);
    card.addEventListener('pointerleave', () => { inside = false; });
    new ResizeObserver(() => { ready = false; }).observe(cover);
  }

  document.querySelectorAll('.card[data-pixel]').forEach(setupLife);
})();
