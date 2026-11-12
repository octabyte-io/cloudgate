import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every file under `src` that opens an outbound HTTP or SMTP connection from
 * the platform host, and whether the host it dials can be set by a customer.
 *
 * A security pass found notification channels, uptime Probes and the Gitea and GitLab
 * connections dialling customer-supplied hosts with no address check, so a
 * customer could make the box call `127.0.0.1`, a private range or the cloud
 * metadata address. It was one mistake at a dozen sites, which is why this is
 * a census and not a test per channel: a new file that dials fails here until
 * it says which it is.
 *
 * - **guarded** names the file that applies the address rule to this dial —
 *   `OutboundAddressGuard` at the dial (`fetchFor`, `addressToDial`), or the
 *   AI destination's `assertPublicApiUrl` where the URL enters — and that file
 *   must still reference it.
 * - **exempt** says why no customer can choose the host.
 *
 * Both directions: a listed file that no longer dials fails too, so the table
 * cannot rot into a list of what used to be true.
 *
 * **A shell `git` is a dial too.** A clone or `ls-remote` that runs on the
 * platform host dials the repository's host from that box, and the
 * strategies that write those commands are pure builders that never see
 * where they run. So they have a census of their own, {@link SHELL_CENSUS},
 * over the files whose code writes a `git clone`/`fetch`/`pull`/`ls-remote`
 * or calls `gitCloneLines(`; a guarded one names the file that checks the
 * host before the program runs on the platform host, and must itself pin the
 * dial to the checked address ({@link SHELL_PIN}).
 */

type Verdict =
  | { verdict: 'guarded'; by: string; note?: string }
  | { verdict: 'exempt'; reason: string };

const REGISTRY = 'src/notifications/channels/channel-registry.ts';

const CENSUS: Record<string, Verdict> = {
  // The Gateway dials an AI model's Server over plain HTTP, so it checks the
  // Server's stored address as an SSH connect does and dials what it checked.
  'src/gateway/gateway.service.ts': {
    verdict: 'guarded',
    by: 'src/gateway/gateway.service.ts',
    note: 'ServerAddressGuard.addressToDial at every call',
  },
  'src/traces/trace-store-proxy.ts': {
    verdict: 'exempt',
    reason:
      'dials only the local end of an SSH forward to the Server, whose address ServerAddressGuard checks at connect',
  },
  // Notification channels: the registry hands each strategy a transport
  // already scoped to the channel's Organization.
  [REGISTRY]: { verdict: 'guarded', by: REGISTRY },
  'src/notifications/channels/custom.strategy.ts': {
    verdict: 'guarded',
    by: REGISTRY,
  },
  'src/notifications/channels/discord.strategy.ts': {
    verdict: 'guarded',
    by: REGISTRY,
  },
  'src/notifications/channels/gotify.strategy.ts': {
    verdict: 'guarded',
    by: REGISTRY,
  },
  'src/notifications/channels/lark.strategy.ts': {
    verdict: 'guarded',
    by: REGISTRY,
  },
  'src/notifications/channels/mattermost.strategy.ts': {
    verdict: 'guarded',
    by: REGISTRY,
  },
  'src/notifications/channels/ntfy.strategy.ts': {
    verdict: 'guarded',
    by: REGISTRY,
  },
  'src/notifications/channels/slack.strategy.ts': {
    verdict: 'guarded',
    by: REGISTRY,
  },
  'src/notifications/channels/teams.strategy.ts': {
    verdict: 'guarded',
    by: REGISTRY,
  },
  'src/mail/senders/smtp.ts': {
    verdict: 'guarded',
    by: REGISTRY,
    note: "the email channel's host is checked and pinned before it gets here; MailService's own SMTP is the instance's configuration",
  },
  'src/notifications/channels/telegram.strategy.ts': {
    verdict: 'exempt',
    reason:
      'always api.telegram.org; the bot token is in the path, after the authority',
  },
  'src/notifications/channels/pushover.strategy.ts': {
    verdict: 'exempt',
    reason: 'always api.pushover.net',
  },

  // Uptime checks: the scheduler checks the Domain's host and pins the Probe.
  'src/service-health/http-probe.ts': {
    verdict: 'guarded',
    by: 'src/service-health/probe-scheduler.service.ts',
  },
  'src/service-health/tcp-probe.ts': {
    verdict: 'exempt',
    reason:
      "dials only its Service's own Server address, which the scheduler checks with ServerAddressGuard.addressToDial at every Probe on the Hosted instance (ADR-0053); a Service with no Server — in a Cloud account, or any on the Hosted instance — has no address (tcpPlaceOf in published-ports.ts) and its check is refused and turned off rather than dialled on the platform host",
  },

  // Gitea and GitLab: every call goes through the connection's fetchFor.
  'src/git-providers/strategies/gitea/gitea.service.ts': {
    verdict: 'guarded',
    by: 'src/git-providers/strategies/gitea/gitea.service.ts',
  },
  'src/git-providers/strategies/gitlab/gitlab.service.ts': {
    verdict: 'guarded',
    by: 'src/git-providers/strategies/gitlab/gitlab.service.ts',
  },
  'src/git-providers/oauth-refresh.util.ts': {
    verdict: 'guarded',
    by: 'src/git-providers/git-provider-oauth.service.ts',
    note: 'dials through the transport its caller passes: the Gitea or GitLab fetchFor',
  },
  'src/git-providers/git-provider-oauth.service.ts': {
    verdict: 'guarded',
    by: 'src/git-providers/git-provider-oauth.service.ts',
    note: 'the code exchange goes through fetchFor; its own transport only reaches github.com',
  },
  'src/git-providers/strategies/bitbucket/bitbucket.service.ts': {
    verdict: 'exempt',
    reason: 'always api.bitbucket.org',
  },

  // The surface whose rule the others share.
  'src/ai/ai.service.ts': {
    verdict: 'guarded',
    by: 'src/ai/ai.service.ts',
    note: "assertPublicApiUrl where the apiUrl enters, and OutboundAddressGuard.fetchFor for the provider's Organization at every request: getModels and every provider factory (selectAIProvider's required fetch), redirect hops included",
  },

  // Hosts no customer chooses.
  'src/cloud-accounts/gcp/google-cloud.adapter.ts': {
    verdict: 'exempt',
    reason: "Google's own API hosts",
  },
  'src/bought-servers/hetzner/hetzner-cloud.adapter.ts': {
    verdict: 'exempt',
    reason:
      "always api.hetzner.cloud, the provider of Bought Servers, with the instance's own tokens",
  },
  'src/bought-servers/exchange-rate/ecb-exchange-rate.adapter.ts': {
    verdict: 'exempt',
    reason:
      "always www.ecb.europa.eu, the day's euro reference rate for the Operator page's margins",
  },
  'src/cloud/billing/billing-notifications.service.ts': {
    verdict: 'exempt',
    reason: "an invoice PDF URL Stripe's API returned",
  },
  'src/enterprise/license/license-api.client.ts': {
    verdict: 'exempt',
    reason: 'the license server the instance is configured with',
  },
  'src/settings/updates.service.ts': {
    verdict: 'exempt',
    reason: "Cloudgate's own release feed",
  },
  'src/templates/templates.service.ts': {
    verdict: 'exempt',
    reason:
      'CLOUDGATE_TEMPLATES_URL, the Template catalogue set by whoever runs the instance',
  },
};

const SOURCE_CLONE = 'src/git-providers/source-clone.service.ts';

const SHELL_CENSUS: Record<string, Verdict> = {
  'src/git-providers/git-clone-lines.ts': {
    verdict: 'guarded',
    by: SOURCE_CLONE,
    note: "writes the clone every strategy ends with; the URL's host is checked by the strategy's caller, and the dial pinned here",
  },
  'src/git-providers/strategies/git.strategy.ts': {
    verdict: 'guarded',
    by: SOURCE_CLONE,
    note: "customGitUrl's host, on the platform host; listBranches' ls-remote has no runner in src, and one must check the same way",
  },
  'src/git-providers/strategies/gitea/gitea.strategy.ts': {
    verdict: 'guarded',
    by: SOURCE_CLONE,
    note: "the connection's giteaUrl, as that connection's dial",
  },
  'src/git-providers/strategies/gitlab/gitlab.strategy.ts': {
    verdict: 'guarded',
    by: SOURCE_CLONE,
    note: "the connection's gitlabUrl, as that connection's dial",
  },
  'src/git-providers/strategies/github/github.strategy.ts': {
    verdict: 'exempt',
    reason:
      "always github.com; submodules, which dial .gitmodules' URLs, are refused on the platform host by source-clone.service.ts",
  },
  'src/git-providers/strategies/bitbucket/bitbucket.strategy.ts': {
    verdict: 'exempt',
    reason:
      'always bitbucket.org; submodules are refused on the platform host as for github.com',
  },
};

/** What has a shell `git` dial a remote: the command itself, or the clone lines that write it. */
const SHELL_GIT_DIAL =
  /\bgit (?:-c \S+ )*(?:clone|fetch|pull|ls-remote)\b|\bgitCloneLines\(/;

/**
 * What holding a shell git dial to the checked address looks like in the file
 * that writes it: curl's resolve entry itself, or the checked dial handed on
 * to the clone-line writer. A guard reference alone checked a name git then
 * looked up again, and followed redirects from.
 */
const SHELL_PIN = /\bhttp\.curloptResolve=|\bdial: input\.dial\b/;

/**
 * What opens a connection: a fetch, Node's own clients (called as
 * `http.request(` or imported by name, `import { request as httpRequest }`,
 * which the Gateway's dial hid behind), nodemailer, an injected FETCH_CLIENT.
 */
const DIAL =
  /(^|[^.\w])fetch\(|\bhttps?\.(request|get)\(|\bimport\s*\{[^}]*\b(?:request|get)\b[^}]*\}\s*from\s*'(?:node:)?https?'|\btransport\.request\(|\bnet\.connect\(|\btls\.connect\(|createTransport\(|@Inject\(FETCH_CLIENT\)/;

/** What applying the address rule looks like in the file that does it. */
const GUARD =
  /\bOutboundAddressGuard\b|\.fetchFor\(|\.addressToDial\(|\bassertPublicApiUrl\(/;

const ROOT = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** A file's code without its comment lines, so a docblock naming `fetch(` is not a dial. */
function codeOf(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

function censusOf(census: Record<string, Verdict>, dial: RegExp) {
  const dialling = sourceFiles(join(ROOT, 'src'))
    .map((path) => relative(ROOT, path))
    .filter((path) => dial.test(codeOf(path)))
    .sort();
  return {
    unlisted: dialling.filter((path) => !(path in census)),
    stale: Object.keys(census).filter((path) => !dialling.includes(path)),
    unguarded: Object.entries(census)
      .filter(
        ([, entry]) =>
          entry.verdict === 'guarded' && !GUARD.test(codeOf(entry.by)),
      )
      .map(([path]) => path),
  };
}

describe('OutboundAddressGuard, on which hosts a customer can point the platform host at', () => {
  const { unlisted, stale, unguarded } = censusOf(CENSUS, DIAL);

  it('lists every file that dials, as guarded or exempt', () => {
    expect(unlisted).toEqual([]);
  });

  it('lists no file that no longer dials', () => {
    expect(stale).toEqual([]);
  });

  it('finds the guard in the file each guarded dial names', () => {
    expect(unguarded).toEqual([]);
  });
});

describe('OutboundAddressGuard, on the shell git dials a clone on the platform host makes', () => {
  const { unlisted, stale, unguarded } = censusOf(SHELL_CENSUS, SHELL_GIT_DIAL);

  it('lists every file that writes a git dial, as guarded or exempt', () => {
    expect(unlisted).toEqual([]);
  });

  it('lists no file that no longer writes one', () => {
    expect(stale).toEqual([]);
  });

  it('finds the guard in the file each guarded dial names', () => {
    expect(unguarded).toEqual([]);
  });

  it('pins each guarded git dial to the address the guard checked', () => {
    const unpinned = Object.entries(SHELL_CENSUS)
      .filter(
        ([path, entry]) =>
          entry.verdict === 'guarded' && !SHELL_PIN.test(codeOf(path)),
      )
      .map(([path]) => path);

    expect(unpinned).toEqual([]);
  });
});
