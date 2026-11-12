import { parse } from 'yaml';

import { publishStackVmPorts } from '../../src/compose/stack-vm-ports';

/**
 * A compose service's Domain on a Stack VM (#1371): the load balancer
 * reaches the Stack VM's private address on the Domain's port, so the deploy
 * publishes that port on the Stack VM at the same number. The Domain's port
 * stays the container's port, as on Traefik.
 */

const ports = (content: string, service: string): unknown =>
  (parse(content) as { services: Record<string, { ports?: unknown }> })
    .services[service].ports;

const FILE = `services:
  web:
    image: ghost:5
  admin:
    image: adminer
    ports:
      - "9000:9000"
`;

describe('publishStackVmPorts', () => {
  it("publishes each Domain's port on the Stack VM, at the same number, on its service", () => {
    const content = publishStackVmPorts(FILE, [
      { host: 'blog.example.com', serviceName: 'web', port: 2368 },
      { host: 'db.example.com', serviceName: 'admin', port: 8080 },
    ]);
    expect(ports(content, 'web')).toEqual(['2368:2368']);
    expect(ports(content, 'admin')).toEqual(['9000:9000', '8080:8080']);
  });

  it('leaves a port the service already publishes at the same number as it is', () => {
    const content = publishStackVmPorts(FILE, [
      { host: 'db.example.com', serviceName: 'admin', port: 9000 },
    ]);
    expect(ports(content, 'admin')).toEqual(['9000:9000']);
  });

  it('publishes a port once, whatever number of Domains reach it', () => {
    const content = publishStackVmPorts(FILE, [
      { host: 'blog.example.com', serviceName: 'web', port: 2368 },
      { host: 'blog.example.com', serviceName: 'web', port: 2368 },
    ]);
    expect(ports(content, 'web')).toEqual(['2368:2368']);
  });

  it('hands the file back untouched when the stack has no Domain', () => {
    expect(publishStackVmPorts(FILE, [])).toBe(FILE);
  });

  it('refuses a Domain port the service already publishes on the Stack VM to another container port, naming both', () => {
    expect(() =>
      publishStackVmPorts(FILE.replace('"9000:9000"', '"8080:80"'), [
        { host: 'db.example.com', serviceName: 'admin', port: 8080 },
      ]),
    ).toThrow(
      'ports: service admin publishes 8080 on its Stack VM to container port 80, but its Domain reaches container port 8080 on that port. Remove that line from the compose file, or give the Domain port 80',
    );
  });

  it('refuses two services whose Domains reach the same port, which the Stack VM can publish once', () => {
    expect(() =>
      publishStackVmPorts(FILE, [
        { host: 'blog.example.com', serviceName: 'web', port: 3000 },
        { host: 'db.example.com', serviceName: 'admin', port: 3000 },
      ]),
    ).toThrow(
      'port: the Domains of services web and admin both reach port 3000, which a Stack VM publishes once. Give one of them another port',
    );
  });

  it('refuses a Domain naming a service the file does not have', () => {
    expect(() =>
      publishStackVmPorts(FILE, [
        { host: 'api.example.com', serviceName: 'api', port: 3000 },
      ]),
    ).toThrow(
      'Domain "api.example.com" is attached to service "api" which does not exist in the compose file',
    );
  });
});
