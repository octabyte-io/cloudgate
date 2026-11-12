import { parseTraefikRouterErrors } from '../../src/traefik/traefik-log';

/**
 * Every line in this file was copied out of `docker logs --timestamps` against
 * the pinned `traefik:v3.6.7`, ANSI escapes and all, after feeding it the two
 * configs the finding is about — a `redirectRegex` whose regex `regexp.Compile`
 * refuses (H-24's residual) and a `basicAuth` entry with a `:` in the username
 * (H-22). They are not hand-written approximations of Traefik's format: the
 * point of the parser is that it survives what Traefik actually emits, and a
 * fixture invented from the docs would prove the parser matches the docs.
 *
 * `\x1b` is spelled out rather than pasted raw so the file stays greppable.
 */
const E = '\u001b';

const CONSOLE_BAD_REGEX =
  `2026-08-28T17:33:38.162947548Z ${E}[90m2026-08-28T17:33:38Z${E}[0m ${E}[31mERR${E}[0m ` +
  `${E}[36merror=${E}[0m${E}[31m${E}[1m"error parsing regexp: invalid or unsupported Perl syntax: \`(?=\`"${E}[0m${E}[0m ` +
  `${E}[36mentryPointName=${E}[0mweb ${E}[36mrouterName=${E}[0mbadapp-router-1@file`;

const CONSOLE_BAD_BASIC_AUTH =
  `2026-08-28T17:31:19.067484886Z ${E}[90m2026-08-28T17:31:19Z${E}[0m ${E}[31mERR${E}[0m ` +
  `${E}[36merror=${E}[0m${E}[31m${E}[1m"error parsing BasicUser: us:er:$2y$10$abcdefghijklmnopqrstuv"${E}[0m${E}[0m ` +
  `${E}[36mentryPointName=${E}[0mweb ${E}[36mrouterName=${E}[0mauthapp-router-2@file`;

const CONSOLE_STARTUP = `2026-08-28T17:30:38.100000000Z ${E}[90m2026-08-28T17:30:38Z${E}[0m ${E}[32mINF${E}[0m ${E}[1mStarting provider *file.Provider${E}[0m`;

/**
 * The other shape Traefik uses for a router-level ERR (U-68): the
 * sentence is the line's own message, in the bold slot the startup lines use,
 * and there is no `error=` field at all. Copied out of `docker logs
 * --timestamps` after adding a domain whose certificate resolver
 * `traefik.yml` does not define.
 */
const CONSOLE_MISSING_RESOLVER =
  `2026-09-12T20:36:45.512348711Z ${E}[90m2026-09-12T20:36:45Z${E}[0m ${E}[31mERR${E}[0m ` +
  `${E}[1mRouter uses a nonexistent certificate resolver${E}[0m ` +
  `${E}[36mcertificateResolver=${E}[0mu05-nonexistent ` +
  `${E}[36mrouterName=${E}[0mapp-nk3zbo-router-websecure-5@file`;

const JSON_BAD_BASIC_AUTH =
  '2026-08-28T17:31:19.067484886Z {"level":"error","entryPointName":"web",' +
  '"routerName":"authapp-router-2@file",' +
  '"error":"error parsing BasicUser: us:er:$2y$10$abcdefghijklmnopqrstuv",' +
  '"time":"2026-08-28T17:31:19Z"}';

const JSON_INFO =
  '2026-08-28T17:30:38.100000000Z {"level":"info","message":"Starting provider *file.Provider","time":"2026-08-28T17:30:38Z"}';

/** The same rejection as `CONSOLE_MISSING_RESOLVER` on a host set to json. */
const JSON_MISSING_RESOLVER =
  '2026-09-12T20:36:45.512348711Z {"level":"error","certificateResolver":"u05-nonexistent",' +
  '"routerName":"app-nk3zbo-router-websecure-5@file",' +
  '"message":"Router uses a nonexistent certificate resolver",' +
  '"time":"2026-09-12T20:36:45Z"}';

describe('parseTraefikRouterErrors', () => {
  describe("Traefik's console format, which is what this repo's traefik.yml produces", () => {
    it('reads the router name and the error out of an ANSI-wrapped line', () => {
      expect(parseTraefikRouterErrors(CONSOLE_BAD_REGEX)).toEqual([
        {
          at: '2026-08-28T17:33:38.162947548Z',
          routerName: 'badapp-router-1',
          message:
            'error parsing regexp: invalid or unsupported Perl syntax: `(?=`',
        },
      ]);
    });

    it('keeps a message containing the separators that broke the entry', () => {
      const [error] = parseTraefikRouterErrors(CONSOLE_BAD_BASIC_AUTH);

      // The `:` inside the message is the very character that failed
      // `basicUserParser`; a parser that split fields on it would lose it.
      expect(error.message).toBe(
        'error parsing BasicUser: us:er:$2y$10$abcdefghijklmnopqrstuv',
      );
      expect(error.routerName).toBe('authapp-router-2');
    });

    it('reads a rejection whose sentence is the message, with no error= field', () => {
      // The resolver a domain named does not exist, and Traefik says so
      // in the message slot. Keeping only lines with an `error=` field made the
      // Domains notice report silence over this one.
      const [error] = parseTraefikRouterErrors(CONSOLE_MISSING_RESOLVER);

      expect(error).toEqual({
        at: '2026-09-12T20:36:45.512348711Z',
        routerName: 'app-nk3zbo-router-websecure-5',
        message: 'Router uses a nonexistent certificate resolver',
      });
      expect(error.message).toMatch(/nonexistent certificate resolver/);
    });

    it('returns nothing for the startup lines a healthy Traefik writes', () => {
      expect(parseTraefikRouterErrors(CONSOLE_STARTUP)).toEqual([]);
    });

    it('reads every rejection in one reload burst', () => {
      const errors = parseTraefikRouterErrors(
        [CONSOLE_STARTUP, CONSOLE_BAD_REGEX, CONSOLE_BAD_BASIC_AUTH].join('\n'),
      );

      expect(errors.map((error) => error.routerName)).toEqual([
        'badapp-router-1',
        'authapp-router-2',
      ]);
    });
  });

  describe("Traefik's json format, which an operator can set through /settings/traefik/config", () => {
    it('reads the same fact out of the json line', () => {
      expect(parseTraefikRouterErrors(JSON_BAD_BASIC_AUTH)).toEqual([
        {
          at: '2026-08-28T17:31:19.067484886Z',
          routerName: 'authapp-router-2',
          message:
            'error parsing BasicUser: us:er:$2y$10$abcdefghijklmnopqrstuv',
        },
      ]);
    });

    it("falls back to the json line's message when it carries no error key", () => {
      expect(parseTraefikRouterErrors(JSON_MISSING_RESOLVER)).toEqual([
        {
          at: '2026-09-12T20:36:45.512348711Z',
          routerName: 'app-nk3zbo-router-websecure-5',
          message: 'Router uses a nonexistent certificate resolver',
        },
      ]);
    });

    it('returns nothing for a json line that is not an error', () => {
      expect(parseTraefikRouterErrors(JSON_INFO)).toEqual([]);
    });
  });

  it('returns nothing for output with no docker timestamp on it', () => {
    // Nothing was dated, so nothing can be placed after the write — and an
    // undatable line is exactly the kind that must not become a report.
    expect(
      parseTraefikRouterErrors('ERR error="boom" routerName=x-router-1@file'),
    ).toEqual([]);
  });

  it('returns nothing for empty output', () => {
    expect(parseTraefikRouterErrors('')).toEqual([]);
  });
});
