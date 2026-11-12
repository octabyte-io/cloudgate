import { generatedTypes, typesOf } from '../../scripts/provider-schemas';
import type { CloudKind } from '../../src/cloud-accounts/cloud-account.schema';
import type { PinnedProvider } from '../../src/cloud-accounts/tofu/tofu-environment';
import {
  AWS_ADDRESSES,
  AWS_CONTAINER_LOCKS,
  AWS_ENVIRONMENT_NETWORK,
  AWS_KIND_ENTRIES,
  AWS_LOCKED_EVERYWHERE,
  AWS_PER_INSTANCE,
  awsAddressKey,
} from '../../src/native/aws-locks';
import {
  AWS_CONTAINER_OPEN,
  AWS_OPEN_SETTINGS,
} from '../../src/native/aws-open-settings';
import {
  DOCKER_KEYS_CLOSED_ON_KIND,
  DOCKER_KIND_ENTRIES,
  NATIVE_DOCKER_KEY_LOCKS,
  NATIVE_DOCKER_KEYS,
  NEVER_DOCKER_KEYS,
} from '../../src/native/docker-native';
import {
  GCP_ADDRESSES,
  GCP_CONTAINER_ADDRESSES,
  GCP_CONTAINER_LOCKS,
  GCP_CONTAINER_PATH,
  GCP_JOB_CONTAINER,
  GCP_ENVIRONMENT_NETWORK,
  GCP_KIND_ENTRIES,
  GCP_LOCKED_EVERYWHERE,
  GCP_PER_INSTANCE,
} from '../../src/native/google-locks';
import { GCP_OPEN_SETTINGS } from '../../src/native/google-open-settings';
import {
  blockAt,
  committedContainerFields,
  committedProvider,
} from '../../src/native/provider-schema';
import type { SchemaBlock } from '../../src/native/provider-schema';
import { EXPRESSIBLE_KINDS } from '../../src/project-config/format/config-schema';
import { kindsOn } from '../../src/project-config/planner/plan-environment';
import type { ConfigKind } from '../../src/project-config/planner/plan.types';
import { nativeAwsCheck } from '../../src/native/aws-native';
import { nativeGcpCheck } from '../../src/native/gcp-native';
import {
  addressesOf,
  awsBuilt,
  awsNetworkBuilt,
  bodyOf,
  gcpBuilt,
  gcpNetworkBuilt,
} from '../native/built-definitions';
import type { BuiltShape } from '../native/built-definitions';

/**
 * **Every native key, kind, generated address and provider setting has a
 * lock entry** (ADR-0044 rules 10 and 11; spec stories 54 and 55;
 * `CODING_STANDARDS.md` §1.7, "One mistake at N sites").
 *
 * A cloud's lock list is a deny-list (ADR-0044 rule 8): every provider
 * argument not locked is open. So nothing in the checkers notices when a
 * provider release adds an argument, a builder starts writing a new
 * resource, or a Docker key is admitted: each would be **open by accident**,
 * the one way a native block could widen a Service's reach without anyone
 * deciding it. This census holds the lists to what the code makes, read
 * from the producers' own declarations, in both directions:
 *
 * 1. **Docker.** Each of `native.docker`'s keys has an entry saying what of
 *    it is locked (an empty entry with a reason counts), no key is both
 *    admitted and on the "never" list, and the per-kind closings name only
 *    real kinds and keys.
 * 2. **Kinds.** Every kind the config can describe has an entry per target,
 *    and every kind an address entry names is one.
 * 3. **Addresses.** Every address each kind's definition writes, built
 *    through the builder its plan calls in every shape that adds one
 *    (`test/native/built-definitions.ts`, the driver the address
 *    snapshot reads too), is an address entry, a per-Domain or per-variable
 *    one refused whole, or the Environment network's, refused
 *    whole; and every entry is built. Every resource type the builders'
 *    source names (`generatedTypes()`) must be built by some shape, so a
 *    branch the shapes miss reds here.
 * 4. **Settings.** Every argument of each nameable address's type, at every
 *    depth, read from the committed schema of the provider its definition
 *    names, is locked with a reason or listed open (`*-open-settings.ts`),
 *    and not both; a lock or an open entry for an argument the schema does
 *    not have fails. An argument kept inside an open list's items (`kept`)
 *    is locked; one locked only while a fact holds (`lockedWhile`)
 *    is open the rest of the time, so it is classed by its open
 *    entries, once, and is never also locked. Moving a provider pin regenerates the schema, so this
 *    is the step that fails until the new settings are classed. The ECS
 *    container's `ContainerDefinition` fields, from the pinned
 *    `@aws-sdk/client-ecs`, are held the same way.
 * 5. **`ignore_changes`.** Every setting in Cloudgate's own `ignore_changes`
 *    is locked (ADR-0044 rule 7), so a native value is never
 *    accepted and then silently not applied.
 * 6. **Data sources.** What a definition reads (an Existing database's
 *    lookup, the zones) is not what the Service makes: no entry names a
 *    data source, and the checker refuses every `data.<type>.<name>` a
 *    built shape reads, on every kind the cloud makes, so a lookup is never
 *    open by accident.
 *
 * Falsified when it landed, each defect restored and the tree put back
 * (recorded in its commit message).
 */

type Path = readonly string[];
const dotted = (path: Path) => path.join('.');

/**
 * Every argument and block of `block`, at every depth. `settable` leaves out
 * what the provider only computes, which no native block may write (the
 * checker refuses it as "set by the provider").
 */
function schemaPaths(
  block: SchemaBlock,
  settable: boolean,
  at: Path = [],
): string[][] {
  const out: string[][] = [];
  for (const [key, attribute] of Object.entries(block.attributes ?? {})) {
    if (
      settable &&
      attribute.computed &&
      !attribute.optional &&
      !attribute.required
    ) {
      continue;
    }
    out.push([...at, key]);
  }
  for (const [key, nested] of Object.entries(block.block_types ?? {})) {
    out.push([...at, key]);
    out.push(...schemaPaths(nested.block, settable, [...at, key]));
  }
  return out;
}

/** `template[0].labels["cloudgate-reload"]` as a path: `template.labels`. */
const ignoredPath = (expression: string): string[] =>
  expression
    .replace(/\[[^\]]*\]/g, '')
    .split('.')
    .filter((part) => part !== '');

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

/** One cloud's lock tables, as the census reads them. */
interface CloudTables {
  readonly cloud: CloudKind;
  readonly label: string;
  /** The provider whose committed schema an address is checked against. */
  readonly providerOf: (address: string) => PinnedProvider;
  /** The provider whose types are this cloud's (`typesOf`). */
  readonly typesProvider: PinnedProvider;
  /** A data source a built shape must read, so an empty census never passes; none where the cloud reads none. */
  readonly readsAnchor: RegExp | null;
  readonly addresses: Readonly<
    Record<
      string,
      {
        readonly type: string;
        readonly kinds: readonly ConfigKind[];
        readonly whole?: string;
        readonly locked?: Readonly<Record<string, string>>;
        readonly limited?: Readonly<Record<string, unknown>>;
        /** Inside an open list's items, keeping Cloudgate's value: locked. */
        readonly kept?: Readonly<Record<string, string>>;
        /** Open, but locked while a fact holds: classed open, by its open entry. */
        readonly lockedWhile?: Readonly<Record<string, unknown>>;
        readonly provider?: 'google';
      }
    >
  >;
  readonly everywhere: Readonly<Record<string, string>>;
  readonly perInstance: Readonly<Record<string, string>>;
  readonly network: Readonly<Record<string, string>>;
  readonly kinds: Readonly<Record<ConfigKind, string>>;
  readonly open: Readonly<Record<string, readonly string[]>>;
  /** The table key an address is listed under (a parameter group by its family). */
  readonly keyOf: (address: string) => string;
  /** The container locks laid at a path below an address, if it has one. */
  readonly containers: Readonly<
    Record<
      string,
      { readonly at: Path; readonly locks: Readonly<Record<string, string>> }
    >
  >;
  readonly built: Readonly<Partial<Record<ConfigKind, BuiltShape[]>>>;
  readonly networkBuilt: readonly BuiltShape[];
  /** The cloud's checker, as every plan runs it. */
  readonly check: (
    kind: ConfigKind,
    block: Record<string, Record<string, unknown>>,
  ) => readonly { readonly at: string }[];
}

/**
 * Every cloud's tables, keyed by `cloud_kind` (ADR-0043): a cloud added to
 * the enum is a type error here until its census is written.
 */
const TABLES: { readonly [cloud in CloudKind]: CloudTables } = {
  aws: {
    cloud: 'aws',
    label: 'AWS',
    providerOf: () => 'aws',
    typesProvider: 'aws',
    readsAnchor: /^data\.aws_availability_zones\./,
    addresses: AWS_ADDRESSES,
    everywhere: AWS_LOCKED_EVERYWHERE,
    perInstance: AWS_PER_INSTANCE,
    network: AWS_ENVIRONMENT_NETWORK,
    kinds: AWS_KIND_ENTRIES,
    open: AWS_OPEN_SETTINGS,
    keyOf: awsAddressKey,
    // The ECS container is a JSON string to the provider, held by its own
    // field list below.
    containers: {},
    built: awsBuilt(),
    networkBuilt: awsNetworkBuilt(),
    check: (kind, block) =>
      nativeAwsCheck('svc', kind, block, { linkedKinds: [] }).refusals,
  },
  gcp: {
    cloud: 'gcp',
    label: 'Google Cloud',
    providerOf: (address) => GCP_ADDRESSES[address].provider,
    typesProvider: 'google',
    readsAnchor: null,
    addresses: GCP_ADDRESSES,
    everywhere: GCP_LOCKED_EVERYWHERE,
    perInstance: GCP_PER_INSTANCE,
    network: GCP_ENVIRONMENT_NETWORK,
    kinds: GCP_KIND_ENTRIES,
    open: GCP_OPEN_SETTINGS,
    keyOf: (address) => address,
    containers: {
      ...Object.fromEntries(
        GCP_CONTAINER_ADDRESSES.map((address) => [
          address,
          { at: GCP_CONTAINER_PATH, locks: GCP_CONTAINER_LOCKS },
        ]),
      ),
      // A Cron service's job's, a level deeper.
      [GCP_JOB_CONTAINER.address]: {
        at: GCP_JOB_CONTAINER.at,
        locks: GCP_CONTAINER_LOCKS,
      },
    },
    built: gcpBuilt(),
    networkBuilt: gcpNetworkBuilt(),
    check: (kind, block) => nativeGcpCheck('svc', kind, block, {}).refusals,
  },
};
const CLOUDS: readonly CloudTables[] = Object.values(TABLES);

const providerOf = (tables: CloudTables, address: string) =>
  committedProvider(tables.providerOf(address));

const schemaOf = (tables: CloudTables, address: string): SchemaBlock => {
  const block = providerOf(tables, address).resource(
    tables.addresses[address].type,
  );
  if (!block) throw new Error(`no committed schema for ${address}`);
  return block;
};

/**
 * Where a path stands: locked (with what locks it), open, or unclassed.
 *
 * A `kept` path is locked: no native block writes it, Cloudgate's
 * value is laid into each item written. A `lockedWhile` setting is
 * open while its fact does not hold, so it and all it holds are classed by
 * their open entries, exactly once: a `lockedWhile` setting that is also
 * locked, or not listed open, is `both` or `unclassed` like any other.
 */
function classOf(
  tables: CloudTables,
  address: string,
  path: Path,
): 'locked' | 'open' | 'unclassed' | 'both' {
  const entry = tables.addresses[address];
  const text = dotted(path);
  const prefixes = path.map((_, index) => dotted(path.slice(0, index + 1)));
  const container = tables.containers[address];
  const locked =
    (path.length === 1 &&
      (Object.hasOwn(tables.everywhere, text) ||
        Object.hasOwn(entry.limited ?? {}, text))) ||
    prefixes.some(
      (prefix) =>
        Object.hasOwn(entry.locked ?? {}, prefix) ||
        Object.hasOwn(entry.kept ?? {}, prefix),
    ) ||
    (container !== undefined &&
      path.length > container.at.length &&
      container.at.every((part, index) => path[index] === part) &&
      Object.hasOwn(container.locks, path[container.at.length]));
  const open = (tables.open[address] ?? []).includes(text);
  const conditional =
    path.length === 1 && Object.hasOwn(entry.lockedWhile ?? {}, text);
  if (locked && (open || conditional)) return 'both';
  return locked ? 'locked' : open ? 'open' : 'unclassed';
}

/** The addresses an entry may name: those locked whole carry no settings. */
const settingAddresses = (tables: CloudTables) =>
  Object.entries(tables.addresses)
    .filter(([, entry]) => entry.whole === undefined)
    .map(([address]) => address);

describe('NATIVE_DOCKER_KEY_LOCKS', () => {
  it('has a lock entry, with a reason, for each of its keys, and none for a key it does not take', () => {
    expect(sorted(Object.keys(NATIVE_DOCKER_KEY_LOCKS))).toEqual(
      sorted(NATIVE_DOCKER_KEYS),
    );
    expect(
      Object.entries(NATIVE_DOCKER_KEY_LOCKS).filter(
        ([, reason]) => reason.trim() === '',
      ),
    ).toEqual([]);
  });

  it('never takes a key its "never" list refuses', () => {
    expect(
      NATIVE_DOCKER_KEYS.filter((key) => Object.hasOwn(NEVER_DOCKER_KEYS, key)),
    ).toEqual([]);
  });

  it('closes keys only on kinds the config describes, only keys it takes, each with a reason', () => {
    const stale = Object.entries(DOCKER_KEYS_CLOSED_ON_KIND).flatMap(
      ([kind, closed]) => [
        ...((EXPRESSIBLE_KINDS as readonly string[]).includes(kind)
          ? []
          : [`kind ${kind}`]),
        ...Object.entries(closed)
          .filter(
            ([key, reason]) =>
              !(NATIVE_DOCKER_KEYS as readonly string[]).includes(key) ||
              (reason ?? '').trim() === '',
          )
          .map(([key]) => `${kind}.${key}`),
      ],
    );
    expect(stale).toEqual([]);
  });
});

describe('EXPRESSIBLE_KINDS', () => {
  it.each([
    ['native.docker', DOCKER_KIND_ENTRIES],
    ['native.aws', AWS_KIND_ENTRIES],
    ['native.gcp', GCP_KIND_ENTRIES],
  ] as const)(
    '%s has an entry, with a reason, for every kind the config describes, and for no other',
    (_block, entries) => {
      expect(sorted(Object.keys(entries))).toEqual(sorted(EXPRESSIBLE_KINDS));
      expect(
        Object.entries(entries).filter(([, reason]) => reason.trim() === ''),
      ).toEqual([]);
    },
  );

  it.each(CLOUDS.map((tables) => [tables.label, tables] as const))(
    'every kind a %s address entry names is one the config describes',
    (_label, tables) => {
      const unknown = Object.entries(tables.addresses).flatMap(
        ([address, entry]) =>
          entry.kinds
            .filter(
              (kind) =>
                !(EXPRESSIBLE_KINDS as readonly string[]).includes(kind),
            )
            .map((kind) => `${address}: ${kind}`),
      );
      expect(unknown).toEqual([]);
    },
  );
});

describe.each(CLOUDS.map((tables) => [tables.label, tables] as const))(
  'generated addresses on %s',
  (_label, tables) => {
    const madeBy = (kind: ConfigKind) =>
      sorted(
        (tables.built[kind] ?? []).flatMap((shape) =>
          addressesOf(shape.definition).map(tables.keyOf),
        ),
      );
    const everyBuilt = sorted([
      ...Object.values(tables.built).flatMap((shapes) =>
        (shapes ?? []).flatMap((shape) => addressesOf(shape.definition)),
      ),
      ...tables.networkBuilt.flatMap((shape) => addressesOf(shape.definition)),
    ]);
    const onCloud = [...kindsOn(tables.cloud)];

    it('builds every kind the cloud makes, and only those', () => {
      expect(sorted(Object.keys(tables.built))).toEqual(sorted(onCloud));
    });

    it.each(onCloud)(
      'a %s’s every address is an entry for it or one refused whole, and every entry for it is built',
      (kind) => {
        const built = madeBy(kind).filter(
          (address) => !Object.hasOwn(tables.perInstance, address),
        );
        const entries = sorted(
          Object.entries(tables.addresses)
            .filter(([, entry]) => entry.kinds.includes(kind))
            .map(([address]) => address),
        );
        expect({ kind, addresses: built }).toEqual({
          kind,
          addresses: entries,
        });
      },
    );

    it('lists an address for a kind it does not make yet only where another kind builds it', () => {
      const ahead = Object.entries(tables.addresses).flatMap(
        ([address, entry]) =>
          entry.kinds
            .filter((kind) => !onCloud.includes(kind))
            .filter(
              () => !everyBuilt.some((made) => tables.keyOf(made) === address),
            )
            .map((kind) => `${address} (${kind})`),
      );
      expect(ahead).toEqual([]);
    });

    it('builds every address it refuses as made per Domain or per variable', () => {
      expect(
        Object.keys(tables.perInstance).filter(
          (address) => !everyBuilt.includes(address),
        ),
      ).toEqual([]);
      expect(
        Object.keys(tables.perInstance).filter((address) =>
          Object.hasOwn(tables.addresses, address),
        ),
      ).toEqual([]);
    });

    it('holds every address of the Environment network, refused whole, and no other', () => {
      const network = sorted(
        tables.networkBuilt
          .flatMap((shape) => addressesOf(shape.definition))
          .filter((address) => !Object.hasOwn(tables.perInstance, address)),
      );
      expect(sorted(Object.keys(tables.network))).toEqual(network);
      expect(
        Object.entries(tables.network).filter(
          ([address, reason]) =>
            reason.trim() === '' || Object.hasOwn(tables.addresses, address),
        ),
      ).toEqual([]);
    });

    it('builds every resource type the builders’ source names, so no branch is left unbuilt', () => {
      const provider = tables.typesProvider;
      const builtTypes = new Set(
        everyBuilt.map((address) => address.split('.')[0]),
      );
      expect(
        typesOf(provider, generatedTypes()).resources.filter(
          (type) => !builtTypes.has(type),
        ),
      ).toEqual([]);
    });

    it('names no data source, and the checker refuses each one a built shape reads, on every kind', () => {
      expect(
        Object.keys(tables.addresses).filter((address) =>
          address.startsWith('data.'),
        ),
      ).toEqual([]);
      const read = sorted(
        [
          ...Object.values(tables.built).flatMap((shapes) => shapes ?? []),
          ...tables.networkBuilt,
        ].flatMap((shape) =>
          Object.entries(
            (shape.definition.data ?? {}) as Record<string, object>,
          ).flatMap(([type, byName]) =>
            Object.keys(byName).map((local) => `data.${type}.${local}`),
          ),
        ),
      );
      const open = read.flatMap((address) =>
        onCloud
          .filter(
            (kind) =>
              !tables
                .check(kind, { [address]: {} })
                .some((refusal) =>
                  refusal.at.endsWith(JSON.stringify(address)),
                ),
          )
          .map((kind) => `${kind}: ${address}`),
      );
      expect({ open }).toEqual({ open: [] });
      // An anchor, so a census of no lookups can never pass as a clean one.
      if (tables.readsAnchor) {
        expect(read).toEqual(
          expect.arrayContaining([expect.stringMatching(tables.readsAnchor)]),
        );
      }
    });

    it('names each entry’s type as its address does', () => {
      expect(
        Object.entries(tables.addresses)
          .filter(([address, entry]) => address.split('.')[0] !== entry.type)
          .map(([address]) => address),
      ).toEqual([]);
    });
  },
);

describe.each(CLOUDS.map((tables) => [tables.label, tables] as const))(
  'provider settings on %s',
  (_label, tables) => {
    it.each(settingAddresses(tables))(
      'every setting of %s is locked with a reason or open, and not both',
      (address) => {
        const paths = schemaPaths(schemaOf(tables, address), true);
        const unclassed: string[] = [];
        const both: string[] = [];
        for (const path of paths) {
          const found = classOf(tables, address, path);
          if (found === 'unclassed') unclassed.push(dotted(path));
          if (found === 'both') both.push(dotted(path));
        }
        expect({ address, unclassed, both }).toEqual({
          address,
          unclassed: [],
          both: [],
        });
      },
    );

    it.each(settingAddresses(tables))(
      '%s locks and opens only settings its committed schema has',
      (address) => {
        const block = schemaOf(tables, address);
        const all = new Set(schemaPaths(block, false).map(dotted));
        const settable = new Set(schemaPaths(block, true).map(dotted));
        const entry = tables.addresses[address];
        expect({
          address,
          locked: Object.keys(entry.locked ?? {}).filter(
            (path) => !all.has(path),
          ),
          limited: Object.keys(entry.limited ?? {}).filter(
            (path) => !settable.has(path),
          ),
          kept: Object.keys(entry.kept ?? {}).filter(
            (path) => !settable.has(path),
          ),
          lockedWhile: Object.keys(entry.lockedWhile ?? {}).filter(
            (path) => !settable.has(path),
          ),
          open: (tables.open[address] ?? []).filter(
            (path) => !settable.has(path),
          ),
        }).toEqual({
          address,
          locked: [],
          limited: [],
          kept: [],
          lockedWhile: [],
          open: [],
        });
      },
    );

    it('locks in the one container only settings some container has', () => {
      const containers = Object.entries(tables.containers);
      const stale = [
        ...new Set(containers.flatMap(([, { locks }]) => Object.keys(locks))),
      ].filter(
        (key) =>
          !containers.some(([address, { at }]) => {
            const block = blockAt(
              providerOf(tables, address),
              tables.addresses[address].type,
              at,
            );
            return (
              Object.hasOwn(block?.attributes ?? {}, key) ||
              Object.hasOwn(block?.block_types ?? {}, key)
            );
          }),
      );
      expect(stale).toEqual([]);
    });

    it('opens settings only of addresses that may be named', () => {
      expect(
        Object.keys(tables.open).filter(
          (address) => !settingAddresses(tables).includes(address),
        ),
      ).toEqual([]);
    });

    it('locks on every address only settings some address has', () => {
      const unused = Object.keys(tables.everywhere).filter(
        (key) =>
          !Object.keys(tables.addresses).some((address) =>
            schemaPaths(schemaOf(tables, address), false).some(
              (path) => path.length === 1 && path[0] === key,
            ),
          ),
      );
      expect(unused).toEqual([]);
    });

    it('locks every setting in Cloudgate’s own ignore_changes', () => {
      const unlocked: string[] = [];
      const shapes = [
        ...Object.values(tables.built).flatMap((one) => one ?? []),
        ...tables.networkBuilt,
      ];
      for (const shape of shapes) {
        for (const address of addressesOf(shape.definition)) {
          const lifecycle = bodyOf(shape.definition, address).lifecycle as
            { ignore_changes?: readonly string[] } | undefined;
          for (const expression of lifecycle?.ignore_changes ?? []) {
            const key = tables.keyOf(address);
            if (
              Object.hasOwn(tables.perInstance, key) ||
              Object.hasOwn(tables.network, key) ||
              tables.addresses[key]?.whole !== undefined
            ) {
              continue;
            }
            if (
              !Object.hasOwn(tables.addresses, key) ||
              classOf(tables, key, ignoredPath(expression)) !== 'locked'
            ) {
              unlocked.push(`${address}: ${expression}`);
            }
          }
        }
      }
      expect(sorted(unlocked)).toEqual([]);
    });
  },
);

describe('AWS_CONTAINER_OPEN', () => {
  it('classes every ContainerDefinition field of the pinned @aws-sdk/client-ecs locked with a reason or open, and not both', () => {
    const fields = committedContainerFields().fields;
    expect({
      unclassed: [...fields].filter(
        (field) =>
          !Object.hasOwn(AWS_CONTAINER_LOCKS, field) &&
          !AWS_CONTAINER_OPEN.includes(field),
      ),
      both: AWS_CONTAINER_OPEN.filter((field) =>
        Object.hasOwn(AWS_CONTAINER_LOCKS, field),
      ),
      stale: [
        ...Object.keys(AWS_CONTAINER_LOCKS),
        ...AWS_CONTAINER_OPEN,
      ].filter((field) => !fields.has(field)),
    }).toEqual({ unclassed: [], both: [], stale: [] });
  });
});
