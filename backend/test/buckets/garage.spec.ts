import {
  bucketCorsProgram,
  corsConfigurationXml,
  createBucketProgram,
  createKeyProgram,
  garageServiceSpec,
  garageToml,
  readCreatedKey,
  readRemovedKeys,
  removeKeysProgram,
} from '../../src/buckets/garage';

const credential = { rpcSecret: 'ab'.repeat(32), adminToken: 'admin-token' };

describe('garageToml', () => {
  it('starts Garage as one node in us-east-1, its files under the volume', () => {
    const toml = garageToml(credential);
    expect(toml).toContain('s3_region = "us-east-1"');
    expect(toml).toContain('replication_factor = 1');
    expect(toml).toContain('metadata_dir = "/var/lib/garage/meta"');
    expect(toml).toContain('data_dir = "/var/lib/garage/data"');
    expect(toml).toContain(`rpc_secret = "${credential.rpcSecret}"`);
    expect(toml).toContain('admin_token = "admin-token"');
  });

  it('listens on every IPv4 address, so it starts on a Server whose kernel has no IPv6', () => {
    const toml = garageToml(credential);
    expect(toml).toContain('rpc_bind_addr = "0.0.0.0:3901"');
    expect(toml).toContain('api_bind_addr = "0.0.0.0:3900"');
    expect(toml).toContain('api_bind_addr = "0.0.0.0:3903"');
    expect(toml).not.toContain('[::]');
  });
});

describe('garageServiceSpec', () => {
  it('runs the pinned Garage on its own volume with its config as a secret, and publishes nothing', () => {
    const spec = garageServiceSpec(
      {
        appName: 'bucket-abc123',
        volumeName: 'bucket-abc123-data',
        serverId: null,
        labelsSwarm: null,
      },
      { secretId: 'sec-1', secretName: 'bucket-abc123-garage-config' },
    );
    const container = (
      spec.TaskTemplate as { ContainerSpec: Record<string, unknown> }
    ).ContainerSpec;

    expect(spec.Name).toBe('bucket-abc123');
    expect(container.Image).toBe('dxflrs/garage:v2.1.0');
    expect(container.Mounts).toEqual([
      {
        Type: 'volume',
        Source: 'bucket-abc123-data',
        Target: '/var/lib/garage',
      },
    ]);
    expect(container.Secrets).toEqual([
      expect.objectContaining({
        SecretID: 'sec-1',
        SecretName: 'bucket-abc123-garage-config',
        File: expect.objectContaining({ Name: '/etc/garage.toml' }) as object,
      }),
    ]);
    expect(spec.EndpointSpec?.Ports).toEqual([]);
  });

  describe('its labels, the one Swarm setting a bucket’s native.docker takes', () => {
    const garage = (labelsSwarm: Record<string, string> | null) =>
      garageServiceSpec(
        {
          appName: 'bucket-abc123',
          volumeName: 'bucket-abc123-data',
          serverId: null,
          labelsSwarm,
        },
        { secretId: 'sec-1', secretName: 'bucket-abc123-garage-config' },
      );
    const containerOf = (spec: ReturnType<typeof garageServiceSpec>) =>
      (spec.TaskTemplate as { ContainerSpec: Record<string, unknown> })
        .ContainerSpec;

    it('carries the stored labels onto Garage’s container', () => {
      expect(containerOf(garage({ 'com.example.backup': 'nightly' }))).toEqual(
        expect.objectContaining({
          Labels: { 'com.example.backup': 'nightly' },
        }),
      );
    });

    it('keeps every other Swarm setting Cloudgate’s, with labels or none', () => {
      const plain = garage(null);
      expect(containerOf(plain).Labels).toBeUndefined();
      for (const spec of [plain, garage({ team: 'data' })]) {
        const task = spec.TaskTemplate as Record<string, unknown>;
        const container = containerOf(spec);
        expect(container.HealthCheck).toBeUndefined();
        expect(container.Ulimits).toBeUndefined();
        expect(container.StopGracePeriod).toBe(30_000_000_000);
        expect(task.RestartPolicy).toBeUndefined();
        expect(task.Resources).toEqual(
          (plain.TaskTemplate as Record<string, unknown>).Resources,
        );
        expect(spec.UpdateConfig).toEqual({
          Parallelism: 1,
          Order: 'stop-first',
          FailureAction: 'rollback',
        });
        expect(spec.RollbackConfig).toEqual({
          Parallelism: 1,
          Order: 'stop-first',
        });
      }
    });

    it.each([
      'traefik.http.routers.x',
      'com.docker.stack.namespace',
      'io.cloudgate.environment',
    ])('refuses a stored %s label, naming it', (label) => {
      expect(() => garage({ [label]: 'x' })).toThrow(
        `Labels.${JSON.stringify(label)}: refused`,
      );
    });
  });
});

describe('createBucketProgram', () => {
  it('makes the layout and the bucket only when the bucket is not there', () => {
    const program = createBucketProgram('bucket-abc123', 'uploads-a1b2c3d4');
    expect(program).toContain('docker exec "$CONTAINER_ID" /garage "$@"');
    expect(program).toContain(
      'if ! garage bucket info uploads-a1b2c3d4 >/dev/null 2>&1; then',
    );
    expect(program).toContain('garage layout apply --version 1');
    expect(program).toContain('garage bucket create uploads-a1b2c3d4');
  });
});

describe('createKeyProgram', () => {
  it('grants the new key read and write on its bucket and never owner', () => {
    const program = createKeyProgram(
      'bucket-abc123',
      'uploads-a1b2c3d4',
      'bucket-abc123',
    );
    expect(program).toContain('garage key create bucket-abc123');
    expect(program).toContain(
      'garage bucket allow --read --write uploads-a1b2c3d4 --key "$KEY_ID"',
    );
    expect(program).not.toContain('--owner');
  });
});

describe('readCreatedKey', () => {
  it('reads the key the key program printed', () => {
    expect(
      readCreatedKey('CLOUDGATE_KEY_ID=GK1234\nCLOUDGATE_SECRET_KEY=s3cr3t\n'),
    ).toEqual({ accessKeyId: 'GK1234', secretAccessKey: 's3cr3t' });
  });

  it('answers null when either half is missing', () => {
    expect(readCreatedKey('CLOUDGATE_KEY_ID=GK1234\n')).toBeNull();
    expect(readCreatedKey('')).toBeNull();
  });
});

describe('corsConfigurationXml', () => {
  it('gives each origin its own rule, so a preflight is answered with that origin alone', () => {
    const rule = (origin: string) =>
      `<CORSRule><AllowedOrigin>${origin}</AllowedOrigin>` +
      '<AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod>' +
      '<AllowedMethod>POST</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>' +
      '<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader></CORSRule>';
    expect(
      corsConfigurationXml([
        'https://app.example.com',
        'http://localhost:3000',
      ]),
    ).toBe(
      `<CORSConfiguration>${rule('https://app.example.com')}${rule('http://localhost:3000')}</CORSConfiguration>`,
    );
  });
});

describe('bucketCorsProgram', () => {
  const origins = ['https://app.example.com'];

  it('owns the bucket through a key made for this one request and deleted on the way out', () => {
    const program = bucketCorsProgram(
      'bucket-abc123',
      'uploads-a1b2c3d4',
      origins,
    );
    expect(program).toContain('docker exec "$CONTAINER_ID" /garage "$@"');
    expect(program).toContain('garage key create bucket-abc123-cors');
    expect(program).toContain(
      'garage bucket allow --owner uploads-a1b2c3d4 --key "$KEY_ID"',
    );
    expect(program).toContain(
      `trap 'garage key delete --yes "$KEY_ID" >/dev/null 2>&1 || true' EXIT`,
    );
  });

  it("puts the CORS from curl in Garage's task network, its secret on stdin", () => {
    const program = bucketCorsProgram(
      'bucket-abc123',
      'uploads-a1b2c3d4',
      origins,
    );
    const send = program.split('\n').at(-1) ?? '';
    expect(send).toMatch(
      /^printf 'user = "%s:%s"\\n' "\$KEY_ID" "\$SECRET" \| docker run --rm -i --network "container:\$CONTAINER_ID" curlimages\/curl\\:8\.11\.1 -K - /,
    );
    expect(send).toContain('-X PUT --data-binary');
    expect(send).toContain('http\\://127.0.0.1\\:3900/uploads-a1b2c3d4\\?cors');
    expect(send).toContain('https\\://app.example.com');
    expect(send.split('|')[1]).not.toContain('$SECRET');
  });

  it('deletes the CORS when no origin is trusted', () => {
    const send =
      bucketCorsProgram('bucket-abc123', 'uploads-a1b2c3d4', [])
        .split('\n')
        .at(-1) ?? '';
    expect(send).toContain(
      '-X DELETE http\\://127.0.0.1\\:3900/uploads-a1b2c3d4\\?cors',
    );
    expect(send).not.toContain('CORSConfiguration');
  });
});

describe('removeKeysProgram', () => {
  it('removes each key on its own and reports each one Garage no longer has', () => {
    const program = removeKeysProgram('bucket-abc123', ['GK111', 'GK222']);
    expect(program).toContain('docker exec "$CONTAINER_ID" /garage "$@"');
    expect(program).toContain(
      "if garage key delete --yes GK111 >/dev/null 2>&1 || ! garage key info GK111 >/dev/null 2>&1; then printf '%s%s\\n' CLOUDGATE_KEY_REMOVED\\= GK111; fi",
    );
    expect(program).toContain('garage key delete --yes GK222');
    expect(program).not.toContain('bucket deny');
  });

  it('reads back only the keys it reported removed', () => {
    expect(
      readRemovedKeys(
        'noise\nCLOUDGATE_KEY_REMOVED=GK111\nCLOUDGATE_KEY_REMOVED=\n',
      ),
    ).toEqual(['GK111']);
  });
});
