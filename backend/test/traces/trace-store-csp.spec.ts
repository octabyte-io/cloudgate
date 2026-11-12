import {
  inlineScriptHashes,
  traceStoreContentSecurityPolicy,
} from '../../src/traces/trace-store-csp';

/**
 * The policy the proxied Trace store UI is served under, and the
 * hashes that let the store's own inline scripts run under it.
 *
 * The hashes are spelled out, computed with
 * `printf '%s' '<script text>' | openssl dgst -sha256 -binary | base64`
 * rather than with the module's own hashing (§1.7).
 */

describe('inlineScriptHashes', () => {
  it('hashes each inline script in the head, byte for byte, and no script that has a src', () => {
    const html = [
      '<!doctype html><html><HEAD>',
      '<script>window.config = 1;</script>',
      '<script type="module" crossorigin src="./static/index.js"></script>',
      '<script data-x="1">\n      var a = "é";\n    </SCRIPT >',
      '</head><body><div id="root"></div></body></html>',
    ].join('');

    expect(inlineScriptHashes(html)).toEqual([
      "'sha256-b7GhnDeSTKp2mWfbBifSDQAP29vql3MfdbjKoYzEk3U='",
      "'sha256-XMN+l9/GoTSFlWLyAi1vZkbe5bBoNThblLQd8rZx2fQ='",
    ]);
  });

  it('hashes no script in the body, so one injected there does not run', () => {
    const html =
      '<html><head><script>window.config = 1;</script></head>' +
      '<body><script>alert(1)</script><img src=x onerror="alert(1)"></body></html>';

    expect(inlineScriptHashes(html)).toEqual([
      "'sha256-b7GhnDeSTKp2mWfbBifSDQAP29vql3MfdbjKoYzEk3U='",
    ]);
    // alert(1)'s own hash.
    expect(inlineScriptHashes(html)).not.toContain(
      "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='",
    );
  });

  it('hashes nothing in a page without a head end', () => {
    expect(inlineScriptHashes('<script>alert(1)</script>')).toEqual([]);
  });
});

describe('traceStoreContentSecurityPolicy', () => {
  it('lets the given hashes and same-origin scripts run and nothing inline or evaluated', () => {
    expect(
      traceStoreContentSecurityPolicy([
        "'sha256-b7GhnDeSTKp2mWfbBifSDQAP29vql3MfdbjKoYzEk3U='",
      ]),
    ).toBe(
      "default-src 'none'; " +
        "script-src 'self' 'sha256-b7GhnDeSTKp2mWfbBifSDQAP29vql3MfdbjKoYzEk3U='; " +
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
        "font-src 'self' data:; connect-src 'self'; " +
        "frame-ancestors 'self'; base-uri 'self'; form-action 'none'; " +
        "object-src 'none'; sandbox allow-scripts allow-forms allow-popups",
    );
  });

  it('sandboxes every answer into an opaque origin, the boundary the hashes are not (ADR-0075)', () => {
    for (const policy of [
      traceStoreContentSecurityPolicy([]),
      traceStoreContentSecurityPolicy(["'sha256-abc='"]),
    ]) {
      expect(policy.split('; ')).toContain(
        'sandbox allow-scripts allow-forms allow-popups',
      );
      expect(policy).not.toContain('allow-same-origin');
      expect(policy).not.toContain('allow-top-navigation');
    }
  });

  it('is only same-origin scripts for a response with no inline script', () => {
    expect(traceStoreContentSecurityPolicy([])).toContain("script-src 'self';");
  });
});
