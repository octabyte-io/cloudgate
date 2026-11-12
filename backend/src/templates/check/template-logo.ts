import type { CatalogueFileContent } from './catalogue-file';

/** A template's logo, as the backend serves it (logos travel inside the catalogue). */
export interface TemplateLogo {
  readonly mediaType: 'image/svg+xml' | 'image/png';
  readonly bytes: Uint8Array;
}

/** The largest logo a template may carry. */
export const LOGO_MAX_BYTES = 100 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The template's logo: `logo.svg`, or `logo.png` only when there is no SVG,
 * square and at most 100 KB. Square because the console draws every logo in
 * the same square tile; a wide one would be squeezed or cropped there.
 */
export function readLogo(
  files: Readonly<Record<string, CatalogueFileContent>>,
): { ok: true; logo: TemplateLogo } | { ok: false; reason: string } {
  const svg = files['logo.svg'];
  const png = files['logo.png'];
  if (svg !== undefined && png !== undefined) {
    return {
      ok: false,
      reason:
        'has both logo.svg and logo.png; logo.png is only for a template with no SVG',
    };
  }
  if (svg !== undefined) {
    if (typeof svg !== 'string') {
      return { ok: false, reason: 'logo.svg must be text' };
    }
    const bytes = Buffer.from(svg, 'utf8');
    const problem = sizeProblem('logo.svg', bytes) ?? svgSquareProblem(svg);
    if (problem) return { ok: false, reason: problem };
    return { ok: true, logo: { mediaType: 'image/svg+xml', bytes } };
  }
  if (png !== undefined) {
    if (typeof png === 'string') {
      return { ok: false, reason: 'logo.png must be written as { base64 }' };
    }
    const bytes = Buffer.from(png.base64, 'base64');
    const problem = sizeProblem('logo.png', bytes) ?? pngSquareProblem(bytes);
    if (problem) return { ok: false, reason: problem };
    return { ok: true, logo: { mediaType: 'image/png', bytes } };
  }
  return { ok: false, reason: 'has no logo; add logo.svg (or logo.png)' };
}

function sizeProblem(name: string, bytes: Uint8Array): string | null {
  if (bytes.byteLength <= LOGO_MAX_BYTES) return null;
  const kb = Math.ceil(bytes.byteLength / 1024);
  return `${name} is ${kb} KB; a logo is at most ${LOGO_MAX_BYTES / 1024} KB`;
}

function squareProblem(
  name: string,
  width: number,
  height: number,
): string | null {
  return width === height
    ? null
    : `${name} is ${width}×${height}; a logo must be square`;
}

/** The root `<svg>`'s `viewBox`, else its `width` and `height`. */
function svgSquareProblem(svg: string): string | null {
  const root = /<svg\b([^>]*)>/i.exec(svg);
  if (!root) return 'logo.svg is not an SVG image';
  const attribute = (name: string) =>
    new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root[1])?.[1];

  const viewBox = attribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    return squareProblem('logo.svg', viewBox[2], viewBox[3]);
  }
  const width = Number(attribute('width')?.replace(/px$/, ''));
  const height = Number(attribute('height')?.replace(/px$/, ''));
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0) {
    return squareProblem('logo.svg', width, height);
  }
  return 'logo.svg states no size; give its <svg> a square viewBox';
}

/** The IHDR chunk's width and height, which a PNG always carries first. */
function pngSquareProblem(bytes: Uint8Array): string | null {
  const isPng =
    bytes.byteLength >= 24 &&
    PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
  if (!isPng) return 'logo.png is not a PNG image';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return squareProblem('logo.png', view.getUint32(16), view.getUint32(20));
}
