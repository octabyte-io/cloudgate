import { checkCatalogue } from '../../../src/templates/check';
import type { CatalogueCheck, Template } from '../../../src/templates/check';
import { catalogueZip } from '../zip.fixture';

/**
 * The Template check's fixtures: whole `catalogue.zip` files (ADR-0072), as
 * the catalogue reader, the setup service and `cloudgate template check` all
 * feed it, and the helpers that judge it by what it offers and why it hides
 * the rest.
 *
 * The zip is written by `catalogueZip`, the tests' own zip writer, rather than
 * by the module's `encodeCatalogue`, so a change to the format shows up as a
 * red test instead of moving both sides at once.
 */

/** One template folder: its id (the folder name) and its files by path. */
export interface Folder {
  id: string;
  revision?: string;
  files: Record<string, string | { base64: string }>;
}

export function catalogue(...folders: Folder[]): Uint8Array {
  return catalogueZip(folders);
}

export const SQUARE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30"/></svg>';

/**
 * A Ghost-like template: an own `postgres`, a compose part on a pinned image
 * and every `template.yaml` field written once.
 */
export function ghost(
  overrides: {
    id?: string;
    templateYaml?: string;
    cloudgateYaml?: string;
    compose?: string | null;
    files?: Record<string, string | { base64: string } | null>;
  } = {},
): Folder {
  const files: Record<string, string | { base64: string }> = {
    'template.yaml':
      overrides.templateYaml ??
      `name: Ghost
description: A publishing platform for blogs and newsletters.
version: "5.96"
tags: [blog, cms]
links:
  website: https://ghost.org
  docs: https://ghost.org/docs
  source: https://github.com/TryGhost/Ghost
cloudgate: 0.1.0
compose: app
size: small
inputs:
  DB_PASSWORD: { generate: password }
  ADMIN_EMAIL:
    ask: { label: Admin email, format: email }
domains:
  - { service: ghost, port: 2368 }
files:
  - { path: config.production.json }
`,
    'cloudgate.yaml':
      overrides.cloudgateYaml ??
      `version: 1
services:
  app: { kind: compose, managed: console }
  db:
    kind: postgres
    version: "16"
`,
    'logo.svg': SQUARE_SVG,
    'files/config.production.json': '{ "url": "{{domains.ghost.url}}" }',
  };
  const compose =
    overrides.compose === undefined
      ? `services:
  ghost:
    image: ghost:5.96-alpine
    environment:
      database__connection__password: \${DB_PASSWORD}
      mail__from: \${ADMIN_EMAIL}
`
      : overrides.compose;
  if (compose !== null) files['docker-compose.yml'] = compose;
  for (const [path, content] of Object.entries(overrides.files ?? {})) {
    if (content === null) delete files[path];
    else files[path] = content;
  }
  return { id: overrides.id ?? 'ghost', files };
}

export const INSTANCE = { cloudgateVersion: '0.1.0' };

export function checked(
  ...folders: Folder[]
): Extract<CatalogueCheck, { ok: true }> {
  const result = checkCatalogue(catalogue(...folders), INSTANCE);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result;
}

/** The reason the whole zip holding `folders` is refused (ADR-0072). */
export function refusal(...folders: Folder[]): string {
  const result = checkCatalogue(catalogue(...folders), INSTANCE);
  if (result.ok) throw new Error('read, not refused');
  return result.reason;
}

export function offered(folder: Folder): Template {
  const result = checked(folder);
  if (result.hidden.length > 0) {
    throw new Error(`hidden: ${result.hidden[0].reason}`);
  }
  return result.offered[0];
}

export function hiddenReason(folder: Folder): string {
  const result = checked(folder);
  expect(result.offered).toEqual([]);
  expect(result.hidden).toHaveLength(1);
  expect(result.hidden[0].id).toBe(folder.id);
  return result.hidden[0].reason;
}

/** A PNG's signature and IHDR chunk, which is all the check reads of one. */
export function png(width: number, height: number): { base64: string } {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return { base64: bytes.toString('base64') };
}
