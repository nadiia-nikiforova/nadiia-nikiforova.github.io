/* Liquid gradients. A project's gradient is drawn live on the graphics chip,
   in the project's own colours, as if the box were filled with liquid: at
   rest it is a still picture, on hover it starts to flow, swirls around the
   pointer and glitters. When the pointer leaves it slows down and settles.
   Used on the home-page cards and on the case-study headers, so the page you
   open carries on from the card you clicked. A header also flows for a
   moment when its page opens.
   An element opts in with data-liquid="c1 c2 c3 c4 c5": 4 hex colours from
   the top of the box to the bottom, then a highlight colour.
   Without WebGL the gradient image underneath simply stays. Reduced motion
   gets the still picture only. */
(() => {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const VERT = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';
  const FRAG = `
precision highp float;
uniform vec2 uRes;      // canvas size, px
uniform float uTime;    // flow time: only runs while the liquid moves
uniform vec2 uMouse;    // pointer, 0..1, y up
uniform vec2 uVel;      // pointer speed, smoothed
uniform float uHover;   // 0 at rest .. 1 hovered, eased
uniform vec3 uC[5];     // the card's colours

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return v;
}

// One layer of glitter: a grid of specks, each with its own beat.
float glitter(vec2 p, float scale, float t) {
  vec2 g = p * scale, id = floor(g), f = fract(g) - 0.5;
  float r = hash(id);
  vec2 off = (vec2(hash(id + 3.1), hash(id + 7.7)) - 0.5) * 0.6;
  float tw = pow(max(0.0, sin(r * 40.0 + t * (1.5 + r * 3.0))), 24.0);
  return step(0.86, r) * tw * smoothstep(0.16, 0.0, length(f - off));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float asp = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * asp, uv.y), m = vec2(uMouse.x * asp, uMouse.y);

  // The pointer stirs the liquid: a swirl around it, and a push along its path.
  vec2 d = p - m;
  float near = exp(-dot(d, d) * 5.0) * uHover;
  p += near * 0.22 * vec2(-d.y, d.x) / (length(d) + 0.25);
  p -= uVel * near * 0.9;

  // Flow: noise folded into itself twice, which gives slow marbled currents.
  float t = uTime * 0.10;
  vec2 q = vec2(fbm(p * 1.1 + vec2(0.0, t)), fbm(p * 1.1 + vec2(5.2, -t)));
  vec2 w = vec2(fbm(p * 1.4 + 2.0 * q + vec2(1.7, 9.2) + t * 0.7), fbm(p * 1.4 + 2.0 * q + vec2(8.3, 2.8) - t * 0.6));
  float f = fbm(p * 1.2 + 2.4 * w);

  // Colours keep the cover's layout (first colour at the top, last ones at
  // the bottom), bent by the currents.
  float body = smoothstep(0.22, 0.78, f);   // stretch the currents to the full range, so every colour shows
  float h = clamp(0.22 + (1.0 - uv.y) * 0.34 + uv.x * 0.08 + (body - 0.5) * 1.25 + (w.x - 0.5) * 1.1, 0.0, 1.0) * 3.0;
  vec3 col = mix(uC[0], uC[1], smoothstep(0.0, 1.0, h));
  col = mix(col, uC[2], smoothstep(1.0, 2.0, h));
  col = mix(col, uC[3], smoothstep(2.0, 3.0, h));
  // Pale veins where the currents fold, like light through liquid.
  float vein = smoothstep(0.52, 0.9, w.y * (0.6 + f));
  col = mix(col, uC[4], vein * 0.55);

  // Thin bright lines that follow the currents, like light on a liquid's surface.
  float sheen = pow(abs(sin(f * 16.0 + w.x * 7.0)), 24.0);
  col += sheen * (0.03 + 0.07 * uHover);

  // Glitter rides the currents: faint at rest, alive on hover, a little livelier near the pointer.
  vec2 gp = p + w * 0.35;
  float g = glitter(gp, 46.0, uTime * 1.6) + 0.7 * glitter(gp + 3.7, 82.0, uTime * 2.1);
  col += g * (0.10 + uHover * (0.55 + near * 0.5));

  // The fine grain the painted covers have.
  col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) * 0.035;
  gl_FragColor = vec4(col, 1.0);
}`;

  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

  function setup(el) {
    const hero = el.classList.contains('case-hero');
    const cover = hero ? el : el.querySelector('.cover');   // the box the liquid fills
    const colors = el.dataset.liquid.split(/[\s,]+/).filter(Boolean);
    if (colors.length !== 5) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'liquid';
    canvas.setAttribute('aria-hidden', 'true');
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false });
    if (!gl) return;   // the gradient image stays

    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(sh)); return; }
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog); gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);   // one triangle over the whole cover
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = (name) => gl.getUniformLocation(prog, name);
    gl.uniform3fv(u('uC'), colors.flatMap(rgb));
    cover.querySelector(hero ? '.case-hero__bg' : '.cover__img').after(canvas);   // over the image, under everything else

    let scale = Math.min(window.devicePixelRatio || 1, 2);   // lowered if the machine struggles
    // Each project starts from its own fixed point in the flow, so its still picture is always the same.
    let time = [...el.dataset.liquid].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 997, 7) / 10;
    let hover = 0, target = 0;
    let mx = 0.5, my = 0.5, tx = 0.5, ty = 0.5, vx = 0, vy = 0;
    let raf = 0, last = 0, slow = 0;

    function size() {
      const w = Math.max(1, Math.round(cover.clientWidth * scale)), h = Math.max(1, Math.round(cover.clientHeight * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
      gl.uniform2f(u('uRes'), w, h);
    }

    function draw() {
      gl.uniform1f(u('uTime'), time);
      gl.uniform2f(u('uMouse'), mx, my);
      gl.uniform2f(u('uVel'), vx, vy);
      gl.uniform1f(u('uHover'), hover);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function frame(now) {
      const dt = Math.min(0.05, (now - (last || now)) / 1000);
      // A slow machine gets a lighter picture: after a run of long frames, draw at lower resolution.
      if (last && now - last > 24) { if (++slow > 20 && scale > 0.5) { scale *= 0.7; slow = 0; size(); } } else slow = Math.max(0, slow - 1);
      last = now;
      hover += (target - hover) * Math.min(1, dt * (target ? 5 : 1.6));   // quick to wake, slow to settle
      const px = mx, py = my;
      mx += (tx - mx) * Math.min(1, dt * 7); my += (ty - my) * Math.min(1, dt * 7);   // the liquid trails the pointer
      vx += ((mx - px) / Math.max(dt, 0.001) * 0.05 - vx) * Math.min(1, dt * 6);
      vy += ((my - py) / Math.max(dt, 0.001) * 0.05 - vy) * Math.min(1, dt * 6);
      time += dt * (0.15 + hover * 1.1);   // the flow speeds up on hover and coasts down after
      draw();
      if (target || hover > 0.004) raf = requestAnimationFrame(frame);
      else { raf = 0; last = 0; }
    }

    size(); draw();   // the still picture
    new ResizeObserver(() => { size(); if (!raf) draw(); }).observe(cover);
    if (still) return;

    el.addEventListener('pointermove', (e) => {
      const r = cover.getBoundingClientRect();
      tx = (e.clientX - r.left) / r.width; ty = 1 - (e.clientY - r.top) / r.height;
      target = 1;
      if (!raf) raf = requestAnimationFrame(frame);
    });
    el.addEventListener('pointerleave', () => { target = 0; });
    // A header greets the visitor: it flows for a moment as the page opens, then settles.
    if (hero) {
      target = 0.7; raf = requestAnimationFrame(frame);
      setTimeout(() => { if (!el.matches(':hover')) target = 0; }, 2200);
    }
  }

  document.querySelectorAll('[data-liquid]').forEach(setup);
})();
