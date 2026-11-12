import { configKindAfter } from '../../src/applications/config-kind';

describe('configKindAfter', () => {
  it('moves a web to static, and a static back to web, with the build type', () => {
    expect(configKindAfter('web', 'static')).toEqual({ configKind: 'static' });
    expect(configKindAfter('static', 'nixpacks')).toEqual({
      configKind: 'web',
    });
  });

  it('writes nothing when the build type keeps the kind, or is not edited', () => {
    expect(configKindAfter('web', 'dockerfile')).toEqual({});
    expect(configKindAfter('static', 'static')).toEqual({});
    expect(configKindAfter('web', undefined)).toEqual({});
  });

  it('never moves a kind other than web or static', () => {
    for (const kind of ['worker', 'web-private', 'cron'] as const) {
      expect(configKindAfter(kind, 'static')).toEqual({});
      expect(configKindAfter(kind, 'dockerfile')).toEqual({});
    }
  });
});
