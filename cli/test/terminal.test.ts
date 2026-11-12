import { describe, expect, it } from 'vitest';

import { CliError } from '../src/errors.js';
import { requireInputs, terminalMode } from '../src/terminal.js';

const allTerminals = { stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true };

describe('terminalMode', () => {
  it('colours, spins and asks in a terminal', () => {
    expect(terminalMode({ ...allTerminals, env: {} })).toEqual({
      stdoutColour: true,
      stderrColour: true,
      spinner: true,
      canAsk: true,
    });
  });

  it('gives a piped stdout no colour, no spinner and no question', () => {
    const mode = terminalMode({ ...allTerminals, stdoutIsTTY: false, env: {} });
    expect(mode).toMatchObject({
      stdoutColour: false,
      spinner: false,
      canAsk: false,
    });
  });

  it('asks nothing when stdin is not a terminal', () => {
    expect(
      terminalMode({ ...allTerminals, stdinIsTTY: false, env: {} }).canAsk,
    ).toBe(false);
  });

  it('asks nothing and spins nothing when CI is set, to any value', () => {
    for (const CI of ['true', '1', 'false']) {
      expect(terminalMode({ ...allTerminals, env: { CI } })).toMatchObject({
        canAsk: false,
        spinner: false,
      });
    }
  });

  it('asks nothing with --no-input', () => {
    expect(
      terminalMode({ ...allTerminals, noInput: true, env: {} }).canAsk,
    ).toBe(false);
  });

  it('turns colour off for NO_COLOR and for --no-color, and nothing else', () => {
    const off = { stdoutColour: false, stderrColour: false };
    expect(
      terminalMode({ ...allTerminals, env: { NO_COLOR: '1' } }),
    ).toMatchObject({ ...off, canAsk: true });
    expect(
      terminalMode({ ...allTerminals, noColor: true, env: {} }),
    ).toMatchObject({ ...off, canAsk: true });
  });

  it('keeps colour on when NO_COLOR is set but empty', () => {
    expect(
      terminalMode({ ...allTerminals, env: { NO_COLOR: '' } }).stdoutColour,
    ).toBe(true);
  });
});

describe('requireInputs', () => {
  const service = {
    name: 'Service to deploy to',
    flag: '--service',
    env: 'CLOUDGATE_SERVICE',
  };
  const environment = {
    name: 'Environment',
    flag: '--env',
    env: 'CLOUDGATE_ENV',
  };

  it('passes when every input has a value', () => {
    expect(
      requireInputs(
        [
          { ...environment, value: 'staging' },
          { ...service, value: 'api' },
        ],
        { canAsk: false },
      ),
    ).toEqual([]);
  });

  it('hands back what is missing, in order, when it can ask', () => {
    expect(
      requireInputs([environment, { ...service, value: 'api' }], {
        canAsk: true,
      }),
    ).toEqual([environment]);
  });

  it('refuses with exit 2, naming the first missing flag and its variable, when it cannot ask', () => {
    let refusal: unknown;
    try {
      requireInputs([{ ...environment, value: 'staging' }, service], {
        canAsk: false,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(CliError);
    expect(refusal).toMatchObject({
      exitCode: 2,
      message:
        'no Service to deploy to. Pass --service or set CLOUDGATE_SERVICE.',
    });
  });

  it('names only the earliest of several missing inputs', () => {
    expect(() =>
      requireInputs([environment, service], { canAsk: false }),
    ).toThrow('no Environment. Pass --env or set CLOUDGATE_ENV.');
  });

  it('names the flag alone for an input no variable stands in for', () => {
    expect(() =>
      requireInputs([{ name: 'value for KEY', flag: '--value' }], {
        canAsk: false,
      }),
    ).toThrow('no value for KEY. Pass --value.');
  });
});
