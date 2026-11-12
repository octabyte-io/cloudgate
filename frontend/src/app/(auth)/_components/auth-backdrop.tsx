/**
 * The picture behind every auth screen: a gate come apart into floating
 * blocks, standing on a floor that runs to the horizon, with racks on either
 * side wired into it and clouds in the sky and round its feet.
 *
 * Line art in the theme's own tokens, so it follows light and dark without a
 * second drawing: strokes are `--line-2`, and anything that should hide what
 * is behind it (the gate's blocks, the clouds in front of the floor) is filled
 * with `--ground`. The one colour is a `--brand` glow behind the form, so an
 * operator's brand colour reaches it too. The keyhole in the keystone is the
 * one in the glyph.
 *
 * Quiet on purpose. A mask thins the whole drawing behind the column the form
 * lives in, so the heading and lede that sit on it directly still read as text
 * and not as part of the drawing. It is decoration and nothing else:
 * `aria-hidden`, no pointer events, and nothing in it moves.
 *
 * Drawn on a 1440×900 canvas and cropped with `slice`, so a phone sees the
 * gate and a wide screen sees the racks as well.
 */

const W = 1440;
const H = 900;
const CX = W / 2;

/** Where the floor meets the sky. */
const HORIZON = 650;
/** Where the racks' cables meet the gate. */
const PLUG = 330;

/** The floor: rays to a point above the horizon, and rows that widen toward you. */
const VANISH = { x: CX, y: 520 };
const FLOOR_RAYS = Array.from({ length: 31 }, (_, i) => {
  const xb = -1680 + i * 160;
  const t = (HORIZON - VANISH.y) / (H - VANISH.y);
  return { x1: VANISH.x + (xb - VANISH.x) * t, x2: xb };
});
const FLOOR_ROWS = Array.from(
  { length: 7 },
  (_, i) => HORIZON + (H - HORIZON) * ((i + 1) / 7) ** 2,
);

type Rack = { x: number; y: number; w: number };

/** Two racks a side, mirrored; each stands on the horizon. */
const LEFT_RACKS: Rack[] = [
  { x: 70, y: 370, w: 150 },
  { x: 236, y: 440, w: 112 },
];
const RACKS: Rack[] = [
  ...LEFT_RACKS,
  ...LEFT_RACKS.map((r) => ({ ...r, x: W - r.x - r.w })),
];

function RackDrawing({ x, y, w }: Rack) {
  const h = HORIZON - y;
  const slots = Math.floor((h - 24) / 22);
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={4} />
      <rect x={x + 8} y={y + 8} width={w - 16} height={h - 16} rx={2} />
      {Array.from({ length: slots }, (_, i) => {
        const sy = y + 12 + i * 22;
        return (
          <g key={i}>
            <line x1={x + 8} y1={sy + 22} x2={x + w - 8} y2={sy + 22} />
            <line x1={x + 18} y1={sy + 11} x2={x + w * 0.45} y2={sy + 11} />
            <circle cx={x + w - 22} cy={sy + 11} r={2.5} />
          </g>
        );
      })}
    </g>
  );
}

/**
 * A cloud as one outline: a run of arcs over the points of its top edge, then
 * a flat base. Each arc bulges outward, which is what makes it a cloud and not
 * a mountain range.
 */
function cloud(x: number, y: number, scale: number) {
  const top: [number, number][] = [
    [0, 0],
    [12, -26],
    [46, -50],
    [92, -42],
    [126, -64],
    [170, -40],
    [196, -14],
    [200, 0],
  ];
  const pts = top.map(([px, py]) => [x + px * scale, y + py * scale]);
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const r = Math.hypot(bx - ax, by - ay) * 0.56;
    d += ` A ${r} ${r} 0 0 1 ${bx} ${by}`;
  }
  return `${d} Z`;
}

/** Clouds in the sky, behind everything. */
const SKY_CLOUDS = [
  { x: 120, y: 190, s: 0.9 },
  { x: 280, y: 78, s: 0.55 },
  { x: 1170, y: 70, s: 0.6 },
  { x: 1180, y: 250, s: 1 },
];
/** Clouds around the gate's feet, in front of the floor and filled so they hide it. */
const LOW_CLOUDS = [
  { x: 300, y: HORIZON + 18, s: 0.95 },
  { x: 160, y: HORIZON + 40, s: 0.8 },
  { x: 960, y: HORIZON + 22, s: 1.05 },
  { x: 1130, y: HORIZON + 44, s: 0.75 },
];

/** A few points of light. */
const STARS: [number, number][] = [
  [260, 60],
  [520, 150],
  [610, 70],
  [870, 56],
  [930, 170],
  [1300, 90],
  [70, 300],
  [1380, 360],
];

export function AuthBackdrop() {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid slice"
      className="pointer-events-none fixed inset-0 -z-10 size-full text-line-2"
    >
      <defs>
        <radialGradient id="auth-backdrop-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.16} />
          <stop offset="100%" stopColor="var(--brand)" stopOpacity={0} />
        </radialGradient>
        {/* Thinner behind the form column, full strength toward the edges. */}
        <radialGradient
          id="auth-backdrop-fade"
          cx={CX}
          cy={380}
          r={760}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#fff" stopOpacity={0.4} />
          <stop offset="28%" stopColor="#fff" stopOpacity={0.5} />
          <stop offset="60%" stopColor="#fff" stopOpacity={1} />
        </radialGradient>
        <mask id="auth-backdrop-mask">
          <rect width={W} height={H} fill="url(#auth-backdrop-fade)" />
        </mask>
      </defs>

      <ellipse
        cx={CX}
        cy={470}
        rx={360}
        ry={300}
        fill="url(#auth-backdrop-glow)"
      />

      <g
        mask="url(#auth-backdrop-mask)"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {STARS.map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r={1.5} />
        ))}
        {SKY_CLOUDS.map((c) => (
          <path key={`${c.x}-${c.y}`} d={cloud(c.x, c.y, c.s)} />
        ))}

        {/* Floor */}
        <line x1={0} y1={HORIZON} x2={W} y2={HORIZON} />
        {FLOOR_RAYS.map((r) => (
          <line key={r.x2} x1={r.x1} y1={HORIZON} x2={r.x2} y2={H} />
        ))}
        {FLOOR_ROWS.map((y) => (
          <line key={y} x1={0} y1={y} x2={W} y2={y} />
        ))}

        {RACKS.map((r) => (
          <RackDrawing key={r.x} {...r} />
        ))}
        {/* After the racks, so the gate stands in front of them. */}
        <FragmentGate base={HORIZON} />
        {/* The cables that run from the racks into the gate. */}
        <g strokeDasharray="4 6">
          <path d={`M 220 400 C 300 330, 340 330, ${CX - PLUG} 400`} />
          <path d={`M 348 470 C 360 440, 372 440, ${CX - PLUG} 470`} />
          <path
            d={`M ${W - 220} 400 C ${W - 300} 330, ${W - 340} 330, ${CX + PLUG} 400`}
          />
          <path
            d={`M ${W - 348} 470 C ${W - 360} 440, ${W - 372} 440, ${CX + PLUG} 470`}
          />
        </g>
        {[
          [CX - PLUG, 400],
          [CX - PLUG, 470],
          [CX + PLUG, 400],
          [CX + PLUG, 470],
        ].map(([x, y]) => (
          <circle
            key={`${x}-${y}`}
            cx={x}
            cy={y}
            r={3.5}
            fill="var(--ground)"
          />
        ))}

        {LOW_CLOUDS.map((c) => (
          <path
            key={`${c.x}-${c.y}`}
            d={cloud(c.x, c.y, c.s)}
            fill="var(--ground)"
          />
        ))}
      </g>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* The gate                                                            */
/* ------------------------------------------------------------------ */

/** The glyph's keyhole, centred on (x, y) at scale `s` (the glyph is s = 1). */
function Keyhole({ x, y, s }: { x: number; y: number; s: number }) {
  const top = y - 3.5 * s;
  return (
    <g fill="currentColor" stroke="none" opacity={0.65}>
      <circle cx={x} cy={top} r={2.8 * s} />
      <path
        d={`M ${x - 1.1 * s} ${top + s} L ${x - 2.3 * s} ${top + 8.5 * s} H ${x + 1.5 * s} L ${x + 1.1 * s} ${top + s} Z`}
      />
    </g>
  );
}

const ARCH = { spring: 390, outer: 330, inner: 270, blocks: 11, gapDeg: 2.6 };

/** A small deterministic jitter, so the server and the client agree. */
function jitter(i: number, salt: number) {
  const v = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v) - 0.5;
}

/** One block of the arch: an annular sector, pushed out from the centre. */
function voussoir(i: number) {
  const step = 180 / ARCH.blocks;
  const a0 = ((i * step + ARCH.gapDeg / 2) * Math.PI) / 180;
  const a1 = (((i + 1) * step - ARCH.gapDeg / 2) * Math.PI) / 180;
  const mid = (a0 + a1) / 2;
  // The blocks nearest the crown have drifted furthest.
  const crown = 1 - Math.abs(mid - Math.PI / 2) / (Math.PI / 2);
  const d = 4 + 10 * (jitter(i, 1) + 0.5) + 16 * crown ** 3;
  const ox = d * Math.cos(mid);
  const oy = -d * Math.sin(mid);
  const pt = (r: number, a: number) =>
    `${CX + r * Math.cos(a) + ox} ${ARCH.spring - r * Math.sin(a) + oy}`;
  return {
    d: `M ${pt(ARCH.outer, a0)} A ${ARCH.outer} ${ARCH.outer} 0 0 0 ${pt(ARCH.outer, a1)} L ${pt(ARCH.inner, a1)} A ${ARCH.inner} ${ARCH.inner} 0 0 1 ${pt(ARCH.inner, a0)} Z`,
    cx: CX + ((ARCH.outer + ARCH.inner) / 2) * Math.cos(mid) + ox,
    cy: ARCH.spring - ((ARCH.outer + ARCH.inner) / 2) * Math.sin(mid) + oy,
    turn: 5 * jitter(i, 2) * (0.4 + crown),
    key: i === (ARCH.blocks - 1) / 2,
  };
}

/** Pebbles that have come right away, near the crown. */
const DEBRIS = [
  { x: CX - 150, y: 46, s: 12, turn: 18 },
  { x: CX + 124, y: 34, s: 9, turn: -24 },
  { x: CX + 228, y: 80, s: 7, turn: 40 },
  { x: CX - 246, y: 96, s: 6, turn: -12 },
];

/**
 * An arch come apart: its blocks hang a little out from where they belong, the ones at the crown furthest, a few pieces have
 * floated away altogether, and the pillars are stacks of blocks that do not
 * quite line up. The keystone carries the keyhole.
 */
function FragmentGate({ base }: { base: number }) {
  const blocks = Array.from({ length: ARCH.blocks }, (_, i) => voussoir(i));
  const courses = Math.ceil((base - ARCH.spring) / 40);
  return (
    <g>
      {[-1, 1].map((side) =>
        Array.from({ length: courses }, (_, j) => {
          const y = ARCH.spring + 6 + j * 40;
          const dx = 7 * jitter(j, side + 5);
          const x = side < 0 ? CX - ARCH.outer : CX + ARCH.inner;
          return (
            <rect
              key={`${side}-${j}`}
              x={x + dx}
              y={y}
              width={ARCH.outer - ARCH.inner}
              height={Math.min(34, base - y)}
              rx={2}
              fill="var(--ground)"
            />
          );
        }),
      )}
      {blocks.map((b, i) => (
        <g key={i} transform={`rotate(${b.turn} ${b.cx} ${b.cy})`}>
          <path
            d={b.d}
            fill="var(--ground)"
            strokeWidth={b.key ? 1.75 : 1.25}
          />
          {b.key ? <Keyhole x={b.cx} y={b.cy} s={3} /> : null}
        </g>
      ))}
      {DEBRIS.map((p) => (
        <rect
          key={p.x}
          x={p.x - p.s / 2}
          y={p.y - p.s / 2}
          width={p.s}
          height={p.s}
          rx={1}
          transform={`rotate(${p.turn} ${p.x} ${p.y})`}
          fill="var(--ground)"
        />
      ))}
    </g>
  );
}
