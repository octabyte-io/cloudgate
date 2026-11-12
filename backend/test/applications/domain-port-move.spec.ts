import {
  domainPortMoveOf,
  portChangeOf,
} from '../../src/applications/domain-port-move';

describe('portChangeOf', () => {
  const onServer = { port: 3000, cloudAccountId: null };

  it('names the old and the new port of an Application on a Server or the platform host', () => {
    expect(portChangeOf(onServer, { port: 3900 })).toEqual({
      from: 3000,
      to: 3900,
    });
  });

  it('is no change when the port is not edited, or is edited to the value it has', () => {
    expect(portChangeOf(onServer, {})).toBeNull();
    expect(portChangeOf(onServer, { port: 3000 })).toBeNull();
  });

  it('is no change for an Application in a Cloud account, whose routing follows its Service', () => {
    expect(
      portChangeOf({ port: 3000, cloudAccountId: 'ca_1' }, { port: 3900 }),
    ).toBeNull();
  });
});

describe('domainPortMoveOf', () => {
  it('moves the Domains on the old port and names the others where they are', () => {
    const move = domainPortMoveOf({ from: 3000, to: 3900 }, [
      { domainId: 'd_api', host: 'api.example.com', port: 8080 },
      { domainId: 'd_www', host: 'www.example.com', port: 3000 },
      { domainId: 'd_shop', host: 'shop.example.com', port: 3000 },
      { domainId: 'd_bare', host: 'bare.example.com', port: null },
    ]);

    expect(move).toEqual({
      from: 3000,
      to: 3900,
      // By host, so the answer reads the same whichever order rows come back in.
      moved: [
        { domainId: 'd_shop', host: 'shop.example.com' },
        { domainId: 'd_www', host: 'www.example.com' },
      ],
      left: [
        { domainId: 'd_api', host: 'api.example.com', port: 8080 },
        // An unset port is not the old port: nothing says it pointed there.
        { domainId: 'd_bare', host: 'bare.example.com', port: null },
      ],
    });
  });

  it('moves nothing and leaves nothing for an Application with no Domain', () => {
    expect(domainPortMoveOf({ from: 3000, to: 3900 }, [])).toEqual({
      from: 3000,
      to: 3900,
      moved: [],
      left: [],
    });
  });
});
