import * as fs from 'node:fs';
import { parse } from 'yaml';
import {
  cloudgateDirectoryOn,
  REMOTE_CLOUDGATE_DIRECTORY,
} from '../../src/common/config/cloudgate-directory';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import {
  mainTraefikDirectory,
  TraefikFilesService,
} from '../../src/settings/traefik-files.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';

/**
 * The four `yaml.parse` calls that read Traefik configuration
 * off a disk, and what the library prints while they do it. An earlier fix closed the
 * same library default at `parseComposeFile` and did not reach these.
 *
 * **Two units in one file, deliberately.** The property is one library default
 * at four call sites in two modules, the seam that observes it is one, and the
 * only question a reader brings here is *"is the echo closed"* — which they
 * should be able to answer from one file rather than two that would each carry
 * their own copy of the capture (§1.4).
 *
 * **The mechanism, re-measured on the installed yaml 2.9.0 rather than read off
 * the earlier fix.** `parse` ends with `doc.warnings.forEach(w =>
 * log.warn(doc.options.logLevel, w))`, the default `logLevel` is `'warn'`,
 * `log.warn` is `process.emitWarning`, and with no application `warning` listener
 * anywhere in the tree Node's own default handler formats it onto process
 * **stderr**. The warning is prettified — the same `prettifyError(source,
 * lineCounter)` an *error* gets — so it carries the offending source line plus a
 * caret. The document still parses, so no exception exists at any point and every
 * guard the tree has (`AllExceptionsFilter`, `capMessage`,
 * `elideEncodedPayloads`) is downstream of a path that never reaches it.
 *
 * **`parseDocument` is not that echo, and that is what bounds the sweep.** It
 * prettifies `doc.warnings` and hands them back on the document; only `parse`
 * iterates them into `log.warn`, and neither does `parseAllDocuments`. So
 * `TraefikFilesService.toggleRequests` is silent by construction — its case
 * below was green before the fix and is kept as the thing that would notice if
 * the library ever moved the logging up.
 *
 * **Why the seam is `process.emitWarning` and not `process.stderr.write`.** The
 * property is what reaches stderr, and one layer further out would be the truer
 * assertion — but it is unavailable here, measured rather than assumed: under
 * `jest-environment-node` a test's `Error` is not the realm `Error` Node's own
 * `emitWarning` validates against, so it rejects **any** Error instance with
 * `ERR_INVALID_ARG_TYPE` (*"Received an instance of Error"* for a plain
 * `new Error()`) instead of emitting it. Nothing ever reaches the default
 * handler in-harness, and with the unfixed code the parse throws that
 * `TypeError` rather than printing. The stderr write itself was confirmed
 * outside jest, with a bare `node` process on this fixture's dynamic-config
 * shape. So this file asserts on the channel Node's default handler is the only
 * consumer of, which is also the seam the earlier fix established, and
 * *the parser hands a Traefik file's own bytes to a diagnostic channel* below
 * is what keeps that channel's contents load-bearing rather than a formality.
 *
 * The fixtures put the warning's own position on a line carrying a credential
 * out of Traefik's own vocabulary rather than one invented for a test: an ACME
 * External Account Binding HMAC key in the static config, and a
 * `basicAuth.users` htpasswd entry in the dynamic one — the second being a
 * value **Cloudgate itself writes** into that file (`createBasicAuthMiddleware`,
 * fed by `AppConfigService`'s bcrypt of the stored password), and one
 * `TraefikVerifyInput.secrets` already says must not leave the server.
 */

// The filesystem is a system boundary and both services reach it directly;
// `TraefikWriterService`'s dynamic directory is not injectable, so the mock is
// what lets one file drive both units off the same fixtures.
jest.mock('node:fs');

const mockedFs = jest.mocked(fs);

/**
 * Where each read lands, per machine. A Server's Traefik tree is the one
 * `serverSetupCommand` created there, whatever this instance's root is. The
 * platform host's is under this process's own root, so it is taken from the
 * machine rather than spelled — with `CLOUDGATE_DIRECTORY` unset both roots
 * are `/etc/cloudgate`, and a spelled literal passed only for as long as the
 * lane left it unset.
 */
const REMOTE_TRAEFIK_DIR = `${REMOTE_CLOUDGATE_DIRECTORY}/traefik`;
const REMOTE_DYNAMIC_DIR = `${REMOTE_TRAEFIK_DIR}/dynamic`;
const LOCAL_DYNAMIC_DIR = `${cloudgateDirectoryOn(null)}/traefik/dynamic`;

/** Each credential is one token, so an assertion cannot half-match it. */
const EAB_HMAC = 'zXy9EABHMACKEYabcdef123456';
const HTPASSWD_HASH = '$2b$10$vI8aWBnW3fID.ZQ4-BvvzE-KVCLQ0lo';

/**
 * `!!secretish` is an unresolved tag — `TAG_RESOLVE_FAILED`, the cheapest of
 * the six warning classes an operator-authored document can raise and the one
 * the earlier fix measured. It sits on the credential's own line, which is what puts the
 * warning's position there.
 */
const WARNING_BEARING_MAIN_CONFIG = `entryPoints:
  web:
    address: ":80"
certificatesResolvers:
  letsencrypt:
    acme:
      email: ops@example.com
      eab:
        kid: kid-1
        hmacEncoded: !!secretish ${EAB_HMAC}
`;

const WARNING_BEARING_DYNAMIC_CONFIG = `http:
  routers:
    api-router-1:
      rule: Host(\`api.example.com\`)
      service: api-service-1
  middlewares:
    auth-api:
      basicAuth:
        removeHeader: true
        users:
          - !!secretish admin:${HTPASSWD_HASH}
`;

let execAsyncRemote: jest.Mock;
const emitted: string[] = [];

function filesService(): TraefikFilesService {
  return new TraefikFilesService(
    withArgvExec({
      execAsync: jest.fn(() => Promise.resolve({ stdout: '', stderr: '' })),
      execAsyncRemote,
    }) as unknown as RemoteExecService,
    // A function of the machine, and the provider's own default
    // rather than a double: `fs` is mocked, so the platform host's root it
    // names is never touched, and the Server read below is then asserted
    // against the tree that Server has rather than against a stub's one answer
    // for both machines. Which of the two roots a path belongs to is
    // `traefik-files-roots`'.
    mainTraefikDirectory,
  );
}

function writerService(): TraefikWriterService {
  return new TraefikWriterService(
    withArgvExec({ execAsyncRemote }) as unknown as RemoteExecService,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  execAsyncRemote = jest.fn();
  mockedFs.existsSync.mockReturnValue(true);
  emitted.length = 0;
  // Replaced rather than observed, for the earlier fix's reason: a spy that called through
  // would let Node's default handler print the config to the real stderr while
  // the assertion passed. `jest.spyOn` restores it, so the original does not
  // have to be held by hand — which would need a `this: void` annotation on a
  // bound builtin to satisfy `unbound-method`.
  jest
    .spyOn(process, 'emitWarning')
    .mockImplementation((warning: string | Error) => {
      emitted.push(typeof warning === 'string' ? warning : warning.message);
    });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('TraefikFilesService, on what the yaml parser prints while it reads traefik.yml', () => {
  beforeEach(() => {
    mockedFs.readFileSync.mockReturnValue(WARNING_BEARING_MAIN_CONFIG);
  });

  describe('the parser hands a Traefik file’s own bytes to a diagnostic channel', () => {
    it('emits the credential’s own line for a document that parses', () => {
      // The falsification of every negative assertion below, and the reason
      // they are not vacuous: a fixture that stopped raising a warning would
      // satisfy all of them silently. This is the library default, called
      // directly, on the same bytes.
      expect(parse(WARNING_BEARING_MAIN_CONFIG)).toMatchObject({
        certificatesResolvers: {
          letsencrypt: { acme: { eab: { hmacEncoded: EAB_HMAC } } },
        },
      });

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toContain(EAB_HMAC);
      expect(emitted[0]).toContain('hmacEncoded');
    });

    it('reaches no guard on the way, because nothing throws', async () => {
      // The negative claim the rest of this file rests on. Both reads answer
      // normally, with the credential intact, so there is no exception for
      // `AllExceptionsFilter`, `capMessage` or `elideEncodedPayloads` to see.
      await expect(filesService().haveActivateRequests()).resolves.toEqual({
        present: true,
        enabled: false,
      });
      expect(filesService().readMainConfig()).toContain(EAB_HMAC);
    });
  });

  describe('haveActivateRequests', () => {
    it('emits no line of the config it read', async () => {
      // The widest-open of the four sites: `GET /settings/traefik/requests` is
      // ADR-0013's documented any-authenticated-user carve-out, so any signed-in
      // member of any organization can ask for this read as often as they like.
      await filesService().haveActivateRequests();

      expect(emitted).toEqual([]);
    });

    it('emits no line of a config it read off a Server', async () => {
      // The same read against a `serverId`, where the bytes come off another
      // machine and the stderr they would reach is this one's.
      execAsyncRemote.mockResolvedValue({
        stdout: WARNING_BEARING_MAIN_CONFIG,
        stderr: '',
        exitCode: 0,
      });

      await filesService().haveActivateRequests('server-1');

      expect(execAsyncRemote).toHaveBeenCalledWith(
        'server-1',
        `cat ${REMOTE_TRAEFIK_DIR}/traefik.yml`,
      );
      expect(emitted).toEqual([]);
    });
  });

  describe('updateLetsEncryptEmail', () => {
    it('emits no line of the config it read', () => {
      filesService().updateLetsEncryptEmail('new@example.com');

      expect(emitted).toEqual([]);
    });

    it('still rewrites the email it was called for', () => {
      filesService().updateLetsEncryptEmail('new@example.com');

      // Silence may not be bought by making the parse answer differently. The
      // patch still lands and the value the warning was about survives the
      // parse/stringify round trip — which is also the half `'silent'` would
      // have taken, since it makes `parse` return a half-read document instead
      // of throwing (the earlier fix rejected it on that measurement).
      const [, written] = mockedFs.writeFileSync.mock.calls.at(-1) ?? [];
      expect(written).toContain('new@example.com');
      expect(written).toContain(EAB_HMAC);
    });

    it('still refuses a config with no letsencrypt resolver in it', () => {
      mockedFs.readFileSync.mockReturnValue(
        'entryPoints:\n  web:\n    address: ":80"\n',
      );

      expect(() =>
        filesService().updateLetsEncryptEmail('new@example.com'),
      ).toThrow("Invalid Let's Encrypt configuration structure.");
    });
  });

  describe('toggleRequests', () => {
    it('emits no line of the config it read', async () => {
      // Green before the fix and kept for the reason it was green: this method
      // uses `parseDocument`, which prettifies `doc.warnings` onto the document
      // and never logs them. So it passes no `logLevel`, and this case is what
      // would notice if the library moved the logging up.
      await filesService().toggleRequests(true);

      expect(emitted).toEqual([]);
    });
  });
});

describe('TraefikWriterService, on what the yaml parser prints while it reads a dynamic config', () => {
  describe('the parser hands a Traefik file’s own bytes to a diagnostic channel', () => {
    it('emits the htpasswd entry’s own line for a document that parses', () => {
      expect(parse(WARNING_BEARING_DYNAMIC_CONFIG)).toMatchObject({
        http: {
          middlewares: {
            'auth-api': { basicAuth: { users: [`admin:${HTPASSWD_HASH}`] } },
          },
        },
      });

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toContain(HTPASSWD_HASH);
    });
  });

  describe('loadOrCreateConfig', () => {
    it('emits no line of the local file it read', async () => {
      mockedFs.readFileSync.mockReturnValue(WARNING_BEARING_DYNAMIC_CONFIG);

      await writerService().loadOrCreateConfig('api');

      expect(mockedFs.readFileSync).toHaveBeenCalledWith(
        `${LOCAL_DYNAMIC_DIR}/api.yml`,
        'utf8',
      );
      expect(emitted).toEqual([]);
    });

    it('emits no line of a file it read off a Server', async () => {
      execAsyncRemote.mockResolvedValue({
        stdout: WARNING_BEARING_DYNAMIC_CONFIG,
        stderr: '',
        exitCode: 0,
      });

      await writerService().loadOrCreateConfig('api', 'server-1');

      expect(execAsyncRemote).toHaveBeenCalledWith(
        'server-1',
        `cat ${REMOTE_DYNAMIC_DIR}/api.yml`,
      );
      expect(emitted).toEqual([]);
    });

    it('still reads back the config it was asked for', async () => {
      mockedFs.readFileSync.mockReturnValue(WARNING_BEARING_DYNAMIC_CONFIG);

      const config = await writerService().loadOrCreateConfig('api');

      // The same guard as `updateLetsEncryptEmail`'s. The middleware the
      // warning sat on is still there, hash and all, so a subsequent
      // `writeConfig` cannot drop the basic-auth gate off an Application's
      // router as a side effect of this option.
      expect(config.http?.middlewares).toEqual({
        'auth-api': {
          basicAuth: { removeHeader: true, users: [`admin:${HTPASSWD_HASH}`] },
        },
      });
    });
  });
});
