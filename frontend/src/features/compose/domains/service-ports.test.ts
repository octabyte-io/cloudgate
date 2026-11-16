import { describe, expect, it } from "vitest";

import { composeServicePorts } from "./service-ports";

const file = `
services:
  web:
    image: nginx
    expose: ["8080"]
  api:
    image: api
    ports:
      - "127.0.0.1:4000:4001/tcp"
  admin:
    image: admin
    ports:
      - target: 9000
        published: 9001
  ipv6:
    image: six
    ports: ["[::1]:7000:7001"]
  ranged:
    image: r
    expose: ["5000-5010"]
  db:
    image: postgres
`;

describe("composeServicePorts", () => {
  it("reads each service's container port from expose, then ports", () => {
    expect(composeServicePorts(file)).toEqual({
      web: 8080,
      api: 4001,
      admin: 9000,
      ipv6: 7001,
      ranged: 5000,
    });
  });

  it("prefers the port a Domain already routes the service on", () => {
    expect(
      composeServicePorts(file, [
        { serviceName: "web", port: 80 },
        { serviceName: "db", port: 5432 },
        { serviceName: null, port: 1234 },
      ]),
    ).toMatchObject({ web: 80, db: 5432 });
  });

  it("answers nothing for a file it cannot read", () => {
    expect(composeServicePorts(undefined)).toEqual({});
    expect(composeServicePorts("services: [")).toEqual({});
  });
});
