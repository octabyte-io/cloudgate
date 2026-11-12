import { checkCatalogue } from '../../../src/templates/check';
import type { Template } from '../../../src/templates/check';
import {
  deployTargetRefusals,
  environmentRefusal,
} from '../../../src/templates/setup/setup-eligibility';
import type { DeployTarget } from '../../../src/project-config';
import { catalogueZip } from '../zip.fixture';

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30"/></svg>';

/** One template, read by the Template check itself. */
function template(
  cloudgateYaml: string,
  templateYaml = '',
  more: Record<string, string> = {},
): Template {
  const result = checkCatalogue(
    catalogueZip([
      {
        id: 'demo',
        revision: 'r1',
        files: {
          'template.yaml': `name: Demo\ndescription: A demo.\ntags: [demo]\ncloudgate: 0.1.0\n${templateYaml}`,
          'cloudgate.yaml': cloudgateYaml,
          'logo.svg': SVG,
          ...more,
        },
      },
    ]),
    { cloudgateVersion: '9.9.9' },
  );
  if (!result.ok || result.offered.length !== 1) {
    throw new Error(
      result.ok ? result.hidden.map((h) => h.reason).join('; ') : result.reason,
    );
  }
  return result.offered[0];
}

const SERVER: DeployTarget = { kind: 'server', serverId: 'srv-1' };
const PLATFORM: DeployTarget = { kind: 'platform-host' };
const GOOGLE: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'europe-west1',
};
const ON = { cloud: null, hosted: false, platformHostGeneratesHosts: true };

describe('environmentRefusal', () => {
  it('lets a Server take any own kind', () => {
    const own = template(
      'version: 1\nservices:\n  app:\n    kind: web\n    source: { image: "nginx:1.27" }\n  db:\n    kind: postgres\n',
    );

    expect(environmentRefusal(own, SERVER, ON)).toBeNull();
  });

  it('lets a cloud take a template whose every kind its kind table holds', () => {
    const own = template(
      'version: 1\nservices:\n  app:\n    kind: web\n    source: { image: "nginx:1.27" }\n  db:\n    kind: postgres\n',
    );

    expect(environmentRefusal(own, GOOGLE, { ...ON, cloud: 'gcp' })).toBeNull();
  });

  it('refuses the platform host on the Hosted instance', () => {
    const own = template('version: 1\nservices:\n  db:\n    kind: redis\n');

    expect(environmentRefusal(own, PLATFORM, { ...ON, hosted: true })).toMatch(
      /platform host/,
    );
  });

  it('answers a new Project by kind of Deploy target, as for an Environment on it', () => {
    const own = template('version: 1\nservices:\n  db:\n    kind: redis\n');

    expect(
      deployTargetRefusals(own, {
        hosted: true,
        platformHostGeneratesHosts: true,
      }),
    ).toEqual({
      server: null,
      platformHost: expect.stringMatching(/platform host/) as string,
      aws: null,
      gcp: null,
    });
  });

  const STACK = () =>
    template(
      'version: 1\nservices:\n  app:\n    kind: compose\n    managed: console\n',
      'compose: app\nfiles:\n  - { path: nginx.conf }\n',
      {
        'docker-compose.yml': 'services:\n  web:\n    image: nginx:1.27\n',
        'files/nginx.conf': 'server {}\n',
      },
    );

  it('lets a Server and the platform host take a compose part and its files', () => {
    expect(environmentRefusal(STACK(), SERVER, ON)).toBeNull();
    expect(environmentRefusal(STACK(), PLATFORM, ON)).toBeNull();
  });

  it('lets a Cloud Environment take a compose part and its files, on its own Stack VM', () => {
    expect(
      environmentRefusal(STACK(), GOOGLE, { ...ON, cloud: 'gcp' }),
    ).toBeNull();
    expect(
      deployTargetRefusals(STACK(), {
        hosted: false,
        platformHostGeneratesHosts: true,
      }),
    ).toEqual({ server: null, platformHost: null, aws: null, gcp: null });
  });

  it('refuses an own part’s config file in a Cloud Environment, where its Service has no container to mount it in', () => {
    const own = template(
      'version: 1\nservices:\n  app:\n    kind: web\n    source: { image: "nginx:1.27" }\n',
      'files:\n  - { path: nginx.conf, entry: app, mount: /etc/nginx/nginx.conf }\n',
      { 'files/nginx.conf': 'server {}\n' },
    );

    expect(environmentRefusal(own, SERVER, ON)).toBeNull();
    expect(environmentRefusal(own, GOOGLE, { ...ON, cloud: 'gcp' })).toBe(
      'It ships a config file for app, and a Service in a Cloud account has no container to mount it in',
    );
  });

  it('takes a value referring to a compose Domain, whose host setup picks', () => {
    const stack = template(
      'version: 1\nservices:\n  app:\n    kind: compose\n    managed: console\n',
      'compose: app\ninputs:\n  URL: { value: "{{domains.web.url}}" }\ndomains:\n  - { service: web, port: 80 }\n',
      {
        'docker-compose.yml':
          'services:\n  web:\n    image: nginx:1.27\n    environment:\n      URL: ${URL}\n',
      },
    );

    expect(environmentRefusal(stack, SERVER, ON)).toBeNull();
  });
});

describe("environmentRefusal of a template naming an own web's URL", () => {
  const named = template(
    'version: 1\nservices:\n  app:\n    kind: web\n    source: { image: "ghost:5.96" }\n    env: [PUBLIC_URL]\n',
    'inputs:\n  PUBLIC_URL: { value: "{{domains.app.url}}" }\n',
  );

  it('lets a Server take it, since its web gets a generated host there', () => {
    expect(environmentRefusal(named, SERVER, ON)).toBeNull();
  });

  it('lets the platform host take it while it has a public address', () => {
    expect(environmentRefusal(named, PLATFORM, ON)).toBeNull();
  });

  it('refuses the platform host with no public address, which gives no generated host', () => {
    expect(
      environmentRefusal(named, PLATFORM, {
        ...ON,
        platformHostGeneratesHosts: false,
      }),
    ).toBe(
      "Its web app's URL is filled in at setup on a generated host, and the platform host has no public address to carry in one: set it in Settings → Instance",
    );
  });

  it('refuses a Cloud Environment, where a web gets no generated host', () => {
    expect(environmentRefusal(named, GOOGLE, { ...ON, cloud: 'gcp' })).toBe(
      "Its web app's URL is filled in at setup on a generated host, and a web in a Cloud Environment gets no generated host",
    );
  });

  it('lets a cloud take a template whose web no value names', () => {
    const unnamed = template(
      'version: 1\nservices:\n  app:\n    kind: web\n    source: { image: "ghost:5.96" }\n',
    );

    expect(
      environmentRefusal(unnamed, GOOGLE, { ...ON, cloud: 'gcp' }),
    ).toBeNull();
  });
});
