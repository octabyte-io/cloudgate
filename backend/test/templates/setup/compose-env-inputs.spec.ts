import { composeEnvInputs } from '../../../src/templates/setup/compose-env-inputs';

const INPUTS = {
  DB_PASSWORD: { generate: 'password' },
  TZ: { ask: { label: 'Time zone' } },
  OPTIONAL: { ask: { label: 'Optional', required: false } },
  UNREAD: { generate: 'hex' },
};

describe('composeEnvInputs', () => {
  it('names every input the compose file reads, in the order it first reads them', () => {
    expect(
      composeEnvInputs(
        'services:\n  app:\n    environment:\n      tz: ${TZ}\n      pw: ${DB_PASSWORD}\n      again: ${TZ}\n',
        INPUTS,
        { DB_PASSWORD: 'p', TZ: 'Etc/UTC', UNREAD: 'ab' },
      ),
    ).toEqual(['TZ', 'DB_PASSWORD']);
  });

  it('names an input read with a default when it has a value, so the value wins over the default', () => {
    expect(
      composeEnvInputs(
        'services:\n  app:\n    environment:\n      tz: ${TZ:-Etc/UTC}\n',
        INPUTS,
        { TZ: 'Europe/Paris' },
      ),
    ).toEqual(['TZ']);
  });

  it.each(['${OPTIONAL:-fallback}', '${OPTIONAL-fallback}'])(
    'leaves out an input read only as %s and made blank, so the compose default applies',
    (read) => {
      expect(
        composeEnvInputs(
          `services:\n  app:\n    environment:\n      opt: ${read}\n`,
          INPUTS,
          { OPTIONAL: '' },
        ),
      ).toEqual([]);
    },
  );

  it('keeps a blank input the compose file reads with no default', () => {
    expect(
      composeEnvInputs(
        'services:\n  app:\n    environment:\n      opt: ${OPTIONAL}\n',
        INPUTS,
        { OPTIONAL: '' },
      ),
    ).toEqual(['OPTIONAL']);
  });

  it('names nothing for a variable no input has, or a Template with no compose part', () => {
    expect(
      composeEnvInputs(
        'services:\n  app:\n    environment:\n      home: ${HOME}\n',
        INPUTS,
        {},
      ),
    ).toEqual([]);
    expect(composeEnvInputs(null, INPUTS, {})).toEqual([]);
  });
});
