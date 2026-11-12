import {
  parseGithubPushEvent,
  verifyGithubWebhookSignature,
} from '../../src/git-providers/strategies/github/github-webhook.util';

describe('verifyGithubWebhookSignature', () => {
  // Independently computed:
  //   printf '%s' '{"ref":"refs/heads/main"}' | openssl dgst -sha256 -hmac 'wh-secret' -hex
  const payload = '{"ref":"refs/heads/main"}';
  const signature =
    'sha256=958aa3580d08d37aaa5f8c3780801a7dbc67d6f4b9d4dcf6497c128a0d362dc1';

  it('accepts the signature GitHub sends for the payload and secret', () => {
    expect(verifyGithubWebhookSignature('wh-secret', payload, signature)).toBe(
      true,
    );
  });

  it('rejects a tampered payload', () => {
    expect(
      verifyGithubWebhookSignature(
        'wh-secret',
        '{"ref":"refs/heads/evil"}',
        signature,
      ),
    ).toBe(false);
  });

  it('rejects the wrong secret', () => {
    expect(verifyGithubWebhookSignature('other', payload, signature)).toBe(
      false,
    );
  });

  it('rejects a missing or malformed signature header', () => {
    expect(verifyGithubWebhookSignature('wh-secret', payload, undefined)).toBe(
      false,
    );
    expect(
      verifyGithubWebhookSignature('wh-secret', payload, 'not-a-signature'),
    ).toBe(false);
  });
});

describe('parseGithubPushEvent', () => {
  it('extracts branch, repository coordinates and head commit from a push payload', () => {
    // Trimmed shape of GitHub's real push webhook payload.
    const parsed = parseGithubPushEvent({
      ref: 'refs/heads/main',
      installation: { id: 99887766 },
      repository: {
        name: 'cloudgate',
        owner: { name: 'octabyte-io', login: 'octabyte-io' },
      },
      pusher: { name: 'grace' },
      head_commit: {
        id: '5a4e1c2d',
        message: 'feat: phase 16',
      },
    });

    expect(parsed).toEqual({
      branch: 'main',
      repository: 'cloudgate',
      owner: 'octabyte-io',
      commitHash: '5a4e1c2d',
      commitMessage: 'feat: phase 16',
      deleted: false,
      pusher: 'grace',
      changedFiles: null,
    });
  });

  it('falls back to the owner login and placeholder commit info when fields are absent', () => {
    const parsed = parseGithubPushEvent({
      ref: 'refs/heads/develop',
      repository: { name: 'cloudgate', owner: { login: 'octabyte-io' } },
    });

    expect(parsed).toEqual({
      branch: 'develop',
      repository: 'cloudgate',
      owner: 'octabyte-io',
      commitHash: '',
      commitMessage: 'NEW COMMIT',
      deleted: false,
      pusher: '',
      changedFiles: null,
    });
  });

  it('reads a tag push as naming no branch', () => {
    const parsed = parseGithubPushEvent({
      ref: 'refs/tags/v1.1.0',
      repository: { name: 'cloudgate', owner: { login: 'octabyte-io' } },
      head_commit: { id: '5a4e1c2d', message: 'release' },
    });

    expect(parsed.branch).toBe('');
  });

  it('reads a branch deletion as deleted, with no head commit', () => {
    const parsed = parseGithubPushEvent({
      ref: 'refs/heads/main',
      deleted: true,
      repository: { name: 'cloudgate', owner: { login: 'octabyte-io' } },
      head_commit: null,
    });

    expect(parsed).toMatchObject({
      branch: 'main',
      deleted: true,
      commitHash: '',
    });
  });

  it('lists every path the pushed commits added, modified or removed, once', () => {
    const parsed = parseGithubPushEvent({
      ref: 'refs/heads/main',
      repository: { name: 'shop', owner: { login: 'acme' } },
      commits: [
        { added: ['src/new.ts'], modified: ['cloudgate.yaml'], removed: [] },
        { added: [], modified: ['cloudgate.yaml'], removed: ['old.ts'] },
      ],
    });

    expect(parsed.changedFiles).toEqual([
      'src/new.ts',
      'cloudgate.yaml',
      'old.ts',
    ]);
  });

  it('reads a commit list GitHub may have cut short as not knowing the paths', () => {
    const parsed = parseGithubPushEvent({
      ref: 'refs/heads/main',
      repository: { name: 'shop', owner: { login: 'acme' } },
      commits: Array.from({ length: 2048 }, () => ({ modified: ['a.ts'] })),
    });

    expect(parsed.changedFiles).toBeNull();
  });
});
