// ===========================================================================
// Panels / driver
//
// Every scene paints into a persistent offscreen buffer. The visible canvas is
// composited each frame as: background fill, then the buffer at `artAlpha`.
// That gives a true linear fade -- repeatedly blending a translucent background
// over the artwork instead plateaus at grey once the per-frame delta rounds
// below one 8-bit step. (Maps to ID2D1BitmapRenderTarget + DrawBitmap(opacity)
// in the Direct2D port.)
//
// Interaction, mirroring what the mod will expose:
//   wheel  -> the style's one live parameter (also drives the slider)
//   click  -> cycle to the next ENABLED style
//   Esc    -> close
// ===========================================================================
const W = 700, H = 440, DPR = 2;
const panels = [];

const KINDS = ['flow', 'contour', 'growth', 'harmonograph'];
const META = {
  flow:         { name: 'flow field',          param: 'turbulence', pal: 'aurora' },
  contour:      { name: 'contours',            param: 'relief',     pal: 'ocean'  },
  growth:       { name: 'differential growth', param: 'vigor',      pal: 'ember'  },
  harmonograph: { name: 'harmonograph',        param: 'tempo',      pal: 'mono'   },
};
// every style is enabled by default; the mod exposes the same four toggles
const enabled = { flow: true, contour: true, growth: true, harmonograph: true };

// Global hue offset in degrees. Space-hold slews it fast; the automatic ramp
// runs independently and can be set slower or faster than the Space rate.
let hue = 0;
let spaceDown = false;
const SPACE_RATE = 90;   // degrees per second while Space is held

// five notches, deliberately coarse -- right-click steps through them
const AMOUNTS = ['minimal', 'sparse', 'balanced', 'dense', 'maximal'];
const AMOUNT_DEFAULT = 2;

const PHASE = { IN: 0, BUILD: 1, HOLD: 2, OUT: 3 };
const FADE_IN_F = 45, HOLD_F = 260, FADE_OUT_F = 130;

const rnd = () => (Math.random() * 1e9) | 0;
const ink = (hex) => shiftHue(hex, hue);

// The overlay is clean by default. Labels and the parameter slider appear
// only while you are switching styles or turning the wheel, then fade out.
function flashHud(p) {
  p.el.classList.add('hud');
  clearTimeout(p.hudTimer);
  p.hudTimer = setTimeout(function () { p.el.classList.remove('hud'); }, 1800);
}

function makePanel(kind) {
  const d = document.createElement('div');
  d.className = 'panel';
  d.innerHTML =
    '<canvas width="' + (W * DPR) + '" height="' + (H * DPR) + '" ' +
      'style="width:' + W + 'px;height:' + H + 'px"></canvas>' +
    '<div class="label"></div><div class="stat"></div>' +
    '<div class="closed">CLOSED &mdash; click to reopen</div>' +
    '<div class="ctl"><span class="pname"></span>' +
    '<input type="range" min="0" max="1000" value="500"><span class="pval"></span>' +
    '<span class="pamt"></span>' +
    '<label class="en"><input type="checkbox" checked> on</label></div>';
  document.getElementById('grid').appendChild(d);

  const cv = d.querySelector('canvas');
  const buf = document.createElement('canvas');
  buf.width = W * DPR;
  buf.height = H * DPR;

  const p = {
    kind, el: d, cv, ctx: cv.getContext('2d'), buf, bctx: buf.getContext('2d'),
    stat: d.querySelector('.stat'), label: d.querySelector('.label'),
    slider: d.querySelector('input[type=range]'),
    enbox: d.querySelector('.en input'),
    pname: d.querySelector('.pname'), pval: d.querySelector('.pval'),
    pamt: d.querySelector('.pamt'),
    param: 0.5, amount: AMOUNT_DEFAULT, closed: false,
  };
  panels.push(p);

  // wheel -> parameter, kept in lockstep with the slider
  cv.addEventListener('wheel', function (e) {
    e.preventDefault();
    setParam(p, p.param - Math.sign(e.deltaY) * 0.04);
    flashHud(p);
  }, { passive: false });

  // click -> next enabled style (or reopen if closed)
  cv.addEventListener('click', function () {
    if (p.closed) { reopen(p); return; }
    cycle(p);
  });
  d.querySelector('.closed').addEventListener('click', function () { reopen(p); });

  d.addEventListener('mouseenter', function () { flashHud(p); });
  // right-click -> next amount notch. Everything except contours is
  // structural, so the scene is rebuilt; contours re-level live.
  cv.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    p.amount = (p.amount + 1) % AMOUNTS.length;
    if (p.kind === 'contour') { p.scene.levels = window.ContourLevels[p.amount]; showAmount(p); flashHud(p); }
    else { initPanel(p, rnd()); flashHud(p); }
  });

  p.slider.addEventListener('input', function () { setParam(p, p.slider.value / 1000); flashHud(p); });
  p.enbox.addEventListener('change', function () {
    enabled[p.kind] = p.enbox.checked;
    p.el.classList.toggle('off', !p.enbox.checked);
  });
  return p;
}

function reopen(p) {
  p.closed = false;
  p.el.classList.remove('closed-state');
  initPanel(p, rnd());
}

function showAmount(p) {
  p.pamt.textContent = AMOUNTS[p.amount];
}

function setParam(p, v) {
  p.param = Math.max(0, Math.min(1, v));
  p.slider.value = Math.round(p.param * 1000);
  p.pval.textContent = p.param.toFixed(2);
}

function cycle(p) {
  const avail = KINDS.filter(function (k) { return enabled[k]; });
  if (!avail.length) return;
  const i = avail.indexOf(p.kind);
  p.kind = avail[(i + 1) % avail.length];
  initPanel(p, rnd());
  flashHud(p);
}

function initPanel(p, seed) {
  const meta = META[p.kind];
  p.palName = meta.pal;
  const pal = PALETTES[p.palName];
  p.label.textContent = meta.name;
  p.pname.textContent = meta.param;
  p.enbox.checked = !!enabled[p.kind];
  p.el.classList.toggle('off', !enabled[p.kind]);
  setParam(p, p.param);
  showAmount(p);
  p.bctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  p.bctx.clearRect(0, 0, W, H);
  p.bctx.lineCap = 'round';
  p.bctx.lineJoin = 'round';
  p.frame = 0; p.phase = PHASE.IN; p.phaseFrame = 0; p.artAlpha = 0;
  if (p.kind === 'flow')         p.scene = new FlowScene(W, H, seed, pal, p.amount);
  if (p.kind === 'contour')      p.scene = new ContourScene(W, H, seed, pal, p.amount);
  if (p.kind === 'growth')       p.scene = new GrowthScene(W, H, seed, pal, p.amount);
  if (p.kind === 'harmonograph') p.scene = new HarmonographScene(W, H, seed, pal, p.amount);
}

// --- scene painting, with the live parameter applied ----------------------
function buildScene(p) {
  const b = p.bctx, s = p.scene, pal = PALETTES[p.palName], q = p.param;
  let done = false;

  if (p.kind === 'flow') {
    s.turns = 1.0 + q * 3.5;                       // parameter: turbulence
    const sub = 1 + Math.round(q * 4);
    const out = [];
    for (let i = 0; i < sub; i++) s.step_(out);
    for (const seg of out) {
      const c = seg.c;
      b.strokeStyle = rgba(ink(c.color), c.alpha);
      b.lineWidth = c.lw;
      b.beginPath();
      for (let i = 0; i < seg.to.length; i++) {
        b.moveTo(seg.from[i][0], seg.from[i][1]);
        b.lineTo(seg.to[i][0], seg.to[i][1]);
      }
      b.stroke();
    }
    p.stat.textContent = 'curves ' + s.curves.length + ' / active ' + s.active.length;
    done = s.done;
  }

  if (p.kind === 'contour') {
    s.warp = 0.10 + q * 0.80;                      // parameter: relief
    b.clearRect(0, 0, W, H);
    s.sample(p.frame);
    const n = s.levels;
    for (let k = 0; k < n; k++) {
      const level = -0.42 + (k / (n - 1)) * 0.84;
      const emph = (k % 5 === 0);
      const c = lerpHex(pal.ink[0], pal.ink[4], k / (n - 1));
      b.strokeStyle = rgba(ink(c), emph ? 0.95 : 0.38);
      b.lineWidth = emph ? 1.15 : 0.6;
      b.beginPath();
      s.contour(level, function (a, bb) { b.moveTo(a[0], a[1]); b.lineTo(bb[0], bb[1]); });
      b.stroke();
    }
    p.stat.textContent = 'levels ' + s.levels + ' / grid ' + s.res + 'x' + s.rows;
    done = p.frame > 2400;
  }

  if (p.kind === 'growth') {
    s.repel = (s.baseRepel || s.maxLen * 2.4) * (0.70 + q * 1.20);  // parameter: vigor
    const sub = 1 + Math.round(q * 4);
    for (let i = 0; i < sub; i++) { s.step_(); if (i === 0) s.paint(b); }
    p.stat.textContent = 'loops ' + s.loops.length + ' / nodes ' + s.total();
    done = s.done;
  }

  if (p.kind === 'harmonograph') {
    const pts = 4 + Math.round(q * 60);            // parameter: tempo
    let alive = 0;
    for (const f of s.figs) {
      if (f.t >= f.tEnd) continue;
      alive++;
      b.strokeStyle = rgba(ink(f.color), f.alpha);
      b.lineWidth = f.lw;
      b.beginPath();
      let started = false;
      for (let i = 0; i < pts && f.t < f.tEnd; i++, f.t += 0.22) {
        const pt = s.pointAt(f, f.t);
        if (!started) { const o = f.last || pt; b.moveTo(o[0], o[1]); started = true; }
        b.lineTo(pt[0], pt[1]);
        f.last = pt;
      }
      b.stroke();
    }
    p.stat.textContent = 'curves ' + s.figs.length + ' / drawing ' + alive;
    done = alive === 0;
  }
  return done;
}

const easeInOut = function (t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
};

function drawPanel(p) {
  if (p.closed) return;
  const ctx = p.ctx, pal = PALETTES[p.palName];
  p.frame++; p.phaseFrame++;

  if (p.phase === PHASE.IN || p.phase === PHASE.BUILD) {
    const done = buildScene(p);
    if (p.phase === PHASE.IN) {
      p.artAlpha = easeInOut(Math.min(1, p.phaseFrame / FADE_IN_F));
      if (p.phaseFrame >= FADE_IN_F) { p.phase = PHASE.BUILD; p.phaseFrame = 0; p.artAlpha = 1; }
    } else if (done) { p.phase = PHASE.HOLD; p.phaseFrame = 0; }
  } else if (p.phase === PHASE.HOLD) {
    if (p.kind === 'growth') p.scene.step_();
    if (p.phaseFrame >= HOLD_F) { p.phase = PHASE.OUT; p.phaseFrame = 0; }
  } else if (p.phase === PHASE.OUT) {
    p.artAlpha = 1 - easeInOut(Math.min(1, p.phaseFrame / FADE_OUT_F));
    if (p.phaseFrame >= FADE_OUT_F) { initPanel(p, rnd()); return; }
  }

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = p.artAlpha;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(p.buf, 0, 0);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (p.scene && p.scene.paintCrisp) p.scene.paintCrisp(ctx);
  ctx.globalAlpha = 1;
}

for (const k of KINDS) makePanel(k);
function regenAll() { for (const p of panels) initPanel(p, rnd()); }
regenAll();

// Esc closes every panel; click reopens one
addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    for (const p of panels) { p.closed = true; p.el.classList.add('closed-state'); }
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); spaceDown = true; }
});
addEventListener('keyup', function (e) {
  if (e.code === 'Space') spaceDown = false;
});

// rotation timer -- the mod exposes the same interval as a setting
let rotAt = 0;
function rotateTick(now) {
  const on = document.getElementById('rot').checked;
  const secs = Math.max(3, +document.getElementById('rotSec').value || 20);
  if (!on) { rotAt = now + secs * 1000; return; }
  if (now >= rotAt) {
    rotAt = now + secs * 1000;
    for (const p of panels) if (!p.closed) cycle(p);
  }
}

let fpsLast = performance.now(), fpsAcc = 0, fpsFrames = 0;
function tick2(now) {
  fpsAcc += now - fpsLast; fpsLast = now; fpsFrames++;
  if (fpsAcc > 500) {
    document.getElementById('fps').textContent = (fpsFrames / fpsAcc * 1000).toFixed(0) + ' fps';
    fpsAcc = 0; fpsFrames = 0;
  }
  const dtSec = Math.min(0.1, (now - (window.__lastHueT || now)) / 1000);
  window.__lastHueT = now;
  if (spaceDown) hue += SPACE_RATE * dtSec;
  if (document.getElementById('ramp').checked) {
    hue += (+document.getElementById('rampSpeed').value || 12) * dtSec;
  }
  hue %= 360;
  rotateTick(now);
  for (const p of panels) drawPanel(p);
  requestAnimationFrame(tick2);
}
requestAnimationFrame(tick2);

window.ContourLevels = ContourScene.LEVELS;
window.__proto = { panels, regenAll, initPanel, setParam, cycle, enabled, PHASE, AMOUNTS,
  getHue: () => hue, setHue: (v) => { hue = v; } };
