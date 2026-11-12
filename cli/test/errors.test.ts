import { describe, expect, it } from 'vitest';

import { refusalFromResponse, reportError } from '../src/errors.js';
import { CliError } from '../src/errors.js';

/** Collects what one command run printed, stream by stream. */
function capture() {
  const out = { stdout: '', stderr: '' };
  return {
    out,
    io: {
      stdout: (text: string) => (out.stdout += text),
      stderr: (text: string) => (out.stderr += text),
    },
  };
}

describe('refusalFromResponse', () => {
  it('maps a 401 to exit 3 and prints the server message', () => {
    const refusal = refusalFromResponse(401, {
      statusCode: 401,
      message: 'Unauthorized',
    });
    expect(refusal).toMatchObject({ exitCode: 3, message: 'Unauthorized' });
  });

  it('says CLOUDGATE_KEY was refused when the key came from it', () => {
    const refusal = refusalFromResponse(
      401,
      { message: 'Unauthorized' },
      { keyFrom: 'env' },
    );
    expect(refusal.hint).toBe(
      'The Instance does not accept the key in CLOUDGATE_KEY; it may have ended or been deleted.',
    );
  });

  it('maps an unnamed 403 to exit 1 with the hint to ask an owner of the Organization', () => {
    const refusal = refusalFromResponse(
      403,
      { message: 'Permission denied' },
      { organizationName: 'Shop Inc' },
    );
    expect(refusal).toMatchObject({
      exitCode: 1,
      message: 'Permission denied',
      hint: 'Ask an owner of Shop Inc for access.',
    });
  });

  it('gives a row-level access refusal the same hint', () => {
    expect(
      refusalFromResponse(403, {
        message: 'You do not have access to this Service',
        code: 'SERVICE_ACCESS_NOT_GRANTED',
      }).hint,
    ).toBe('Ask an owner of the Organization for access.');
  });

  it('gives no access hint to a 403 the server named otherwise, such as a ban', () => {
    const refusal = refusalFromResponse(403, {
      message: 'The account this API key belongs to is banned',
      code: 'BANNED_USER',
    });
    expect(refusal).toMatchObject({ exitCode: 1 });
    expect(refusal.hint).toBeUndefined();
  });

  it('decides on the code and never on the English message', () => {
    // The same words a role refusal carries, under a name that is not one.
    expect(
      refusalFromResponse(403, {
        message: 'Permission denied',
        code: 'YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION',
      }).hint,
    ).toBeUndefined();
  });

  it('says how to name another Organization when the key owner is not a member of the one named', () => {
    const refusal = refusalFromResponse(403, {
      statusCode: 403,
      message: "The API key's owner is not a member of Organization org_9",
      code: 'NOT_ORGANIZATION_MEMBER',
    });
    expect(refusal.exitCode).toBe(1);
    expect(refusal.message).toBe(
      "The API key's owner is not a member of Organization org_9",
    );
    expect(refusal.hint).toBe(
      "Check --org, CLOUDGATE_ORG or this folder's link (cloudgate link to change it).",
    );
  });

  it('maps any other refusal to exit 1', () => {
    for (const status of [400, 404, 409, 429, 500, 502]) {
      expect(refusalFromResponse(status, { message: 'No' }).exitCode).toBe(1);
    }
  });

  it('names the status when the body carries no message, as a proxy page would', () => {
    expect(refusalFromResponse(502, '<html>Bad gateway</html>').message).toBe(
      'the Instance answered 502 Bad Gateway',
    );
  });
});

describe('reportError', () => {
  it('prints Error: and the hint on stderr, nothing on stdout, and answers the exit code', () => {
    const { out, io } = capture();
    const code = reportError(
      new CliError(
        'Permission denied',
        1,
        'Ask an owner of Shop Inc for access.',
      ),
      io,
    );
    expect(code).toBe(1);
    expect(out).toEqual({
      stdout: '',
      stderr:
        'Error: Permission denied\nAsk an owner of Shop Inc for access.\n',
    });
  });

  it('reports a failure it did not foresee as exit 1, without a stack', () => {
    const { out, io } = capture();
    expect(reportError(new Error('socket hang up'), io)).toBe(1);
    expect(out).toEqual({ stdout: '', stderr: 'Error: socket hang up\n' });
  });
});
