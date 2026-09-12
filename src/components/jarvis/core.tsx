'use client';

import * as React from 'react';

import { CORE_MOTION, CORE_STATE_TONE, type CoreState } from '@/domain/core-state';

/**
 * The intelligence core.
 *
 * ## What it is made of
 *
 * Three layers, chosen so that each does the thing it is cheapest at:
 *
 *  1. **A CSS glow.** One radial gradient behind everything. Free, and it is what gives the core
 *     its light rather than its shape.
 *  2. **A canvas point cloud.** A sphere of points rotated and projected each frame. Canvas
 *     because a thousand SVG circles is a thousand DOM nodes the browser must lay out, and this is
 *     the one part of the composition where the count is what creates the sense of depth.
 *  3. **An SVG ring assembly.** Rings, ticks and segmented arcs, animated by CSS transforms on
 *     groups. SVG because these are a handful of precise shapes that must stay crisp at any size,
 *     and CSS because a rotation the compositor owns costs nothing per frame.
 *
 * WebGL was considered and rejected: it would add a context to manage, a shader to review and a
 * class of device-specific failure, in exchange for depth this composition does not need. A
 * thousand projected points is not where a Raspberry Pi struggles.
 *
 * ## What it is not
 *
 * It is not the status. Every state it displays is also stated in text, in a live region, outside
 * this component — because the core is `aria-hidden` decoration and a person using a screen reader
 * must lose nothing. It is also not a measurement: `level` is drawn only when a caller passes a
 * real one, and the callers that have none pass null rather than something plausible.
 *
 * ## Cost control
 *
 * One `requestAnimationFrame` loop for the canvas, and none at all for the rings. The loop stops
 * when the tab is hidden, when the core scrolls out of view, and when motion is off — in which
 * case exactly one frame is drawn, so the core still looks like itself while standing still.
 */

/** Bounded, and different per mode. The upper number is what a desktop should spend, not a target. */
const PARTICLES = { full: 1600, lite: 320 } as const;

/** Retina is worth paying for; a 3× phone screen is not, for a field of soft points. */
const MAX_DPR = { full: 2, lite: 1 } as const;

const TONE_RGB: Record<'blue' | 'cyan' | 'amber' | 'red' | 'green', [number, number, number]> = {
  blue: [39, 140, 255],
  cyan: [121, 232, 255],
  amber: [255, 184, 77],
  red: [255, 107, 126],
  green: [79, 224, 168],
};

export interface JarvisCoreProps {
  readonly state: CoreState;
  /**
   * A real, measured input level in 0..1, or null when there is none.
   *
   * Null is the honest default. Only the microphone analyser produces a genuine level; speech
   * playback produces events, not amplitude, so the speaking state passes its own pulse instead
   * and this stays null. Nothing here invents a level to make the animation livelier.
   */
  readonly level?: number | null;
  /**
   * The same thing, pulled once per frame instead of pushed on every change.
   *
   * A microphone analyser produces a new figure sixty times a second. Routing that through React
   * state would re-render the entire screen sixty times a second to move one circle, so a caller
   * that has a continuously changing level hands over a function and the animation loop reads it
   * where it already is. It is read only where `reactivity` says a level is trustworthy, exactly
   * like `level`, and returning null means the same thing: there is nothing real to show.
   */
  readonly levelSource?: (() => number | null) | undefined;
  /** How many agents are genuinely running. Drives the outer activity accents, and only that. */
  readonly activity?: number;
  readonly graphics?: 'full' | 'lite';
  /** False disables the animation loop entirely and draws one representative frame. */
  readonly motion?: boolean;
  readonly className?: string;
}

export function JarvisCore({
  state,
  level = null,
  levelSource,
  activity = 0,
  graphics = 'full',
  motion = true,
  className,
}: JarvisCoreProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);

  /*
   * Everything the loop reads lives in a ref, refreshed on render.
   *
   * The loop must not be torn down and rebuilt every time the state changes — that would restart
   * the rotation from zero and make each state change look like a stutter. Reading the latest
   * values out of a ref keeps one continuous loop across the whole life of the screen.
   */
  const live = React.useRef({ state, level, levelSource, activity, graphics, motion });
  live.current = { state, level, levelSource, activity, graphics, motion };

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    /*
     * A Fibonacci sphere: the cheapest way to scatter points on a sphere without the clumping at
     * the poles that naive random spherical coordinates produce. Built once — the points never
     * change, only the matrix they are viewed through.
     */
    const count = PARTICLES[graphics];
    const points = new Float32Array(count * 3);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let index = 0; index < count; index += 1) {
      const y = 1 - (index / (count - 1)) * 2;
      const radius = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * index;
      points[index * 3] = Math.cos(theta) * radius;
      points[index * 3 + 1] = y;
      points[index * 3 + 2] = Math.sin(theta) * radius;
    }

    /* A fixed per-point phase, so the agitation shimmer is not a single synchronised throb. */
    const phase = new Float32Array(count);
    for (let index = 0; index < count; index += 1) phase[index] = (index % 97) / 97;

    /*
     * A fixed radial jitter, and it matters more than it sounds.
     *
     * A Fibonacci lattice is perfectly even, and projected flat that evenness reads as a printed
     * halftone rather than as a cloud of light — the eye finds the pattern instantly and the
     * sphere collapses into a disc of dots. Pushing each point a little in or out along its own
     * normal, deterministically and once, breaks the lattice and the volume appears. Deterministic
     * because a cloud that reshuffled itself every mount would be a different object each time.
     */
    const depthJitter = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      const noise = Math.sin(index * 12.9898) * 43758.5453;
      depthJitter[index] = 0.62 + (noise - Math.floor(noise)) * 0.38;
    }

    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const next = Math.min(window.devicePixelRatio || 1, MAX_DPR[live.current.graphics]);
      if (rect.width === width && rect.height === height && next === dpr) return;
      width = rect.width;
      height = rect.height;
      dpr = next;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(wrap);

    /*
     * Visibility, on two axes.
     *
     * A hidden tab and a core scrolled off a phone are the same problem — frames nobody sees — and
     * both are common on a screen meant to stay open all day. `IntersectionObserver` handles the
     * second without a scroll listener.
     */
    let onScreen = true;
    const intersect = new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((entry) => entry.isIntersecting);
        if (onScreen && frame === null) start();
      },
      { threshold: 0.01 },
    );
    intersect.observe(wrap);

    let frame: number | null = null;
    let rotation = 0;
    let smoothedLevel = 0;
    let smoothedGlow = CORE_MOTION[state].glow;
    let last = 0;

    const draw = (now: number) => {
      const delta = last === 0 ? 16 : Math.min(64, now - last);
      last = now;

      const current = live.current;
      const tuning = CORE_MOTION[current.state];
      const tone = TONE_RGB[CORE_STATE_TONE[current.state]];

      /*
       * Only a real level moves the core, and only where the state says one is trustworthy.
       * Everywhere else `reactivity` is zero and this term vanishes, so a stale number left in a
       * prop cannot leak into the animation.
       */
      const measured = current.levelSource ? current.levelSource() : current.level;
      const target =
        measured === null || measured === undefined ? 0 : Math.min(1, Math.max(0, measured));
      smoothedLevel += (target * tuning.reactivity - smoothedLevel) * 0.18;
      smoothedGlow += (tuning.glow - smoothedGlow) * 0.06;

      if (current.motion) rotation += tuning.spin * delta * 0.06;

      const cx = (width / 2) * dpr;
      const cy = (height / 2) * dpr;
      /* 0.30 of the smaller edge: the point cloud sits well inside the inner ring at every size. */
      const radius = Math.min(width, height) * 0.3 * dpr * (1 + smoothedLevel * 0.06);

      const lite = current.graphics === 'lite';

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      /*
       * Additive blending, which is what makes a point cloud read as *lit* rather than as a
       * stipple pattern. Where points overlap the light accumulates, so the dense middle of the
       * sphere glows and the sparse edge falls away — the same reason a real photograph of a
       * light source has a hot centre. Skipped in lite mode, where the cost is not worth it.
       */
      ctx.globalCompositeOperation = lite ? 'source-over' : 'lighter';

      const sinY = Math.sin(rotation);
      const cosY = Math.cos(rotation);
      /* A slow nod as well as a spin, so the cloud never looks like a flat disc turning. */
      const tilt = Math.sin(rotation * 0.31) * 0.28;
      const sinX = Math.sin(tilt);
      const cosX = Math.cos(tilt);

      const agitation = tuning.agitation + smoothedLevel * 0.25;

      for (let index = 0; index < count; index += 1) {
        const x0 = points[index * 3] ?? 0;
        const y0 = points[index * 3 + 1] ?? 0;
        const z0 = points[index * 3 + 2] ?? 0;

        /* Y rotation, then X — two matrices folded into six multiplies per point. */
        const x1 = x0 * cosY - z0 * sinY;
        const z1 = x0 * sinY + z0 * cosY;
        const y1 = y0 * cosX - z1 * sinX;
        const z2 = y0 * sinX + z1 * cosX;

        /*
         * The breathing shell. Each point drifts along its own normal on its own phase, so the
         * cloud shimmers rather than pulsing as one object. Bounded hard: the sphere must stay a
         * sphere, because a boiling core reads as broken rather than as busy.
         */
        const wobble =
          1 + agitation * Math.sin(rotation * 2.1 + (phase[index] ?? 0) * Math.PI * 2) * 0.5;

        const shell = wobble * (depthJitter[index] ?? 1);
        const px = cx + x1 * radius * shell;
        const py = cy + y1 * radius * shell;

        /* Depth: −1 at the back, +1 at the front. Everything visual is a function of it. */
        const depth = z2;
        const front = (depth + 1) / 2;
        /*
         * Cubed, not linear. A linear falloff spreads the light evenly and the sphere flattens
         * into a disc of identical dots; weighting the near face hard is what gives it a face.
         */
        const lean = front * front * front;
        const alpha = (0.05 + lean * 0.85) * (0.4 + smoothedGlow * 0.6);
        const size = (lite ? 1 : 0.5 + lean * 1.9) * dpr;

        /* Points at the front pick up the cyan; the ones behind stay in the deeper blue. */
        const mix = lean;
        const r = Math.round(tone[0] * (0.35 + mix * 0.65));
        const g = Math.round(tone[1] * (0.45 + mix * 0.55) + mix * 40);
        const b = Math.round(Math.min(255, tone[2] * (0.6 + mix * 0.4) + mix * 60));

        ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
        if (lite) {
          ctx.fillRect(px, py, size, size);
        } else {
          ctx.beginPath();
          ctx.arc(px, py, size, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      /*
       * The heart. One soft radial fill over the middle of the cloud, so the core has a bright
       * centre the way a lamp does. Painted last and additively, so it lifts the points rather
       * than covering them.
       */
      if (!lite) {
        const heart = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.15);
        const strength = (0.16 + smoothedGlow * 0.24).toFixed(3);
        heart.addColorStop(0, `rgba(${tone[0]},${tone[1]},${tone[2]},${strength})`);
        heart.addColorStop(
          0.55,
          `rgba(${tone[0]},${tone[1]},${tone[2]},${(Number(strength) * 0.35).toFixed(3)})`,
        );
        heart.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = heart;
        ctx.beginPath();
        ctx.arc(cx, cy, radius * 1.15, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';

      if (!current.motion) {
        frame = null;
        return;
      }
      frame = requestAnimationFrame(draw);
    };

    const start = () => {
      if (frame !== null) return;
      if (document.hidden || !onScreen) return;
      last = 0;
      frame = requestAnimationFrame(draw);
    };

    const stop = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };

    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVisibility);

    if (motion) start();
    else requestAnimationFrame(draw); /* One frame: standing still, but still itself. */

    return () => {
      stop();
      observer.disconnect();
      intersect.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    /*
     * Deliberately not depending on `state` or `level`: the loop reads those from `live` so it is
     * never rebuilt mid-animation. It is rebuilt only when the particle budget itself changes.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphics, motion]);

  const tone = CORE_STATE_TONE[state];

  return (
    <div
      ref={wrapRef}
      /*
       * Square, and sized entirely by the caller. Not `w-full`: on a short wide screen the core
       * has to be sized by the *height* available to it, and a hard-coded width would push the
       * status line underneath it off the bottom of the composition.
       */
      className={`relative aspect-square ${className ?? ''}`}
      aria-hidden
      data-core-state={state}
      data-testid="jarvis-core"
    >
      {/* The light. Behind everything, and the only thing that makes the core look lit. */}
      <div
        className="jx-soft-glow pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--jx-${tone === 'blue' ? 'blue' : tone}) 34%, transparent) 0%, transparent 62%)`,
          opacity: `calc(var(--jx-glow) * ${CORE_MOTION[state].glow.toFixed(2)})`,
          transition: 'opacity 700ms ease',
          filter: 'blur(18px)',
        }}
      />

      <canvas ref={canvasRef} className="absolute inset-0" />

      <CoreRings state={state} activity={activity} motion={motion} />
    </div>
  );
}

/**
 * The ring assembly.
 *
 * Every ring is a plain SVG shape and every rotation is a CSS animation on a group, so the whole
 * thing costs one composited layer and no JavaScript per frame. Durations are derived from the
 * state's spin so the rings speed up together instead of drifting into an unreadable tangle.
 */
function CoreRings({
  state,
  activity,
  motion,
}: {
  state: CoreState;
  activity: number;
  motion: boolean;
}) {
  const tone = CORE_STATE_TONE[state];
  const spin = CORE_MOTION[state].spin;
  /* Seconds per revolution for the outermost ring; the others are multiples of it. */
  const base = Math.max(6, 1 / Math.max(spin, 0.001) / 12);

  /*
   * Two colours, and the difference between them is the whole point.
   *
   * `structure` is the instrumentation — the ticks, the dashed rings, the faint outer frame. It
   * stays blue in every state, because it is Jarvis's identity rather than its mood, and because
   * an interface whose every line turns red is one an eye stops reading rather than one it reads
   * faster. `accent` is the state: the inner boundary, the cardinal marks, the activity dots and
   * the glow. That is more than enough to be unmistakable from across a room, and it leaves the
   * geometry legible while it happens.
   */
  const structure = 'var(--jx-blue)';
  const accent = `var(--jx-${tone === 'blue' ? 'blue' : tone})`;
  const anim = (seconds: number) =>
    motion ? { animationDuration: `${seconds.toFixed(1)}s` } : { animation: 'none' };

  /* 120 ticks with every fifth longer: dense enough to read as instrumentation, not as noise. */
  const ticks = Array.from({ length: 120 }, (_, index) => index);

  /*
   * The outer activity accents are the one part of the core that is a *count*, not a mood. Four
   * marks at most, so a queue of thirty does not turn the ring into a solid line, and none at all
   * when nothing is running.
   */
  const accents = Math.min(4, Math.max(0, activity));

  /*
   * Rounded, because Node and V8-in-the-browser do not agree on the last bit of `Math.cos`.
   *
   * Every tick below is a trig call rendered twice — once into the server's HTML and once during
   * hydration — and a coordinate that comes out as 126.78740424635598 on one and ...599 on the
   * other is a hydration mismatch React reports as a broken tree. Three decimals is far finer
   * than a pixel at any size this is drawn, and it makes the two agree exactly.
   */
  const on = (angle: number, radius: number) => ({
    x: Math.round((200 + Math.cos(angle) * radius) * 1000) / 1000,
    y: Math.round((200 + Math.sin(angle) * radius) * 1000) / 1000,
  });

  return (
    <svg
      viewBox="0 0 400 400"
      className="absolute inset-0 h-full w-full overflow-visible"
      fill="none"
    >
      {/* Outermost: a broken ring, turning slowly. */}
      <g className="jx-rot" style={anim(base * 4)}>
        <circle
          cx="200"
          cy="200"
          r="194"
          stroke={structure}
          strokeOpacity="0.28"
          strokeWidth="1"
          strokeDasharray="2 10"
        />
      </g>

      {/* A continuous hairline just inside it, so the outer edge has a defined boundary. */}
      <circle cx="200" cy="200" r="184" stroke={structure} strokeOpacity="0.16" strokeWidth="1" />

      {/* The tick ring. Static: instrumentation that turned would be harder to read, not easier. */}
      <g opacity="0.55">
        {ticks.map((index) => {
          const angle = (index / ticks.length) * Math.PI * 2;
          const major = index % 5 === 0;
          const from = on(angle, major ? 166 : 174);
          const to = on(angle, 180);
          return (
            <line
              key={index}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={structure}
              strokeOpacity={major ? 0.8 : 0.32}
              strokeWidth={major ? 1.5 : 0.8}
            />
          );
        })}
      </g>

      {/* Segmented arcs, counter-rotating so the assembly reads as several independent parts. */}
      <g className="jx-rot jx-rot-r" style={anim(base * 2.6)}>
        <circle
          cx="200"
          cy="200"
          r="156"
          stroke={structure}
          strokeOpacity="0.6"
          strokeWidth="2"
          strokeDasharray="88 40 24 40 56 90"
          strokeLinecap="round"
        />
      </g>

      <g className="jx-rot" style={anim(base * 3.4)}>
        <circle
          cx="200"
          cy="200"
          r="148"
          stroke={accent}
          strokeOpacity="0.45"
          strokeWidth="1"
          strokeDasharray="30 260 14 60"
          strokeLinecap="round"
        />
      </g>

      <g className="jx-rot" style={anim(base * 1.7)}>
        <circle
          cx="200"
          cy="200"
          r="138"
          stroke={structure}
          strokeOpacity="0.34"
          strokeWidth="1"
          strokeDasharray="4 14"
        />
      </g>

      {/* The inner boundary: the brightest continuous line, and the edge the cloud sits inside. */}
      <circle cx="200" cy="200" r="118" stroke={accent} strokeOpacity="0.95" strokeWidth="1.75" />
      <circle cx="200" cy="200" r="112" stroke={accent} strokeOpacity="0.25" strokeWidth="0.75" />
      <circle
        cx="200"
        cy="200"
        r="96"
        stroke={structure}
        strokeOpacity="0.2"
        strokeWidth="0.75"
        strokeDasharray="1 7"
      />

      {/* Four deliberate accents at the cardinals: the geometry that makes it look aimed. */}
      {[0, 90, 180, 270].map((degrees) => {
        const angle = (degrees * Math.PI) / 180;
        const from = on(angle, 126);
        const to = on(angle, 104);
        return (
          <line
            key={degrees}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke={accent}
            strokeOpacity="0.95"
            strokeWidth="2"
          />
        );
      })}

      {/* Four longer marks off the diagonals, at the tick ring, to break its regularity. */}
      {[45, 135, 225, 315].map((degrees) => {
        const angle = (degrees * Math.PI) / 180;
        const from = on(angle, 180);
        const to = on(angle, 196);
        return (
          <line
            key={degrees}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke={structure}
            strokeOpacity="0.6"
            strokeWidth="1.5"
          />
        );
      })}

      {/*
       * One agent, one mark. This is the only element on the core bound to a count, and it is
       * absent entirely at zero — an empty ring is the honest picture of nothing running.
       */}
      {accents > 0 ? (
        <g className="jx-rot" style={anim(base * 1.1)}>
          {Array.from({ length: accents }, (_, index) => {
            const angle = (index / accents) * Math.PI * 2 - Math.PI / 2;
            const at = on(angle, 194);
            return (
              <circle
                key={index}
                cx={at.x}
                cy={at.y}
                r="4"
                fill="var(--jx-cyan)"
                fillOpacity="0.95"
              />
            );
          })}
        </g>
      ) : null}

      {/*
       * The sweep, shown only while a request is actually in flight. A permanent radar sweep is
       * the most common way an interface like this starts lying: it implies continuous processing
       * on a screen where nothing is happening.
       */}
      {state === 'thinking' && motion ? (
        <g className="jx-rot" style={anim(2.2)}>
          <path d="M200 200 L200 44 A156 156 0 0 1 310 90 Z" fill="url(#jx-sweep)" opacity="0.5" />
        </g>
      ) : null}

      <defs>
        <radialGradient id="jx-sweep">
          <stop offset="0%" stopColor="var(--jx-cyan)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--jx-cyan)" stopOpacity="0" />
        </radialGradient>
      </defs>
    </svg>
  );
}
