import {
  GCP_NETWORK_ADDRESS_RANGE,
  networkDefinition,
} from '../../../../src/cloud-accounts/gcp/definitions/network-definition';
import { idKey } from '../../../../src/cloud-accounts/gcp/definitions/names';
import {
  buildIdentityNames,
  buildPieceNames,
} from '../../../../src/cloud-accounts/gcp/cloud-build-names';
import { renderDefinition } from '../../../../src/cloud-accounts/definitions/tofu-json';
import {
  addresses,
  resource,
  resources,
} from '../../aws/definitions/definition-helpers';

const INPUT = {
  cloudAccountId: 'Cloud_Acct-1',
  projectId: 'acme-prod-123',
  region: 'europe-west1',
  environmentId: 'Env_Prod',
  stateId: 'State_Net-1',
  domains: [],
  privateLinks: [],
};

const ENV = idKey('Env_Prod');

const DOMAINS = [
  {
    domainId: 'Dom_B',
    host: 'www.acme.dev',
    path: '/',
    attempt: 1,
    serviceId: 'Svc_Web',
  },
  {
    domainId: 'Dom_A',
    host: 'acme.dev',
    path: '/',
    attempt: 1,
    serviceId: 'Svc_Web',
  },
];

/**
 * The google provider's resources that have a `labels` argument, read from
 * the provider's own documentation (hashicorp/google 8.x), among the kinds
 * the network makes. Networks, subnets, proxies and URL maps have none;
 * forwarding rules have one, but Google takes no label on an external load
 * balancer's forwarding rule, so the spec (S5) leaves them unlabelled.
 */
const LABELLED_TYPES = [
  'google_compute_global_address',
  'google_certificate_manager_certificate',
  'google_certificate_manager_certificate_map',
  'google_certificate_manager_certificate_map_entry',
  'google_certificate_manager_dns_authorization',
];

describe('networkDefinition (Google)', () => {
  const definition = networkDefinition(INPUT);

  describe('shape', () => {
    it('holds exactly the VPC, subnet, global IP, both rules, proxies and URL maps, and the certificate map with its default', () => {
      expect(addresses(definition)).toEqual(
        [
          'google_compute_network.network',
          'google_compute_subnetwork.network',
          'google_compute_global_address.network',
          'google_compute_global_forwarding_rule.https',
          'google_compute_global_forwarding_rule.http',
          'google_compute_target_https_proxy.network',
          'google_compute_target_http_proxy.network',
          'google_compute_url_map.network',
          'google_compute_url_map.redirect',
          'google_certificate_manager_certificate_map.network',
          'google_certificate_manager_certificate.default',
          'google_certificate_manager_certificate_map_entry.default',
          'google_certificate_manager_dns_authorization.domain',
          'google_certificate_manager_certificate.domain',
          'google_certificate_manager_certificate_map_entry.domain',
        ].sort(),
      );
    });

    it('makes no PSC piece, no NAT, no router and no firewall rule', () => {
      const types = resources(definition).map((r) => r.type);
      for (const absent of [
        'google_compute_router',
        'google_compute_router_nat',
        'google_compute_firewall',
        'google_network_connectivity_service_connection_policy',
        'google_compute_global_network_endpoint_group',
      ]) {
        expect(types).not.toContain(absent);
      }
      // One subnet only: the PSC subnet is slice 7's.
      expect(types.filter((t) => t === 'google_compute_subnetwork')).toEqual([
        'google_compute_subnetwork',
      ]);
      const text = renderDefinition(definition);
      expect(text).not.toContain('10.64.16.');
      expect(text).not.toContain('10.64.32.');
    });

    it('documents the PSC and private-services-access ranges as reserved, clear of the subnet', () => {
      expect(GCP_NETWORK_ADDRESS_RANGE).toEqual({
        subnet: '10.64.0.0/20',
        reserved: {
          privateServiceConnect: '10.64.16.0/24',
          privateServicesAccessFallback: '10.64.32.0/20',
        },
      });
    });

    it('is a custom-mode VPC with one subnet in the region, 10.64.0.0/20, with Private Google Access', () => {
      expect(
        resource(definition, 'google_compute_network.network'),
      ).toMatchObject({
        name: `cloudgate-${ENV}-net`,
        auto_create_subnetworks: false,
      });
      expect(
        resource(definition, 'google_compute_subnetwork.network'),
      ).toMatchObject({
        name: `cloudgate-${ENV}-subnet`,
        network: '${google_compute_network.network.id}',
        region: 'europe-west1',
        ip_cidr_range: '10.64.0.0/20',
        private_ip_google_access: true,
      });
    });

    it('serves 443 on the fixed global IP through the HTTPS proxy and its certificate map', () => {
      expect(
        resource(definition, 'google_compute_global_address.network'),
      ).toMatchObject({
        name: `cloudgate-${ENV}-ip`,
        address_type: 'EXTERNAL',
        ip_version: 'IPV4',
      });
      expect(
        resource(definition, 'google_compute_global_forwarding_rule.https'),
      ).toMatchObject({
        name: `cloudgate-${ENV}-https`,
        ip_address: '${google_compute_global_address.network.id}',
        port_range: '443',
        ip_protocol: 'TCP',
        load_balancing_scheme: 'EXTERNAL_MANAGED',
        target: '${google_compute_target_https_proxy.network.id}',
      });
      expect(
        resource(definition, 'google_compute_target_https_proxy.network'),
      ).toMatchObject({
        name: `cloudgate-${ENV}-https-proxy`,
        url_map: '${google_compute_url_map.network.id}',
        certificate_map:
          '//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.network.id}',
      });
    });

    it('redirects port 80 on the same IP to 443', () => {
      expect(
        resource(definition, 'google_compute_global_forwarding_rule.http'),
      ).toMatchObject({
        name: `cloudgate-${ENV}-http`,
        ip_address: '${google_compute_global_address.network.id}',
        port_range: '80',
        load_balancing_scheme: 'EXTERNAL_MANAGED',
        target: '${google_compute_target_http_proxy.network.id}',
      });
      expect(
        resource(definition, 'google_compute_target_http_proxy.network'),
      ).toMatchObject({
        name: `cloudgate-${ENV}-http-proxy`,
        url_map: '${google_compute_url_map.redirect.id}',
      });
      expect(
        resource(definition, 'google_compute_url_map.redirect'),
      ).toMatchObject({
        name: `cloudgate-${ENV}-redirect`,
        default_url_redirect: {
          https_redirect: true,
          redirect_response_code: 'MOVED_PERMANENTLY_DEFAULT',
          strip_query: false,
        },
      });
    });

    it('serves a self-signed certificate Cloudgate makes as the map’s main entry', () => {
      expect(
        resource(definition, 'google_certificate_manager_certificate.default'),
      ).toMatchObject({
        name: `cloudgate-${ENV}-default`,
        self_managed: {
          pem_certificate: '${var.default_certificate_body}',
          pem_private_key: '${var.default_certificate_private_key}',
        },
        // A new certificate comes with every run; only the first is uploaded.
        lifecycle: { ignore_changes: ['self_managed'] },
      });
      expect(
        resource(
          definition,
          'google_certificate_manager_certificate_map_entry.default',
        ),
      ).toMatchObject({
        name: `cloudgate-${ENV}-default`,
        map: '${google_certificate_manager_certificate_map.network.name}',
        matcher: 'PRIMARY',
        certificates: ['${google_certificate_manager_certificate.default.id}'],
      });
      expect(
        resource(
          definition,
          'google_certificate_manager_certificate_map.network',
        ),
      ).toMatchObject({ name: `cloudgate-${ENV}-certs` });
      expect(definition.variable).toEqual({
        default_certificate_body: { type: 'string' },
        default_certificate_private_key: { type: 'string', sensitive: true },
      });
    });

    it('outputs the names, the fixed IP and the Domains’ certificates', () => {
      expect(definition.output).toEqual({
        domain_certificates: { value: expect.any(String) as string },
        network_name: { value: '${google_compute_network.network.name}' },
        subnet_name: { value: '${google_compute_subnetwork.network.name}' },
        ip_address: {
          value: '${google_compute_global_address.network.address}',
        },
        url_map_name: { value: '${google_compute_url_map.network.name}' },
        certificate_map_name: {
          value: '${google_certificate_manager_certificate_map.network.name}',
        },
      });
    });
  });

  describe('Domains', () => {
    const domainBlocks = (d: Record<string, unknown>) => ({
      authorizations: resource(
        d,
        'google_certificate_manager_dns_authorization.domain',
      ).for_each,
      certificates: resource(d, 'google_certificate_manager_certificate.domain')
        .for_each,
      entries: resource(
        d,
        'google_certificate_manager_certificate_map_entry.domain',
      ).for_each,
    });

    it('with none, has no host rule and no Domain pieces, and sends an unknown host nowhere', () => {
      const urls = resource(definition, 'google_compute_url_map.network');
      expect(urls).toMatchObject({
        name: `cloudgate-${ENV}-urls`,
        host_rule: [],
        path_matcher: [],
        default_url_redirect: { host_redirect: 'cloudgate.invalid' },
      });
      expect(urls).not.toHaveProperty('default_service');
      expect(domainBlocks(definition)).toEqual({
        authorizations: {},
        certificates: {},
        entries: {},
      });
    });

    it('with one, routes its host to its Service’s backend service and gives it an authorization, certificate and map entry', () => {
      const one = networkDefinition({ ...INPUT, domains: [DOMAINS[0]] });
      const name = `cloudgate-${idKey('Dom_B')}`;
      const backend = `projects/acme-prod-123/global/backendServices/cloudgate-${idKey('Svc_Web')}`;
      expect(resource(one, 'google_compute_url_map.network')).toMatchObject({
        host_rule: [{ hosts: ['www.acme.dev'], path_matcher: name }],
        path_matcher: [{ name, default_service: backend }],
      });
      expect(domainBlocks(one)).toEqual({
        authorizations: { Dom_B: { host: 'www.acme.dev', name } },
        certificates: { Dom_B: { host: 'www.acme.dev', name } },
        entries: { Dom_B: { host: 'www.acme.dev', name } },
      });
      expect(
        resource(one, 'google_certificate_manager_dns_authorization.domain'),
      ).toMatchObject({
        name: '${each.value.name}',
        domain: '${each.value.host}',
      });
      expect(
        resource(one, 'google_certificate_manager_certificate.domain'),
      ).toMatchObject({
        name: '${each.value.name}',
        managed: {
          domains: ['${each.value.host}'],
          dns_authorizations: [
            '${google_certificate_manager_dns_authorization.domain[each.key].id}',
          ],
        },
      });
      expect(
        resource(
          one,
          'google_certificate_manager_certificate_map_entry.domain',
        ),
      ).toMatchObject({
        name: '${each.value.name}',
        map: '${google_certificate_manager_certificate_map.network.name}',
        hostname: '${each.value.host}',
        certificates: [
          '${google_certificate_manager_certificate.domain[each.key].id}',
        ],
      });
    });

    it("routes a Stack VM's Domain to the backend service its stack names for the port (#1371)", () => {
      const onStack = networkDefinition({
        ...INPUT,
        domains: [
          {
            domainId: 'Dom_S',
            host: 'shop.acme.dev',
            path: '/',
            attempt: 1,
            serviceId: 'Cmp_Shop',
            backend: 'cloudgate-shopkey-p3000',
          },
        ],
      });
      expect(
        resource(onStack, 'google_compute_url_map.network').path_matcher,
      ).toEqual([
        {
          name: `cloudgate-${idKey('Dom_S')}`,
          default_service:
            'projects/acme-prod-123/global/backendServices/cloudgate-shopkey-p3000',
        },
      ]);
    });

    it('with two, writes one host rule each, in the same order whatever order they come in', () => {
      const two = networkDefinition({ ...INPUT, domains: DOMAINS });
      const urls = resource(two, 'google_compute_url_map.network');
      expect(urls.host_rule).toEqual([
        { hosts: ['acme.dev'], path_matcher: `cloudgate-${idKey('Dom_A')}` },
        {
          hosts: ['www.acme.dev'],
          path_matcher: `cloudgate-${idKey('Dom_B')}`,
        },
      ]);
      expect(Object.keys(domainBlocks(two).certificates as object)).toEqual([
        'Dom_A',
        'Dom_B',
      ]);
      expect(
        renderDefinition(
          networkDefinition({ ...INPUT, domains: [...DOMAINS].reverse() }),
        ),
      ).toBe(renderDefinition(two));
    });

    it('escapes an operator’s host against ${ and %{', () => {
      const odd = networkDefinition({
        ...INPUT,
        domains: [
          {
            domainId: 'Dom_X',
            host: 'a${b}%{c}.dev',
            path: '/',
            attempt: 1,
            serviceId: 'S',
          },
        ],
      });
      const urls = resource(odd, 'google_compute_url_map.network');
      expect(urls.host_rule).toEqual([
        {
          hosts: ['a$${b}%%{c}.dev'],
          path_matcher: expect.any(String) as string,
        },
      ]);
      expect(domainBlocks(odd).certificates).toEqual({
        Dom_X: { host: 'a$${b}%%{c}.dev', name: expect.any(String) as string },
      });
    });
    it('routes a Domain with a path by that path and its sub-paths, and the rest of its host nowhere', () => {
      const api = networkDefinition({
        ...INPUT,
        domains: [{ ...DOMAINS[0], path: '/api' }],
      });
      const backend = `projects/acme-prod-123/global/backendServices/cloudgate-${idKey('Svc_Web')}`;
      expect(
        resource(api, 'google_compute_url_map.network').path_matcher,
      ).toEqual([
        {
          name: `cloudgate-${idKey('Dom_B')}`,
          default_url_redirect: {
            host_redirect: 'cloudgate.invalid',
            redirect_response_code: 'FOUND',
            strip_query: true,
          },
          path_rule: [{ paths: ['/api', '/api/*'], service: backend }],
        },
      ]);
    });

    it('names a later attempt’s certificate and map entry anew, keeping the authorization’s name', () => {
      const again = networkDefinition({
        ...INPUT,
        domains: [{ ...DOMAINS[0], attempt: 3 }],
      });
      const name = `cloudgate-${idKey('Dom_B')}`;
      expect(domainBlocks(again)).toEqual({
        authorizations: { Dom_B: { host: 'www.acme.dev', name } },
        certificates: { Dom_B: { host: 'www.acme.dev', name: `${name}-3` } },
        entries: { Dom_B: { host: 'www.acme.dev', name: `${name}-3` } },
      });
    });

    it('answers each certificate’s name and its authorization’s CNAME, by Domain id', () => {
      expect(definition.output).toMatchObject({
        domain_certificates: {
          value: expect.stringContaining(
            'for key, certificate in google_certificate_manager_certificate.domain : key => { id = certificate.id, validation = [for record in google_certificate_manager_dns_authorization.domain[key].dns_resource_record',
          ) as string,
        },
      });
    });
  });

  describe("a static site's Domains", () => {
    const SITE = {
      domainId: 'Dom_Docs',
      host: 'docs.acme.dev',
      path: '/',
      attempt: 1,
      serviceId: 'Svc_Docs',
      site: { spa: false },
    };
    const name = `cloudgate-${idKey('Dom_Docs')}`;
    const bucket = `projects/acme-prod-123/global/backendBuckets/cloudgate-${idKey('Svc_Docs')}`;
    const matchers = (domains: (typeof SITE)[]) =>
      resource(
        networkDefinition({ ...INPUT, domains }),
        'google_compute_url_map.network',
      ).path_matcher as Record<string, unknown>[];

    it("routes its host to the site's backend bucket, rewriting / to /live/ once", () => {
      const urls = resource(
        networkDefinition({ ...INPUT, domains: [SITE] }),
        'google_compute_url_map.network',
      );
      expect(urls.host_rule).toEqual([
        { hosts: ['docs.acme.dev'], path_matcher: name },
      ]);
      expect(urls.path_matcher).toEqual([
        {
          name,
          default_service: bucket,
          default_route_action: {
            url_rewrite: { path_prefix_rewrite: '/live' },
          },
        },
      ]);
    });

    it('gives each of its Domains its own host rule onto the same backend bucket and rewrite', () => {
      const two = matchers([
        SITE,
        { ...SITE, domainId: 'Dom_Www', host: 'www.docs.acme.dev' },
      ]);
      expect(two).toHaveLength(2);
      for (const one of two) {
        expect(one).toMatchObject({
          default_service: bucket,
          default_route_action: {
            url_rewrite: { path_prefix_rewrite: '/live' },
          },
        });
      }
    });

    it('answers a missing page with the live shell and 200 only under spa: true', () => {
      const [off] = matchers([SITE]);
      expect(off).not.toHaveProperty('default_custom_error_response_policy');

      const [on] = matchers([{ ...SITE, site: { spa: true } }]);
      expect(on.default_custom_error_response_policy).toEqual({
        error_response_rule: [
          {
            match_response_codes: ['404'],
            path: '/live/index.html',
            override_response_code: 200,
          },
        ],
        error_service: bucket,
      });
    });

    it("leaves a web's Domain beside it on its backend service, with no rewrite", () => {
      const [web] = matchers([
        {
          ...SITE,
          domainId: 'Dom_A',
          host: 'acme.dev',
          serviceId: 'Svc_Web',
          site: undefined as unknown as { spa: boolean },
        },
      ]);
      expect(web).toEqual({
        name: `cloudgate-${idKey('Dom_A')}`,
        default_service: `projects/acme-prod-123/global/backendServices/cloudgate-${idKey('Svc_Web')}`,
      });
    });
  });

  describe('the mark', () => {
    const two = networkDefinition({ ...INPUT, domains: DOMAINS });

    it('names everything cloudgate-… within Google’s limits, starting with a letter', () => {
      const names = [
        ...resources(two).map((r) => r.body.name as string),
        ...Object.values(
          resource(two, 'google_certificate_manager_certificate.domain')
            .for_each as Record<string, { name: string }>,
        ).map((v) => v.name),
      ].filter((name) => !name.startsWith('${'));
      expect(names.length).toBeGreaterThan(10);
      for (const name of names) {
        // RFC 1035, as Google's compute names; Certificate Manager's are looser.
        expect(name).toMatch(/^[a-z]([-a-z0-9]*[a-z0-9])?$/);
        expect(name.startsWith('cloudgate-')).toBe(true);
        expect(name.length).toBeLessThanOrEqual(63);
      }
    });

    it('puts the unencoded ids in every description', () => {
      for (const { address, body } of resources(two)) {
        expect([address, body.description]).toEqual([
          address,
          'Cloudgate cloud-account=Cloud_Acct-1 environment=Env_Prod state=State_Net-1',
        ]);
      }
    });

    it('labels only the kinds whose resource takes labels, with the ids’ keys', () => {
      const labels = {
        'cloudgate-cloud-account': idKey('Cloud_Acct-1'),
        'cloudgate-environment': idKey('Env_Prod'),
        'cloudgate-state': idKey('State_Net-1'),
      };
      for (const { address, type, body } of resources(two)) {
        expect([address, body.labels]).toEqual([
          address,
          LABELLED_TYPES.includes(type) ? labels : undefined,
        ]);
      }
    });
  });

  describe("Cloud SQL's private link", () => {
    const linked = networkDefinition({ ...INPUT, privateLinks: ['cloud-sql'] });

    it('is not there on a network no database has needed', () => {
      expect(addresses(definition)).not.toContain(
        'google_compute_subnetwork.private_link',
      );
      expect(
        addresses(definition).filter((address) =>
          address.startsWith(
            'google_network_connectivity_service_connection_policy.',
          ),
        ),
      ).toEqual([]);
    });

    it('adds its subnet on the reserved range and one Cloud SQL policy on it, beside everything else', () => {
      expect(addresses(linked)).toEqual(
        [
          ...addresses(definition),
          'google_compute_subnetwork.private_link',
          'google_network_connectivity_service_connection_policy.cloud_sql',
        ].sort(),
      );
      expect(
        resource(linked, 'google_compute_subnetwork.private_link'),
      ).toEqual(
        expect.objectContaining({
          name: `cloudgate-${ENV}-psc`,
          network: '${google_compute_network.network.id}',
          region: 'europe-west1',
          ip_cidr_range: '10.64.16.0/24',
        }),
      );
      expect(
        resource(
          linked,
          'google_network_connectivity_service_connection_policy.cloud_sql',
        ),
      ).toEqual(
        expect.objectContaining({
          name: `cloudgate-${ENV}-psc-sql`,
          location: 'europe-west1',
          service_class: 'google-cloud-sql',
          network: '${google_compute_network.network.id}',
          psc_config: {
            subnetworks: ['${google_compute_subnetwork.private_link.id}'],
          },
        }),
      );
    });

    it("uses the address plan's reserved range, clear of the Services' subnet", () => {
      expect(GCP_NETWORK_ADDRESS_RANGE.reserved.privateServiceConnect).toBe(
        '10.64.16.0/24',
      );
      expect(
        resource(linked, 'google_compute_subnetwork.network').ip_cidr_range,
      ).toBe('10.64.0.0/20');
    });

    it('writes each kind once, whatever the list repeats', () => {
      expect(
        renderDefinition(
          networkDefinition({
            ...INPUT,
            privateLinks: ['cloud-sql', 'cloud-sql'],
          }),
        ),
      ).toBe(renderDefinition(linked));
    });
  });

  describe("Memorystore's private link", () => {
    const POLICY =
      'google_network_connectivity_service_connection_policy.memorystore';
    const FIREWALL = 'google_compute_firewall.redis_ports';
    const alone = networkDefinition({
      ...INPUT,
      privateLinks: ['memorystore'],
    });
    const both = networkDefinition({
      ...INPUT,
      privateLinks: ['memorystore', 'cloud-sql'],
    });

    it('adds the subnet, a Memorystore policy on it and the firewall rule for Redis’s ports when it comes first', () => {
      expect(addresses(alone)).toEqual(
        [
          ...addresses(definition),
          FIREWALL,
          'google_compute_subnetwork.private_link',
          POLICY,
        ].sort(),
      );
      expect(resource(alone, POLICY)).toEqual(
        expect.objectContaining({
          name: `cloudgate-${ENV}-psc-redis`,
          location: 'europe-west1',
          service_class: 'gcp-memorystore',
          network: '${google_compute_network.network.id}',
          psc_config: {
            subnetworks: ['${google_compute_subnetwork.private_link.id}'],
          },
        }),
      );
    });

    it("opens 6379 and 11000–13047 from the network's Services to the link's subnet", () => {
      expect(resource(alone, FIREWALL)).toEqual(
        expect.objectContaining({
          name: `cloudgate-${ENV}-psc-redis-ports`,
          network: '${google_compute_network.network.id}',
          direction: 'EGRESS',
          destination_ranges: ['10.64.16.0/24'],
          allow: [{ protocol: 'tcp', ports: ['6379', '11000-13047'] }],
        }),
      );
      expect(resource(alone, FIREWALL).description).toContain('Cloudgate');
    });

    it('shares one subnet with Cloud SQL’s link, each kind its own policy', () => {
      expect(
        addresses(both).filter(
          (address) =>
            address.startsWith('google_compute_subnetwork.') ||
            address.startsWith(
              'google_network_connectivity_service_connection_policy.',
            ) ||
            address.startsWith('google_compute_firewall.'),
        ),
      ).toEqual([
        FIREWALL,
        'google_compute_subnetwork.network',
        'google_compute_subnetwork.private_link',
        'google_network_connectivity_service_connection_policy.cloud_sql',
        POLICY,
      ]);
    });

    it("has no firewall rule on a network only Cloud SQL's link is on", () => {
      expect(
        addresses(
          networkDefinition({ ...INPUT, privateLinks: ['cloud-sql'] }),
        ).filter((address) => address.startsWith('google_compute_firewall.')),
      ).toEqual([]);
    });
  });

  describe('the run.app zone of its Private web services', () => {
    const ZONE = 'google_dns_managed_zone.run_app';
    const WILDCARD = 'google_dns_record_set.run_app_wildcard';
    const APEX = 'google_dns_record_set.run_app';
    const PRIVATE_GOOGLE_ACCESS = [
      '199.36.153.8',
      '199.36.153.9',
      '199.36.153.10',
      '199.36.153.11',
    ];
    const zoned = networkDefinition({
      ...INPUT,
      privateLinks: ['run-app-zone'],
    });

    it('is not there on a network no Private web service has needed', () => {
      expect(
        addresses(definition).filter((address) =>
          address.startsWith('google_dns_'),
        ),
      ).toEqual([]);
    });

    it('adds a private zone for run.app. bound to the Environment VPC, and its two records, beside everything else', () => {
      expect(addresses(zoned)).toEqual(
        [...addresses(definition), ZONE, WILDCARD, APEX].sort(),
      );
      expect(resource(zoned, ZONE)).toEqual({
        name: `cloudgate-${ENV}-run-app`,
        dns_name: 'run.app.',
        visibility: 'private',
        description:
          'Cloudgate cloud-account=Cloud_Acct-1 environment=Env_Prod state=State_Net-1',
        labels: {
          'cloudgate-cloud-account': idKey('Cloud_Acct-1'),
          'cloudgate-environment': idKey('Env_Prod'),
          'cloudgate-state': idKey('State_Net-1'),
        },
        private_visibility_config: {
          networks: [{ network_url: '${google_compute_network.network.id}' }],
        },
      });
    });

    it("points *.run.app and run.app at private.googleapis.com's four addresses", () => {
      for (const [address, name] of [
        [WILDCARD, '*.run.app.'],
        [APEX, 'run.app.'],
      ]) {
        expect(resource(zoned, address)).toEqual({
          name,
          managed_zone: '${google_dns_managed_zone.run_app.name}',
          type: 'A',
          ttl: 300,
          rrdatas: PRIVATE_GOOGLE_ACCESS,
        });
      }
    });

    it("needs no NAT, router or egress change: the subnet's Private Google Access already carries it", () => {
      expect(
        addresses(zoned).filter(
          (address) =>
            address.startsWith('google_compute_router') ||
            address.startsWith('google_compute_firewall.'),
        ),
      ).toEqual([]);
      expect(
        resource(zoned, 'google_compute_subnetwork.network')
          .private_ip_google_access,
      ).toBe(true);
    });

    it("sits beside a database's private link, each its own pieces", () => {
      const both = networkDefinition({
        ...INPUT,
        privateLinks: ['cloud-sql', 'run-app-zone'],
      });
      expect(addresses(both)).toEqual(
        expect.arrayContaining([
          ZONE,
          'google_compute_subnetwork.private_link',
          'google_network_connectivity_service_connection_policy.cloud_sql',
        ]),
      );
    });

    it("writes none of another cloud's kinds", () => {
      expect(
        addresses(
          networkDefinition({ ...INPUT, privateLinks: ['private-dns'] }),
        ),
      ).toEqual(addresses(definition));
    });
  });

  /**
   * A Stack VM has no external IP, so its way out is Cloud NAT on a Cloud
   * Router, which the first Stack VM adds (the owner's decision amending
   * ADR-0070, #1362).
   */
  describe('the Cloud NAT of its Stack VMs', () => {
    const ROUTER = 'google_compute_router.nat';
    const NAT = 'google_compute_router_nat.nat';
    const natted = networkDefinition({ ...INPUT, privateLinks: ['cloud-nat'] });

    it('is not there on a network no Stack VM has needed', () => {
      expect(
        addresses(definition).filter((address) =>
          address.startsWith('google_compute_router'),
        ),
      ).toEqual([]);
    });

    it('adds a Cloud Router on the VPC and its NAT for the subnet, beside everything else', () => {
      expect(addresses(natted)).toEqual(
        [...addresses(definition), ROUTER, NAT].sort(),
      );
      expect(resource(natted, ROUTER)).toEqual({
        name: `cloudgate-${ENV}-router`,
        description:
          'Cloudgate cloud-account=Cloud_Acct-1 environment=Env_Prod state=State_Net-1',
        region: 'europe-west1',
        network: '${google_compute_network.network.id}',
      });
      expect(resource(natted, NAT)).toEqual({
        name: `cloudgate-${ENV}-nat`,
        router: '${google_compute_router.nat.name}',
        region: 'europe-west1',
        nat_ip_allocate_option: 'AUTO_ONLY',
        source_subnetwork_ip_ranges_to_nat: 'LIST_OF_SUBNETWORKS',
        subnetwork: [
          {
            name: '${google_compute_subnetwork.network.id}',
            source_ip_ranges_to_nat: ['ALL_IP_RANGES'],
          },
        ],
      });
    });
  });

  /**
   * A hosted cloud build's standing piece (ADR-0047): the source
   * bucket, made by the network's own runs on the Hosted instance only.
   * Cloud Build needs nothing else standing.
   */
  describe("a hosted cloud build's source bucket", () => {
    const hosted = networkDefinition({ ...INPUT, cloudBuilds: true });
    const bucket = resource(hosted, 'google_storage_bucket.build_source');
    const name = bucket.name as string;

    it('is not there on a Self-hosted instance, which builds on its platform host', () => {
      expect(addresses(definition)).toEqual(
        addresses(networkDefinition({ ...INPUT, cloudBuilds: false })),
      );
      expect(JSON.stringify(definition)).not.toContain('build_source');
    });

    it('adds exactly the bucket', () => {
      expect(addresses(hosted)).toEqual(
        [...addresses(definition), 'google_storage_bucket.build_source'].sort(),
      );
    });

    it('is private, in the region, emptied with the network, and drops a left zip after a day', () => {
      expect(bucket).toEqual({
        name: buildPieceNames(INPUT).sourceBucketName,
        location: 'EUROPE-WEST1',
        force_destroy: true,
        uniform_bucket_level_access: true,
        public_access_prevention: 'enforced',
        soft_delete_policy: [{ retention_duration_seconds: 0 }],
        lifecycle_rule: [
          { condition: [{ age: 1 }], action: [{ type: 'Delete' }] },
        ],
        labels: {
          'cloudgate-cloud-account': idKey('Cloud_Acct-1'),
          'cloudgate-environment': ENV,
          'cloudgate-state': idKey('State_Net-1'),
        },
      });
      // Cloud Storage's rule for a name: 3-63 lowercase letters, digits and `-`.
      expect(name).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
      expect(name).toBe(`cloudgate-build-${idKey('Cloud_Acct-1')}-${ENV}`);
    });

    it("is named inside what this Cloud account's build identity reads, and outside another's", () => {
      const own = buildIdentityNames(INPUT);
      const other = buildIdentityNames({
        ...INPUT,
        cloudAccountId: 'Cloud_Acct-2',
      });
      expect(name.startsWith(own.sourceBucketStart)).toBe(true);
      expect(name.startsWith(other.sourceBucketStart)).toBe(false);
      expect(own.condition.expression).toContain(
        `resource.name.startsWith("projects/_/buckets/${own.sourceBucketStart}")`,
      );
    });
  });

  describe('provider', () => {
    it('acts in the project and region, adding no label of its own', () => {
      expect(definition.provider).toEqual({
        google: {
          project: 'acme-prod-123',
          region: 'europe-west1',
          add_terraform_attribution_label: false,
        },
      });
    });

    it('keeps its state in the pg backend without creating anything there', () => {
      expect(definition.terraform).toEqual({
        backend: {
          pg: {
            schema_name: 'infrastructure_state',
            skip_schema_creation: true,
            skip_table_creation: true,
            skip_index_creation: true,
          },
        },
      });
    });
  });

  it('writes the same text for the same input', () => {
    const input = { ...INPUT, domains: DOMAINS };
    expect(renderDefinition(networkDefinition(input))).toBe(
      renderDefinition(networkDefinition({ ...input })),
    );
  });
});
