import { describe, expect, it } from 'vitest';

import { credentialFor } from '../src/credentials.js';
import { CliError } from '../src/errors.js';
import { noLoginStore } from '../src/logins.js';
import type { LoginStore } from '../src/logins.js';

async function refusalOf(choose: () => Promise<unknown>): Promise<CliError> {
  try {
    await choose();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }
  throw new Error('expected a refusal');
}

/** A store holding one saved login's key. */
function holding(instance: string, key: string): LoginStore {
  return {
    ...noLoginStore(),
    keyFor: (asked) => Promise.resolve(asked === instance ? key : undefined),
  };
}

describe('credentialFor', () => {
  it('takes CLOUDGATE_KEY for whichever Instance was chosen', async () => {
    expect(
      await credentialFor(
        { url: 'https://cloud.acme.dev', from: 'link' },
        { CLOUDGATE_KEY: ' cg_secret ' },
        noLoginStore(),
      ),
    ).toEqual({ key: 'cg_secret', from: 'env' });
  });

  it('takes the saved login for the chosen Instance', async () => {
    expect(
      await credentialFor(
        { url: 'https://cloud.acme.dev', from: 'current' },
        {},
        holding('https://cloud.acme.dev', 'cg_saved'),
      ),
    ).toEqual({ key: 'cg_saved', from: 'login' });
  });

  it('takes CLOUDGATE_KEY over a saved login', async () => {
    expect(
      await credentialFor(
        { url: 'https://cloud.acme.dev', from: 'flag' },
        { CLOUDGATE_KEY: 'cg_env' },
        holding('https://cloud.acme.dev', 'cg_saved'),
      ),
    ).toEqual({ key: 'cg_env', from: 'env' });
  });

  it("refuses with exit 3, naming the login to run, when there is no login for the link's Instance", async () => {
    const refused = await refusalOf(() =>
      credentialFor(
        { url: 'https://cloud.acme.dev', from: 'link' },
        {},
        holding('https://cloud.other.io', 'cg_saved'),
      ),
    );
    expect(refused.exitCode).toBe(3);
    expect(refused.message).toContain('https://cloud.acme.dev');
    expect(refused.hint).toBe(
      'Run: cloudgate login --instance https://cloud.acme.dev',
    );
  });

  it('refuses with exit 3 when there is no key for an Instance named otherwise', async () => {
    const refused = await refusalOf(() =>
      credentialFor(
        { url: 'https://cloud.acme.dev', from: 'flag' },
        {},
        noLoginStore(),
      ),
    );
    expect(refused.exitCode).toBe(3);
    expect(refused.message).toBe('not logged in to https://cloud.acme.dev');
    expect(refused.hint).toContain(
      'Run: cloudgate login --instance https://cloud.acme.dev',
    );
  });
});
