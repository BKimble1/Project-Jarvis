/**
 * The animated core: a calm reactor that reflects one thing — what Jarvis is
 * doing right now. Canvas 2D, no library, no images, ~1KB of maths.
 *
 * States: `idle` (slow cool breathing), `working` (warmer, orbits accelerate),
 * `blocked` (tense amber-red throb, orbits stall), `speaking` (bright ripples
 * on the beat of the voice).
 *
 * `prefers-reduced-motion: reduce` is honoured properly: no animation frame
 * loop is ever started, and the core is painted as a single still frame that
 * still differs per state (colour and ring count carry the meaning instead of
 * movement).
 */

const PALETTE = {
  idle:     { core: [126, 200, 227], halo: [58, 122, 158],  orbit: [96, 165, 197], speed: 0.20, pulse: 0.045 },
  working:  { core: [140, 226, 200], halo: [42, 150, 128],  orbit: [110, 214, 180], speed: 0.85, pulse: 0.085 },
  blocked:  { core: [240, 170, 120], halo: [176, 84, 62],   orbit: [226, 132, 96],  speed: 0.08, pulse: 0.130 },
  speaking: { core: [186, 176, 255], halo: [104, 88, 200],  orbit: [158, 146, 246], speed: 0.55, pulse: 0.160 },
};

export const CORE_STATES = Object.keys(PALETTE);

const DESCRIPTION = {
  idle: 'Jarvis core, idle and waiting.',
  working: 'Jarvis core, working.',
  blocked: 'Jarvis core, blocked and waiting on you.',
  speaking: 'Jarvis core, speaking.',
};

const ORBITS = [
  { radius: 0.62, tilt: 0.32, dots: 3, dir: 1 },
  { radius: 0.80, tilt: -0.5, dots: 2, dir: -1 },
  { radius: 0.95, tilt: 0.85, dots: 4, dir: 1 },
];

function rgba([r, g, b], alpha) {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function prefersReducedMotion() {
  try {
    return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  } catch {
    return false;
  }
}

/**
 * @param {{canvas: HTMLCanvasElement, state?: string, reducedMotion?: boolean,
 *          describe?: (state: string) => string}} options
 */
export function createCore({ canvas, state = 'idle', reducedMotion, describe = (s) => DESCRIPTION[s] } = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new TypeError('createCore requires a canvas element');
  }
  const ctx = canvas.getContext('2d');
  let current = PALETTE[state] ? state : 'idle';
  let still = reducedMotion === undefined ? prefersReducedMotion() : Boolean(reducedMotion);
  let frame = null;
  let phase = 0;
  let spin = 0;
  let last = 0;
  let width = 0;
  let height = 0;
  let destroyed = false;

  const motionQuery = (() => {
    try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null; }
    catch { return null; }
  })();

  function resize() {
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.max(80, Math.round(rect.width || canvas.clientWidth || 240));
    const cssHeight = Math.max(80, Math.round(rect.height || canvas.clientHeight || cssWidth));
    const nextW = Math.round(cssWidth * dpr);
    const nextH = Math.round(cssHeight * dpr);
    if (nextW !== canvas.width || nextH !== canvas.height) {
      canvas.width = nextW;
      canvas.height = nextH;
    }
    width = cssWidth;
    height = cssHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function paint() {
    const p = PALETTE[current];
    const cx = width / 2;
    const cy = height / 2;
    const unit = Math.min(width, height) / 2;
    const breathe = still ? 0.5 : (Math.sin(phase) + 1) / 2;
    const coreR = unit * (0.26 + p.pulse * breathe);

    ctx.clearRect(0, 0, width, height);

    // Halo.
    const halo = ctx.createRadialGradient(cx, cy, coreR * 0.2, cx, cy, unit);
    halo.addColorStop(0, rgba(p.halo, 0.42));
    halo.addColorStop(0.55, rgba(p.halo, 0.10));
    halo.addColorStop(1, rgba(p.halo, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, unit, 0, Math.PI * 2);
    ctx.fill();

    // Orbits.
    ctx.lineWidth = Math.max(1, unit * 0.012);
    ORBITS.forEach((orbit, index) => {
      const r = unit * orbit.radius * 0.86;
      const angle = orbit.tilt + spin * orbit.dir * (1 + index * 0.22);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.strokeStyle = rgba(p.orbit, current === 'blocked' ? 0.16 : 0.26);
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * 0.36, 0, 0, Math.PI * 2);
      ctx.stroke();

      for (let d = 0; d < orbit.dots; d += 1) {
        const t = (d / orbit.dots) * Math.PI * 2 + spin * orbit.dir * 1.7;
        const x = Math.cos(t) * r;
        const y = Math.sin(t) * r * 0.36;
        const depth = (Math.sin(t) + 1) / 2;
        ctx.fillStyle = rgba(p.orbit, 0.25 + depth * 0.6);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1.1, unit * (0.018 + depth * 0.016)), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    });

    // Ripples while speaking (a still frame keeps one static ripple).
    if (current === 'speaking') {
      const rings = still ? [0.55] : [0, 0.33, 0.66];
      for (const offset of rings) {
        const t = still ? offset : ((phase / (Math.PI * 2)) + offset) % 1;
        ctx.strokeStyle = rgba(p.core, 0.34 * (1 - t));
        ctx.lineWidth = Math.max(1, unit * 0.02 * (1 - t));
        ctx.beginPath();
        ctx.arc(cx, cy, coreR + t * unit * 0.6, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Core.
    const body = ctx.createRadialGradient(cx - coreR * 0.3, cy - coreR * 0.35, coreR * 0.1, cx, cy, coreR);
    body.addColorStop(0, rgba(p.core, 0.98));
    body.addColorStop(0.7, rgba(p.core, 0.72));
    body.addColorStop(1, rgba(p.halo, 0.55));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = rgba(p.core, 0.55);
    ctx.lineWidth = Math.max(1, unit * 0.01);
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 1.22, 0, Math.PI * 2);
    ctx.stroke();
  }

  function tick(now) {
    if (destroyed) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    const p = PALETTE[current];
    phase = (phase + dt * (0.9 + p.pulse * 6)) % (Math.PI * 2);
    spin += dt * p.speed;
    paint();
    frame = globalThis.requestAnimationFrame(tick);
  }

  function start() {
    if (destroyed || still || frame !== null) return;
    last = 0;
    frame = globalThis.requestAnimationFrame(tick);
  }

  function stop() {
    if (frame !== null) {
      globalThis.cancelAnimationFrame?.(frame);
      frame = null;
    }
  }

  function redraw() {
    resize();
    paint();
  }

  function applyLabel() {
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', describe(current) ?? DESCRIPTION.idle);
    canvas.dataset.coreState = current;
  }

  const onResize = () => redraw();
  const onVisibility = () => {
    if (document.hidden) stop();
    else if (!still) { redraw(); start(); }
  };
  const onMotionChange = (event) => {
    still = Boolean(event.matches);
    if (still) { stop(); redraw(); } else { start(); }
  };

  globalThis.addEventListener?.('resize', onResize);
  document.addEventListener?.('visibilitychange', onVisibility);
  motionQuery?.addEventListener?.('change', onMotionChange);

  redraw();
  applyLabel();
  if (!still) start();

  return {
    get state() { return current; },
    get animating() { return frame !== null; },
    setState(next) {
      if (!PALETTE[next] || next === current) return current;
      current = next;
      applyLabel();
      if (still) paint(); // reduced motion: the change is visible, it just does not move
      return current;
    },
    redraw,
    destroy() {
      destroyed = true;
      stop();
      globalThis.removeEventListener?.('resize', onResize);
      document.removeEventListener?.('visibilitychange', onVisibility);
      motionQuery?.removeEventListener?.('change', onMotionChange);
    },
  };
}
