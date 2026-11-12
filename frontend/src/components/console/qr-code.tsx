import { encode } from "uqr";

import { cn } from "@/lib/utils";

/**
 * A QR code, drawn as one SVG path (F16).
 *
 * **Why a dependency at all.** A QR encoder is Reed–Solomon error correction,
 * mask-pattern selection and a version/capacity table; writing one is a week and
 * every bug in it produces a code that scans on the phone you tested with and
 * not on the next one. `uqr` is ~5KB, has **no dependencies of its own**, and is
 * pure — it takes a string and returns a matrix of booleans.
 *
 * **Why `encode` and not its own `renderSVG`.** That helper writes literal
 * `"black"` and `"white"` into the markup, which is two hardcoded colours in a
 * codebase whose first rule forbids them, and it emits one `<rect>` per dark
 * module — a few thousand nodes for an `otpauth://` URI. This builds a single
 * `<path>` and paints it with `--paper` and `--paper-ink`.
 *
 * **It does not switch with the theme**, and `globals.css` argues that where the
 * tokens are declared: a decoder expects dark modules on a light field, and this
 * is the screen where "it works on my phone and not on hers" costs somebody their
 * account.
 *
 * `role="img"` with a real label, because the alternative for anyone not using a
 * camera is the secret in text — which is why the card beside this always shows
 * that too, rather than treating the QR as the only way in.
 */
export function QrCode({
  value,
  label,
  className,
  /** Modules of empty space around the code. Four is the spec's quiet zone. */
  quietZone = 4,
}: {
  value: string;
  label: string;
  className?: string;
  quietZone?: number;
}) {
  const { data, size } = encode(value, { ecc: "M", border: 0 });
  const span = size + quietZone * 2;

  // One path, one `M x y h1v1h-1z` per dark module. Rendered at 1 unit per
  // module and scaled by the viewBox, so it is crisp at any size and the file
  // does not care how big the box is.
  let path = "";
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (data[y][x]) {
        path += `M${x + quietZone} ${y + quietZone}h1v1h-1z`;
      }
    }
  }

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${span} ${span}`}
      className={cn("size-44 rounded-lg", className)}
      // `shapeRendering` keeps module edges from being antialiased into grey,
      // which is what makes a small code fail to decode on a low-light camera.
      shapeRendering="crispEdges"
    >
      <rect width={span} height={span} fill="var(--paper)" />
      <path d={path} fill="var(--paper-ink)" />
    </svg>
  );
}
