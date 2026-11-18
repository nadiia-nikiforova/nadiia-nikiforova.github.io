/* Liquid gradients, stirred. Test version of liquid.js.
   Same picture as liquid.js, but the pointer is a stick in the liquid: a
   small fluid simulation runs inside the box, the stick drags the liquid
   along, the liquid keeps going after the stick stops, curls into eddies,
   meets the walls and slowly settles. Where the stick went it leaves a wet
   trail that dries off.
   How: the simulation (velocity, pressure, swirl) runs on a small grid. A
   second grid remembers, for every point, where its liquid came from, and
   the gradient is drawn from there, so the colours themselves get carried.
   That memory slowly lets go, so the cover finds its way back to its still
   picture.
   Needs WebGL2 with float render targets; otherwise it loads liquid.js. */
(() => {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const me = document.currentScript;

  // ---- tuning -------------------------------------------------------------
  const F = {
    stick: 0.04,   // stick radius, share of the box width
    grip: 0.6,     // how strongly the stick drags the liquid (0..1 per frame)
    drag: 0.45,    // how fast the liquid loses its motion, per second (lower = longer glide)
    swirl: 22,     // eddies: how much the liquid curls on itself
    maxV: 600,     // fastest the stick can push, cells per second
    hold: 0.06,    // while stirring, how fast the colours drift back home, per second
    letGo: 0.3,    // after the pointer leaves, same
    wet: 0.16,     // how visible the wet trail is
    dry: 0.55,     // how fast it dries, per second
  };
  const SIM_W = 128;      // simulation grid width, cells
  const ITER = 20;        // pressure iterations

  function supported() {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return false;
    let ok = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    if (ok) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA, gl.HALF_FLOAT, null);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    }
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return ok;
  }
  if (!supported()) {
    const s = document.createElement('script');
    s.src = me ? me.src.replace(/liquid-fluid\.js.*$/, 'liquid.js') : 'liquid.js';
    document.head.appendChild(s);
    return;
  }

  // ---- shaders --------------------------------------------------------------
  const VERT = 'attribute vec2 p; varying vec2 vUv; void main() { vUv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }';
  const HEAD = 'precision highp float; precision highp sampler2D; varying vec2 vUv; uniform vec2 uTex;\n';
  const WALL = `float wall() { vec2 e = min(vUv, 1.0 - vUv) / uTex; return clamp(min(e.x, e.y) - 0.5, 0.0, 1.0); }\n`;

  // The stick: liquid along its path is pulled toward the stick's own speed. mode 1 wets the trail instead.
  const SPLAT = HEAD + `
uniform sampler2D uSrc; uniform vec2 uA, uB, uStick; uniform float uR, uAmt, uMode;
void main() {
  vec2 x = vUv / uTex, ab = uB - uA;
  float t = clamp(dot(x - uA, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
  vec2 d = x - (uA + ab * t);
  float f = exp(-dot(d, d) / (uR * uR)) * uAmt;
  vec4 s = texture2D(uSrc, vUv);
  if (uMode < 0.5) gl_FragColor = vec4(mix(s.xy, uStick, f), 0.0, 1.0);
  else gl_FragColor = vec4(s.xy, max(s.z, f), 1.0);
}`;
  const CURL = HEAD + `
uniform sampler2D uVel;
void main() {
  float L = texture2D(uVel, vUv - vec2(uTex.x, 0.0)).y, R = texture2D(uVel, vUv + vec2(uTex.x, 0.0)).y;
  float B = texture2D(uVel, vUv - vec2(0.0, uTex.y)).x, T = texture2D(uVel, vUv + vec2(0.0, uTex.y)).x;
  gl_FragColor = vec4(0.5 * ((R - L) - (T - B)), 0.0, 0.0, 1.0);
}`;
  // Vorticity confinement: feeds the small eddies so they don't blur away.
  const VORT = HEAD + `
uniform sampler2D uVel, uCurl; uniform float uDt, uK;
void main() {
  float L = texture2D(uCurl, vUv - vec2(uTex.x, 0.0)).x, R = texture2D(uCurl, vUv + vec2(uTex.x, 0.0)).x;
  float B = texture2D(uCurl, vUv - vec2(0.0, uTex.y)).x, T = texture2D(uCurl, vUv + vec2(0.0, uTex.y)).x;
  float C = texture2D(uCurl, vUv).x;
  vec2 f = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  f = f / (length(f) + 1e-4) * uK * C * vec2(1.0, -1.0);
  vec2 v = texture2D(uVel, vUv).xy + f * uDt;
  gl_FragColor = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
}`;
  const DIV = HEAD + `
uniform sampler2D uVel;
void main() {
  vec2 C = texture2D(uVel, vUv).xy;
  float L = texture2D(uVel, vUv - vec2(uTex.x, 0.0)).x, R = texture2D(uVel, vUv + vec2(uTex.x, 0.0)).x;
  float B = texture2D(uVel, vUv - vec2(0.0, uTex.y)).y, T = texture2D(uVel, vUv + vec2(0.0, uTex.y)).y;
  if (vUv.x - uTex.x < 0.0) L = -C.x;
  if (vUv.x + uTex.x > 1.0) R = -C.x;
  if (vUv.y - uTex.y < 0.0) B = -C.y;
  if (vUv.y + uTex.y > 1.0) T = -C.y;
  gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`;
  const SCALE = HEAD + 'uniform sampler2D uSrc; uniform float uK; void main() { gl_FragColor = texture2D(uSrc, vUv) * uK; }';
  const PRESS = HEAD + `
uniform sampler2D uP, uDiv;
void main() {
  float L = texture2D(uP, vUv - vec2(uTex.x, 0.0)).x, R = texture2D(uP, vUv + vec2(uTex.x, 0.0)).x;
  float B = texture2D(uP, vUv - vec2(0.0, uTex.y)).x, T = texture2D(uP, vUv + vec2(0.0, uTex.y)).x;
  gl_FragColor = vec4((L + R + B + T - texture2D(uDiv, vUv).x) * 0.25, 0.0, 0.0, 1.0);
}`;
  // Liquid can't be squeezed: take away the part of the motion that would.
  const GRAD = HEAD + WALL + `
uniform sampler2D uP, uVel;
void main() {
  float L = texture2D(uP, vUv - vec2(uTex.x, 0.0)).x, R = texture2D(uP, vUv + vec2(uTex.x, 0.0)).x;
  float B = texture2D(uP, vUv - vec2(0.0, uTex.y)).x, T = texture2D(uP, vUv + vec2(0.0, uTex.y)).x;
  vec2 v = texture2D(uVel, vUv).xy - 0.5 * vec2(R - L, T - B);
  gl_FragColor = vec4(v * wall(), 0.0, 1.0);
}`;
  // The liquid carries its own motion along: this is the inertia.
  const ADV_VEL = HEAD + WALL + `
uniform sampler2D uVel; uniform float uDt, uDecay;
void main() {
  vec2 v = texture2D(uVel, vUv).xy;
  gl_FragColor = vec4(texture2D(uVel, vUv - uDt * v * uTex).xy * uDecay * wall(), 0.0, 1.0);
}`;
  // ...and carries the colours: xy = how far this point's liquid has travelled, z = wetness.
  const ADV_MAP = HEAD + `
uniform sampler2D uVel, uMap; uniform float uDt, uRelax, uDry;
void main() {
  vec2 v = texture2D(uVel, vUv).xy;
  vec4 m = texture2D(uMap, vUv - uDt * v * uTex);
  gl_FragColor = vec4((m.xy - uDt * v) * uRelax, m.z * uDry, 1.0);
}`;

  // The picture: the liquid.js gradient, drawn from where each point's liquid came from.
  const DRAW = `
precision highp float; precision highp sampler2D;
uniform vec2 uRes;      // canvas size, px
uniform float uTime;    // flow time: only runs while the liquid moves
uniform float uHover;   // 0 at rest .. 1 hovered, eased
uniform vec3 uC[5];     // the card's colours
uniform sampler2D uMap;
uniform vec2 uSimRes;
uniform float uWet;     // how visible the wet trail is

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
float glitter(vec2 p, float scale, float t) {
  vec2 g = p * scale, id = floor(g), f = fract(g) - 0.5;
  float r = hash(id);
  vec2 off = (vec2(hash(id + 3.1), hash(id + 7.7)) - 0.5) * 0.6;
  float tw = pow(max(0.0, sin(r * 40.0 + t * (1.5 + r * 3.0))), 24.0);
  return step(0.86, r) * tw * smoothstep(0.16, 0.0, length(f - off));
}

void main() {
  vec2 uv0 = gl_FragCoord.xy / uRes;
  vec4 mp = texture2D(uMap, uv0);
  vec2 uv = uv0 + mp.xy / uSimRes;              // where this point's liquid came from
  float asp = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * asp, uv.y);

  float t = uTime * 0.10;
  vec2 q = vec2(fbm(p * 1.1 + vec2(0.0, t)), fbm(p * 1.1 + vec2(5.2, -t)));
  vec2 w = vec2(fbm(p * 1.4 + 2.0 * q + vec2(1.7, 9.2) + t * 0.7), fbm(p * 1.4 + 2.0 * q + vec2(8.3, 2.8) - t * 0.6));
  float f = fbm(p * 1.2 + 2.4 * w);

  float body = smoothstep(0.22, 0.78, f);
  float h = clamp(0.22 + (1.0 - uv.y) * 0.34 + uv.x * 0.08 + (body - 0.5) * 1.25 + (w.x - 0.5) * 1.1, 0.0, 1.0) * 3.0;
  vec3 col = mix(uC[0], uC[1], smoothstep(0.0, 1.0, h));
  col = mix(col, uC[2], smoothstep(1.0, 2.0, h));
  col = mix(col, uC[3], smoothstep(2.0, 3.0, h));
  float vein = smoothstep(0.52, 0.9, w.y * (0.6 + f));
  col = mix(col, uC[4], vein * 0.55);

  // Thin bright lines on the surface, as in liquid.js. Nothing lights up under the pointer.
  float sheen = pow(abs(sin(f * 16.0 + w.x * 7.0)), 24.0);
  col += sheen * (0.03 + 0.05 * uHover);

  // The wet trail: only a touch deeper and richer where the stick went, no light.
  col = mix(col, col * col * 1.12, mp.z * uWet);

  vec2 gp = p + w * 0.35;
  float g = glitter(gp, 46.0, uTime * 1.6) + 0.7 * glitter(gp + 3.7, 82.0, uTime * 2.1);
  col += g * (0.10 + uHover * 0.55);

  col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) * 0.035;
  gl_FragColor = vec4(col, 1.0);
}`;

  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

  function setup(el) {
    const hero = el.classList.contains('case-hero');
    const cover = hero ? el : el.querySelector('.cover');
    const colors = el.dataset.liquid.split(/[\s,]+/).filter(Boolean);
    if (colors.length !== 5) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'liquid';
    canvas.setAttribute('aria-hidden', 'true');
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) return;
    gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');

    function program(src) {
      const prog = gl.createProgram();
      for (const [type, s] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, src]]) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, s); gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(sh)); return null; }
        gl.attachShader(prog, sh);
      }
      gl.bindAttribLocation(prog, 0, 'p');
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn(gl.getProgramInfoLog(prog)); return null; }
      const uni = {};
      for (let i = 0, n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i < n; i++) {
        const name = gl.getActiveUniform(prog, i).name;
        uni[name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, name);
      }
      return { prog, uni };
    }
    const P = {
      splat: program(SPLAT), curl: program(CURL), vort: program(VORT), div: program(DIV), scale: program(SCALE),
      press: program(PRESS), grad: program(GRAD), advVel: program(ADV_VEL), advMap: program(ADV_MAP), draw: program(DRAW),
    };
    if (Object.values(P).some((p) => !p)) return;   // the gradient image stays

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.useProgram(P.draw.prog);
    gl.uniform3fv(P.draw.uni.uC, colors.flatMap(rgb));
    cover.querySelector(hero ? '.case-hero__bg' : '.cover__img').after(canvas);

    // ---- simulation grids ----
    let simW = SIM_W, simH = 0, vel, map, prs, div, curl;
    const made = [];
    function target() {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, simW, simH, 0, gl.RGBA, gl.HALF_FLOAT, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, simW, simH); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      made.push(tex, fb);
      return { tex, fb };
    }
    function pair() {
      let a = target(), b = target();
      return { get read() { return a; }, get write() { return b; }, swap() { [a, b] = [b, a]; } };
    }
    function grids(h) {
      if (h === simH) return;
      for (const o of made.splice(0)) (o instanceof WebGLTexture ? gl.deleteTexture(o) : gl.deleteFramebuffer(o));
      simH = h;
      vel = pair(); map = pair(); prs = pair(); div = target(); curl = target();
    }

    function pass(p, dst, uniforms) {
      gl.useProgram(p.prog);
      let unit = 0;
      for (const k in uniforms) {
        const loc = p.uni[k], v = uniforms[k];
        if (loc == null) continue;
        if (v && v.tex) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, v.tex); gl.uniform1i(loc, unit++); }
        else if (typeof v === 'number') gl.uniform1f(loc, v);
        else gl.uniform2f(loc, v[0], v[1]);
      }
      if (dst) { gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb); gl.viewport(0, 0, simW, simH); }
      else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height); }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    let scale = Math.min(window.devicePixelRatio || 1, 2);
    let time = [...el.dataset.liquid].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 997, 7) / 10;
    let hover = 0, goal = 0, raf = 0, last = 0, slow = 0, lastStir = -1e9;
    let inside = false, cur = [0, 0], stick = [0, 0], sv = [0, 0];

    function size() {
      const w = Math.max(1, Math.round(cover.clientWidth * scale)), h = Math.max(1, Math.round(cover.clientHeight * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      grids(Math.max(8, Math.round(simW * cover.clientHeight / Math.max(1, cover.clientWidth))));
    }

    function step(dt) {
      const tex = [1 / simW, 1 / simH];
      if (inside) {
        // The stick is at the pointer; its speed a little smoothed so a jumpy mouse reads as one stroke.
        const prevStick = stick.slice();
        const k = Math.min(1, dt * 30);
        for (let i = 0; i < 2; i++) {
          sv[i] += ((cur[i] - stick[i]) / dt - sv[i]) * k;
          sv[i] = Math.max(-F.maxV, Math.min(F.maxV, sv[i]));
        }
        stick = cur.slice();
        const moving = Math.min(1, Math.hypot(sv[0], sv[1]) / 120);
        const R = Math.max(2, F.stick * simW);
        const stroke = { uTex: tex, uA: prevStick, uB: stick, uR: R, uStick: sv };
        pass(P.splat, vel.write, { ...stroke, uSrc: vel.read, uAmt: F.grip * (0.35 + 0.65 * moving), uMode: 0 }); vel.swap();
        if (moving > 0.05) { pass(P.splat, map.write, { ...stroke, uSrc: map.read, uR: R * 1.2, uAmt: moving, uMode: 1 }); map.swap(); }
      }
      pass(P.curl, curl, { uTex: tex, uVel: vel.read });
      pass(P.vort, vel.write, { uTex: tex, uVel: vel.read, uCurl: curl, uDt: dt, uK: F.swirl }); vel.swap();
      pass(P.div, div, { uTex: tex, uVel: vel.read });
      pass(P.scale, prs.write, { uTex: tex, uSrc: prs.read, uK: 0.8 }); prs.swap();
      for (let i = 0; i < ITER; i++) { pass(P.press, prs.write, { uTex: tex, uP: prs.read, uDiv: div }); prs.swap(); }
      pass(P.grad, vel.write, { uTex: tex, uP: prs.read, uVel: vel.read }); vel.swap();
      pass(P.advVel, vel.write, { uTex: tex, uVel: vel.read, uDt: dt, uDecay: Math.exp(-dt * F.drag) }); vel.swap();
      pass(P.advMap, map.write, {
        uTex: tex, uVel: vel.read, uMap: map.read, uDt: dt,
        uRelax: Math.exp(-dt * (goal ? F.hold : F.letGo)), uDry: Math.exp(-dt * F.dry),
      }); map.swap();
    }

    function draw() {
      pass(P.draw, null, {
        uRes: [canvas.width, canvas.height], uTime: time, uHover: hover,
        uMap: map.read, uSimRes: [simW, simH], uWet: F.wet,
      });
    }

    function frame(now) {
      const dt = Math.min(1 / 30, Math.max(1 / 240, (now - (last || now - 16)) / 1000));
      if (last && now - last > 24) { if (++slow > 20 && scale > 0.5) { scale *= 0.7; slow = 0; size(); } } else slow = Math.max(0, slow - 1);
      last = now;
      hover += (goal - hover) * Math.min(1, dt * (goal ? 5 : 1.6));
      time += dt * (0.12 + hover * 0.35);   // a slow drift of its own; the stirring comes from the stick
      step(dt);
      draw();
      if (goal || hover > 0.004 || now - lastStir < 9000) raf = requestAnimationFrame(frame);
      else { raf = 0; last = 0; }
    }
    const wake = () => { if (!raf) raf = requestAnimationFrame(frame); };

    size(); draw();
    new ResizeObserver(() => { size(); if (!raf) draw(); }).observe(cover);
    if (still) return;

    el.addEventListener('pointermove', (e) => {
      const r = cover.getBoundingClientRect();
      cur = [(e.clientX - r.left) / r.width * simW, (1 - (e.clientY - r.top) / r.height) * simH];
      if (!inside) { inside = true; stick = cur.slice(); sv = [0, 0]; }
      goal = 1; lastStir = performance.now();
      wake();
    });
    el.addEventListener('pointerleave', () => { inside = false; goal = 0; lastStir = performance.now(); });
    if (hero) {
      goal = 0.7; wake();
      setTimeout(() => { if (!el.matches(':hover')) goal = 0; }, 2200);
    }
  }

  document.querySelectorAll('[data-liquid]').forEach(setup);
})();
