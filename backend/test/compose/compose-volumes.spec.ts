import {
  listComposeServiceVolumes,
  listComposeVolumes,
} from '../../src/compose/compose.utils';

/**
 * The volumes a stack's Delete removes (`docker compose down --volumes`), as
 * Docker names them, which a plan's destroy line names (ADR-0069).
 */
describe('listComposeVolumes', () => {
  const file = [
    'services:',
    '  db:',
    '    image: postgres:18',
    '    volumes: [data:/var/lib/postgresql/data]',
    'volumes:',
    '  data:',
    '  cache: {}',
    '  named:',
    '    name: analytics-uploads',
    '  shared:',
    '    external: true',
  ].join('\n');

  it('names each declared volume under the project, or by its own name, never an external one', () => {
    expect(
      listComposeVolumes(file, 'compose-analytics-x1', 'docker-compose'),
    ).toEqual([
      'compose-analytics-x1_data',
      'compose-analytics-x1_cache',
      'analytics-uploads',
    ]);
  });

  it('names none for a stack, whose docker stack rm removes no volume', () => {
    expect(listComposeVolumes(file, 'compose-analytics-x1', 'stack')).toEqual(
      [],
    );
  });

  it('names none for a file that declares none, or does not parse', () => {
    expect(
      listComposeVolumes(
        'services:\n  a:\n    image: x\n',
        'p',
        'docker-compose',
      ),
    ).toEqual([]);
    expect(listComposeVolumes('services: [', 'p', 'docker-compose')).toEqual(
      [],
    );
  });
});

/**
 * The named volumes each service of a stack mounts, as Docker names them, so
 * a one-volume backup is picked as a service and then one of its volumes
 * (#162). Bind mounts are never among them.
 */
describe('listComposeServiceVolumes', () => {
  const file = [
    'services:',
    '  db:',
    '    image: postgres:18',
    '    volumes:',
    '      - data:/var/lib/postgresql/data',
    '      - ./init:/docker-entrypoint-initdb.d:ro',
    '  web:',
    '    image: n8nio/n8n:1.80',
    '    volumes:',
    '      - type: volume',
    '        source: named',
    '        target: /files',
    '      - type: bind',
    '        source: /srv/certs',
    '        target: /certs',
    '      - shared:/shared:ro',
    '      - /var/run/docker.sock:/var/run/docker.sock',
    '      - /cache',
    '  worker:',
    '    build: .',
    'volumes:',
    '  data:',
    '  named:',
    '    name: analytics-uploads',
    '  shared:',
    '    external: true',
  ].join('\n');

  it("names each service's named volumes, by name: and external ones by their own name, leaving out bind mounts", () => {
    expect(listComposeServiceVolumes(file, 'compose-analytics-x1')).toEqual([
      {
        serviceName: 'db',
        image: 'postgres:18',
        volumes: ['compose-analytics-x1_data'],
      },
      {
        serviceName: 'web',
        image: 'n8nio/n8n:1.80',
        volumes: ['analytics-uploads', 'shared'],
      },
      { serviceName: 'worker', image: null, volumes: [] },
    ]);
  });

  it("names a swarm stack's volumes the same way, under the stack's name", () => {
    expect(listComposeServiceVolumes(file, 'shop-stack')).toEqual([
      { serviceName: 'db', image: 'postgres:18', volumes: ['shop-stack_data'] },
      {
        serviceName: 'web',
        image: 'n8nio/n8n:1.80',
        volumes: ['analytics-uploads', 'shared'],
      },
      { serviceName: 'worker', image: null, volumes: [] },
    ]);
  });

  it('names an external volume by the name its legacy external block gives', () => {
    const legacy = [
      'services:',
      '  app:',
      '    image: nginx:1',
      '    volumes: [old:/data]',
      'volumes:',
      '  old:',
      '    external:',
      '      name: kept-from-before',
    ].join('\n');
    expect(listComposeServiceVolumes(legacy, 'p')).toEqual([
      { serviceName: 'app', image: 'nginx:1', volumes: ['kept-from-before'] },
    ]);
  });

  it('names no service for a file that does not parse', () => {
    expect(listComposeServiceVolumes('services: [', 'p')).toEqual([]);
  });
});
