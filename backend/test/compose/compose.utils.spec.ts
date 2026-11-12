import {
  listComposePublishedPorts,
  listComposeServices,
  parseComposeFile,
} from '../../src/compose/compose.utils';

// parseComposeFile and listComposeServices: parsing is a pure function over
// the compose file content, with no disk IO.

const WORDPRESS_COMPOSE = `version: "3.8"
services:
  wordpress:
    image: wordpress:6
    ports:
      - "8080:80"
    depends_on:
      - db
    networks:
      - frontend
  db:
    image: mariadb:11
    environment:
      MYSQL_ROOT_PASSWORD: example
    volumes:
      - db-data:/var/lib/mysql
networks:
  frontend: {}
volumes:
  db-data: {}
`;

describe('parseComposeFile', () => {
  it('parses a compose YAML into structured services and networks', () => {
    const spec = parseComposeFile(WORDPRESS_COMPOSE);

    expect(spec).toEqual({
      version: '3.8',
      services: {
        wordpress: {
          image: 'wordpress:6',
          ports: ['8080:80'],
          depends_on: ['db'],
          networks: ['frontend'],
        },
        db: {
          image: 'mariadb:11',
          environment: { MYSQL_ROOT_PASSWORD: 'example' },
          volumes: ['db-data:/var/lib/mysql'],
        },
      },
      networks: { frontend: {} },
      volumes: { 'db-data': {} },
    });
  });

  it('resolves YAML anchors and aliases', () => {
    const spec = parseComposeFile(`services:
  a: &base
    image: nginx:alpine
  b: *base
`);

    expect(spec?.services?.b).toEqual({ image: 'nginx:alpine' });
  });

  it('returns null for empty content', () => {
    expect(parseComposeFile('')).toBeNull();
  });
});

describe('listComposeServices', () => {
  it('lists the service names of a compose file', () => {
    expect(listComposeServices(WORDPRESS_COMPOSE)).toEqual(['wordpress', 'db']);
  });

  it('returns an empty list when the file has no services', () => {
    expect(listComposeServices('networks: {}')).toEqual([]);
  });
});

describe('listComposePublishedPorts', () => {
  it('reads the fixed TCP ports a file publishes, in both spellings, and nothing a machine dial could not reach', () => {
    const file = [
      'services:',
      '  db:',
      '    image: postgres',
      '    ports:',
      '      - "5432:5432"',
      '      - "0.0.0.0:6543:5432/tcp"',
      '      - "127.0.0.1:7000:7000"',
      '      - "9000"',
      '      - "5353:53/udp"',
      '      - "${PORT}:80"',
      '  web:',
      '    image: nginx',
      '    ports:',
      '      - target: 80',
      '        published: 8080',
      '      - target: 81',
      '        published: "8081"',
      '        protocol: udp',
      '      - "3000-3001:4000-4001"',
    ].join('\n');

    expect(listComposePublishedPorts(file)).toEqual([
      { published: 5432, target: 5432, service: 'db' },
      { published: 6543, target: 5432, service: 'db' },
      { published: 8080, target: 80, service: 'web' },
      { published: 3000, target: 4000, service: 'web' },
      { published: 3001, target: 4001, service: 'web' },
    ]);
  });

  it('publishes nothing for a file that is empty or does not parse', () => {
    expect(listComposePublishedPorts('')).toEqual([]);
    expect(listComposePublishedPorts('services:\n  db: [unclosed')).toEqual([]);
  });
});
