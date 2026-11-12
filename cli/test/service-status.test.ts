import { describe, expect, it } from 'vitest';

import { CliError } from '../src/errors.js';
import { kindRefusal } from '../src/service-status.js';

/**
 * The one "Applications only" refusal `deploy`, `vars` and
 * `logs` share: the Service named by its kind, in the same words.
 */

const service = (kind: string) => ({ configName: 'api', kind });

describe('kindRefusal', () => {
  it('lets an Application through', () => {
    expect(kindRefusal(service('application'), 'deploy')).toBeUndefined();
  });

  it.each([
    ['compose', 'a Compose stack'],
    ['postgres', 'a Postgres database'],
    ['mysql', 'a MySQL database'],
    ['redis', 'a Redis database'],
    ['mongo', 'a MongoDB database'],
    ['bucket', 'a Bucket'],
  ])('refuses %s with exit 1, naming its kind', (kind, words) => {
    const refusal = kindRefusal(service(kind), 'deploy');
    expect(refusal).toBeInstanceOf(CliError);
    expect(refusal?.exitCode).toBe(1);
    expect(refusal?.message).toBe(
      `api is ${words}; cloudgate deploy uploads to Applications only`,
    );
  });

  it.each([
    [
      'vars',
      'api is a Postgres database; cloudgate vars reaches the variables of Applications only',
      'Change its variables in the console.',
    ],
    [
      'logs',
      'api is a Postgres database; cloudgate logs reads the Runtime log of Applications only',
      'Its logs are in the console.',
    ],
  ] as const)(
    'words cloudgate %s the same way, with where to go instead',
    (command, message, hint) => {
      const refusal = kindRefusal(service('postgres'), command);
      expect(refusal?.message).toBe(message);
      expect(refusal?.hint).toBe(hint);
    },
  );
});
