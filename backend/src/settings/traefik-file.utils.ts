import * as path from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { isMap, isPair, isScalar, isSeq, parseDocument, visit } from 'yaml';
import type { Document, Scalar } from 'yaml';
import { CERTIFICATE_KEY_FILE } from '../traefik/traefik-writer.service';

/**
 * What the console's Traefik file surface refuses to open, and what it cuts out
 * of the files it does open.
 *
 * **What broke first.** `GET /settings/traefik/file` confined a path to the
 * Traefik directory and excluded nothing inside it, so one click in the Files
 * tree served `dynamic/certificates/<cert>/privkey.key` — the key the
 * Certificates form promises is "Never shown again once saved", and stores
 * `enc:v1:` — plus `dynamic/acme.json`, which holds the Let's Encrypt account
 * key and every issued certificate's key. And every `dynamic/app-*.yml` with a
 * basic-auth user served its bcrypt htpasswd entry to the Application's
 * Advanced → Traefik configuration card, which reads the same route, though
 * `SecurityService` never sends that password back and already cuts the
 * same entries out of Traefik's error text (`TraefikVerifyInput.secrets`).
 *
 * Two different answers, because the two kinds of file differ in what is left
 * once the secret is gone:
 *
 * - **A key file is withheld whole.** There is nothing in `privkey.key` but the
 *   key, and a hand edit of `acme.json` can corrupt every certificate Traefik
 *   issued. So both are refused for a read *and* a write (403), and the
 *   directory walk marks them, so the tree can say why rather than failing on
 *   click.
 * - **A config file is served with its htpasswd entries redacted** to
 *   `user:<redacted>`, because the rest of the file is what an operator opened
 *   it for. A save of such a file puts the stored entry back for every user
 *   still reading `<redacted>` (see {@link restoreRedactedUsers}) — rejected:
 *   refusing any save that carries the marker, which would make an
 *   Application's file uneditable here the moment it has one basic-auth user,
 *   and writing it through, which replaces a working password with a literal
 *   Traefik cannot verify.
 */

/** What a redacted htpasswd entry carries in place of its hash. */
export const REDACTED_SECRET = '<redacted>';

/**
 * The file names that hold private-key material, by rule rather than by list.
 *
 * `CERTIFICATE_KEY_FILE` is the name `TraefikWriterService.writeCertificate`
 * gives every key it writes, and is imported rather than spelled so the two
 * cannot drift; `test/traefik/key-material-census.spec.ts` holds every key the
 * writer writes to this rule. Any other `*.key` is caught too, because an
 * operator who dropped one into the tree by hand made it no less a key.
 * `acme.json` is written by Traefik itself, at the `storage` path
 * `serverSetupCommand` and `deploy/install.sh` configure.
 */
function holdsKeyMaterial(fileName: string): boolean {
  return (
    fileName === CERTIFICATE_KEY_FILE ||
    fileName === 'acme.json' ||
    path.extname(fileName).toLowerCase() === '.key'
  );
}

/** A PEM private-key block, whatever file it was put in. */
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

/** The sentence a withheld file answers with, naming it. */
export function withheldFileRefusal(filePath: string): string {
  return `${path.basename(filePath)} holds private key material, which the console neither shows nor overwrites`;
}

/**
 * Why a file under the Traefik directory is not opened, or null when it may be.
 * The name decides, so the walk can mark a file without reading it.
 */
export function withheldReason(filePath: string): string | null {
  return holdsKeyMaterial(path.basename(filePath))
    ? withheldFileRefusal(filePath)
    : null;
}

/**
 * Whether file *contents* are key material a name did not announce — a PEM key
 * pasted into a `.yml`, or a symlink to one. Checked on a read only, after the
 * name: it is what stands between the refusal above and a file named anything
 * else.
 */
export function carriesPrivateKey(content: string): boolean {
  return PEM_PRIVATE_KEY.test(content);
}

/** Whether a path names a YAML file, which is what Traefik's file provider reads. */
export const isYamlFile = (filePath: string) => /\.ya?ml$/i.test(filePath);

/**
 * The first line of a `yaml` parse error, which already names the line and
 * column (`… at line 2, column 1:`), without the prettified source excerpt or
 * the trailing colon that introduced it.
 */
function parseErrorSentence(message: string): string {
  return message.split('\n')[0].replace(/:\s*$/, '');
}

/**
 * Refuses YAML Traefik would refuse, before it is written.
 *
 * **Why at the save, when nothing fails at the save.** `traefik.yml` is read
 * once, when Traefik starts, so a broken one takes every domain down at the next
 * restart or recreate — which **Restart Traefik** and the env, ports and
 * dashboard controls all cause — long after, and far from, the edit. A file in
 * `dynamic/` is re-read within seconds and fails as quietly. So this is the one
 * moment the mistake can be tied to the person making it.
 *
 * `parseDocument` rather than `parse`: it hands its errors back on the document
 * rather than throwing the first, and is not an echo site
 * (`TRAEFIK_YAML_PARSE_OPTIONS`). Duplicate keys are an error here, which
 * matches Traefik's own loader.
 *
 * The shape check is deliberately shallow. A Traefik file is a mapping, and in
 * the static file `entryPoints` and `providers` are mappings too; beyond that,
 * rejected: an allow-list of Traefik's top-level keys, because a key this
 * refused that the running Traefik accepts would lock an operator out of their
 * own configuration, which is worse than the gap it closes.
 */
export function assertTraefikYaml(
  content: string,
  filePath: string,
  kind: 'static' | 'dynamic',
): Document {
  const name = path.basename(filePath);
  const doc = parseDocument(content);
  const [error] = doc.errors;
  if (error) {
    throw new BadRequestException(
      `${name} is not valid YAML: ${parseErrorSentence(error.message)}`,
    );
  }

  const top = doc.contents;
  if (top === null) {
    if (kind === 'static') {
      throw new BadRequestException(`${name} holds no configuration`);
    }
    return doc;
  }
  if (!isMap(top)) {
    throw new BadRequestException(
      `${name} must be a mapping of Traefik settings, not a list or a single value`,
    );
  }
  if (kind === 'static') {
    for (const section of ['entryPoints', 'providers']) {
      const value = top.get(section, true);
      const empty =
        value === undefined || (isScalar(value) && value.value === null);
      if (!empty && !isMap(value)) {
        throw new BadRequestException(
          `${name}: ${section} must be a mapping of names to settings`,
        );
      }
    }
  }
  return doc;
}

/** The middleware kinds whose `users` list holds `user:secret` entries. */
const HTPASSWD_MIDDLEWARES = new Set(['basicauth', 'digestauth']);

/** One `user:secret` entry, and where in the file it sits. */
interface HtpasswdEntry {
  node: Scalar;
  /** The keys from the document root to the `users` list, joined. */
  location: string;
  user: string;
  secret: string;
}

/**
 * Every string in a `basicAuth.users` or `digestAuth.users` list. Keys are
 * matched case-insensitively, so `BasicAuth`/`Users` cannot slip a hash past.
 */
function htpasswdEntries(doc: Document): HtpasswdEntry[] {
  const found: HtpasswdEntry[] = [];
  visit(doc, {
    Pair(_, pair, ancestors) {
      if (!isScalar(pair.key) || !isSeq(pair.value)) return;
      if (String(pair.key.value).toLowerCase() !== 'users') return;
      const owner = ancestors[ancestors.length - 2];
      if (
        !isPair(owner) ||
        !isScalar(owner.key) ||
        !HTPASSWD_MIDDLEWARES.has(String(owner.key.value).toLowerCase())
      ) {
        return;
      }
      const location = [
        ...ancestors.filter(isPair).map((p) => String((p.key as Scalar).value)),
        'users',
      ].join('\0');
      for (const item of pair.value.items) {
        if (!isScalar(item) || typeof item.value !== 'string') continue;
        const at = item.value.indexOf(':');
        found.push({
          node: item,
          location,
          user: at === -1 ? '' : item.value.slice(0, at),
          secret: at === -1 ? item.value : item.value.slice(at + 1),
        });
      }
    },
  });
  return found;
}

/**
 * `source` with each entry's value replaced by the one given, **spliced into
 * the text rather than re-serialised** — both the redacted read and the
 * restoring save go through here.
 *
 * The parsed document only *locates* each entry (`Scalar.range`); the new value
 * goes into the string at exactly that span, in the quoting the entry already
 * had, so comments, key order, quoting and blank lines survive byte for byte
 * everywhere else, and an unchanged save writes back the file it read.
 * Rejected: `doc.toString()`, which is what this did first and which
 * reformatted an operator's whole file on a save that changed nothing. The
 * result is re-parsed and must carry exactly the entries intended; if a splice
 * ever failed that, the re-serialised document is returned instead, because a
 * correct file beats an untouched one.
 */
function rewriteEntries(
  source: string,
  doc: Document,
  rewrites: { entry: HtpasswdEntry; value: string }[],
): string {
  const byStart = [...rewrites].sort(
    (a, b) => (b.entry.node.range?.[0] ?? 0) - (a.entry.node.range?.[0] ?? 0),
  );
  let spliced = source;
  for (const { entry, value } of byStart) {
    const [start, end] = entry.node.range ?? [0, 0];
    spliced =
      spliced.slice(0, start) +
      scalarSource(value, entry.node.type) +
      spliced.slice(end);
  }

  const check = parseDocument(spliced);
  const landed =
    check.errors.length === 0
      ? htpasswdEntries(check).map((entry) => entry.node.value)
      : [];
  const intended = htpasswdEntries(doc).map(
    (entry) =>
      rewrites.find((r) => r.entry.node === entry.node)?.value ??
      entry.node.value,
  );
  if (JSON.stringify(landed) === JSON.stringify(intended)) return spliced;

  for (const { entry, value } of rewrites) entry.node.value = value;
  return doc.toString();
}

/**
 * htpasswd hashes where no YAML structure says where they are: a file that does
 * not parse, a `.toml`, or a `usersFile` an operator keeps in the tree. The
 * three formats Traefik verifies — bcrypt, Apache MD5 and SHA-1.
 */
const LOOSE_HTPASSWD =
  /([^\s'"[\],:]+):(\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}|\$apr1\$[^\s'"\],]+|\{SHA\}[^\s'"\],]+)/g;

/**
 * The file as the console may see it: every htpasswd entry reduced to
 * `user:<redacted>`. Only those entries change: a file with nothing to
 * redact comes back byte for byte, and one with entries differs in them alone
 * ({@link rewriteEntries}).
 */
export function redactHtpasswdUsers(content: string, filePath: string): string {
  let out = content;
  if (isYamlFile(filePath)) {
    const doc = parseDocument(content);
    if (doc.errors.length === 0) {
      const rewrites = htpasswdEntries(doc)
        .filter((entry) => entry.secret !== REDACTED_SECRET)
        .map((entry) => ({
          entry,
          value: entry.user
            ? `${entry.user}:${REDACTED_SECRET}`
            : REDACTED_SECRET,
        }));
      if (rewrites.length > 0) out = rewriteEntries(content, doc, rewrites);
    }
  }
  return out.replace(LOOSE_HTPASSWD, `$1:${REDACTED_SECRET}`);
}

/**
 * How one restored entry is written back into the source text: in the quoting
 * the operator's entry already had, so the edit is the entry and nothing else.
 * A plain scalar stays plain only while the value needs no quoting at all —
 * the htpasswd alphabets (`$`, `/`, `.`, base64) always qualify.
 */
function scalarSource(value: string, type: Scalar['type']): string {
  if (type === 'QUOTE_SINGLE') return `'${value.replace(/'/g, "''")}'`;
  if (
    type === 'PLAIN' &&
    /^[^\s#,[\]{}'"&*!|>%@`-][^\s#,[\]{}]*$/.test(value)
  ) {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * The file an operator saved, with each `user:<redacted>` entry given back the
 * secret the file on disk holds for that user in that middleware.
 *
 * An entry is matched by where it sits and whose it is, never by position: a
 * user moved to another middleware, renamed, or added with `<redacted>` typed
 * in has no stored secret to keep, and is refused with its name rather than
 * written as a literal Traefik would reject — or accept as the password.

 * The text is spliced rather than re-serialised ({@link rewriteEntries}).
 */
export function restoreRedactedUsers(
  incoming: string,
  current: string | null,
  filePath: string,
): string {
  if (!incoming.includes(REDACTED_SECRET)) return incoming;
  const name = path.basename(filePath);
  if (!isYamlFile(filePath)) {
    throw new BadRequestException(
      `${name} carries a redacted password; write each entry in full to save it here`,
    );
  }

  const doc = parseDocument(incoming);
  const redacted = htpasswdEntries(doc).filter(
    (entry) => entry.secret === REDACTED_SECRET,
  );
  if (redacted.length === 0) return incoming;

  const stored = new Map<string, string>();
  const currentDoc = current === null ? null : parseDocument(current);
  if (currentDoc && currentDoc.errors.length === 0) {
    for (const entry of htpasswdEntries(currentDoc)) {
      stored.set(`${entry.location}\0${entry.user}`, entry.secret);
    }
  }

  const restored: { entry: HtpasswdEntry; value: string }[] = [];
  for (const entry of redacted) {
    const secret = stored.get(`${entry.location}\0${entry.user}`);
    if (secret === undefined || secret === REDACTED_SECRET) {
      throw new BadRequestException(
        `Basic-auth user ${entry.user || '(unnamed)'} in ${name} has no stored password to keep; write its htpasswd entry in full`,
      );
    }
    restored.push({ entry, value: `${entry.user}:${secret}` });
  }

  return rewriteEntries(incoming, doc, restored);
}
