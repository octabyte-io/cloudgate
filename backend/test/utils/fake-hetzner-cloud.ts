import type {
  CreateServerRequest,
  CreateVolumeRequest,
  CreatedBackup,
  CreatedServer,
  CreatedVolume,
  HetznerAction,
  HetznerAnswer,
  HetznerBackup,
  HetznerCloudPort,
  HetznerImage,
  HetznerLocation,
  HetznerPricing,
  HetznerServer,
  HetznerServerType,
  HetznerVolume,
} from '../../src/bought-servers/hetzner/hetzner-cloud.port';
import {
  HETZNER_NOT_FOUND,
  HETZNER_RESOURCE_UNAVAILABLE,
} from '../../src/bought-servers/hetzner/hetzner-cloud.port';

/** Every method of the port, as a fake call and a refusal name it. */
export type HetznerMethod = keyof HetznerCloudPort;

/** One call the fake answered, with what it was asked. */
export interface FakeHetznerCall {
  method: HetznerMethod;
  args: unknown[];
}

/** A Primary IP the fake holds: billed until deleted, as the provider's are. */
export interface FakePrimaryIp {
  id: number;
  type: 'ipv4' | 'ipv6';
  ip: string;
  /** The machine it is assigned to, or null once that machine is gone. */
  serverId: number | null;
  labels: Record<string, string>;
  /** Reverse DNS set on it, if any. */
  dnsPtr: string | null;
}

/** A machine the fake holds, with the public key it was made with. */
export interface FakeMachine extends HetznerServer {
  sshPublicKey: string;
  image: string;
  /** The backup its disk was last rebuilt from, if it was. */
  rebuiltFrom: number | null;
}

/** A backup a spec puts on a machine: what the provider would have made by itself. */
export interface FakeBackupSeed {
  created: string;
  /** GB, as the provider writes it; null while it is still being made. */
  imageSizeGb: number | null;
  status?: HetznerBackup['status'];
  description?: string;
}

/** The catalogue a fake account answers with, before a spec changes it. */
export interface FakeCatalogue {
  currency: 'USD' | 'EUR';
  locations: HetznerLocation[];
  serverTypes: HetznerServerType[];
  pricing: HetznerPricing;
  images: HetznerImage[];
}

/**
 * Locations as `GET /locations` answers them (Hetzner Cloud API,
 * https://docs.hetzner.cloud/cloud.spec.json).
 */
const LOCATIONS: HetznerLocation[] = [
  location(1, 'fsn1', 'DE', 'Falkenstein', 50.47612, 12.370071, 'eu-central'),
  location(2, 'nbg1', 'DE', 'Nuremberg', 49.452102, 11.076665, 'eu-central'),
  location(3, 'hel1', 'FI', 'Helsinki', 60.169855, 24.938379, 'eu-central'),
  location(4, 'ash', 'US', 'Ashburn, VA', 39.045821, -77.487073, 'us-east'),
  location(5, 'hil', 'US', 'Hillsboro, OR', 45.54222, -122.951924, 'us-west'),
  location(6, 'sin', 'SG', 'Singapore', 1.283333, 103.833333, 'ap-southeast'),
];

/**
 * One size: its shape, and its monthly list price in each Location as
 * `[USD, EUR]`, from the provider's own price feed on 2026-11-10, where it
 * has the row.
 * `unavailable` names the Locations it is sold in but sold out of.
 */
interface SeedType {
  id: number;
  name: string;
  cores: number;
  memoryGb: number;
  diskGb: number;
  cpuType: 'shared' | 'dedicated';
  architecture: 'x86' | 'arm';
  prices: Record<string, [string, string]>;
  unavailable?: string[];
}

const SEED_TYPES: SeedType[] = [
  {
    id: 101,
    name: 'cx23',
    cores: 2,
    memoryGb: 4,
    diskGb: 40,
    cpuType: 'shared',
    architecture: 'x86',
    prices: {
      fsn1: ['6.4900', '5.4900'],
      nbg1: ['6.4900', '5.4900'],
      hel1: ['6.4900', '5.4900'],
    },
    unavailable: ['fsn1'],
  },
  {
    id: 102,
    name: 'cax11',
    cores: 2,
    memoryGb: 4,
    diskGb: 40,
    cpuType: 'shared',
    architecture: 'arm',
    prices: {
      fsn1: ['6.9900', '5.9900'],
      nbg1: ['6.9900', '5.9900'],
      hel1: ['6.9900', '5.9900'],
    },
  },
  {
    id: 103,
    name: 'cpx22',
    cores: 3,
    memoryGb: 4,
    diskGb: 80,
    cpuType: 'shared',
    architecture: 'x86',
    prices: {
      fsn1: ['22.9900', '19.4900'],
      nbg1: ['22.9900', '19.4900'],
      hel1: ['19.4900', '16.4900'],
      ash: ['19.4900', '16.4900'],
      hil: ['19.4900', '16.4900'],
      sin: ['30.9900', '26.4900'],
    },
  },
  {
    id: 104,
    name: 'ccx13',
    cores: 2,
    memoryGb: 8,
    diskGb: 80,
    cpuType: 'dedicated',
    architecture: 'x86',
    prices: {
      fsn1: ['50.4900', '42.9900'],
      nbg1: ['50.4900', '42.9900'],
      ash: ['50.9900', '43.4900'],
      hil: ['50.9900', '43.4900'],
      sin: ['63.4900', '53.9900'],
    },
    unavailable: ['sin'],
  },
  {
    id: 105,
    name: 'ccx23',
    cores: 4,
    memoryGb: 16,
    diskGb: 160,
    cpuType: 'dedicated',
    architecture: 'x86',
    prices: {
      fsn1: ['100.4900', '85.4900'],
      nbg1: ['100.4900', '85.4900'],
      ash: ['101.4900', '86.4900'],
    },
  },
];

function location(
  id: number,
  name: string,
  country: string,
  city: string,
  latitude: number,
  longitude: number,
  networkZone: string,
): HetznerLocation {
  return {
    id,
    name,
    description: `${city} DC`,
    country,
    city,
    latitude,
    longitude,
    networkZone,
  };
}

/**
 * System images as `GET /images?type=system&status=available` lists them:
 * each name once per architecture it is built for, and other systems beside
 * Ubuntu and Debian, which the catalogue must leave out. Debian 11 is built
 * for x86 only here, so a spec can pick an image an Arm size cannot use.
 */
const BOTH = ['x86', 'arm'] as const;
const IMAGES: Array<
  [string, string, string, string, ReadonlyArray<'x86' | 'arm'>]
> = [
  ['ubuntu-22.04', 'ubuntu', '22.04', 'Ubuntu 22.04', BOTH],
  ['ubuntu-24.04', 'ubuntu', '24.04', 'Ubuntu 24.04', BOTH],
  ['debian-11', 'debian', '11', 'Debian 11', ['x86']],
  ['debian-12', 'debian', '12', 'Debian 12', BOTH],
  ['debian-13', 'debian', '13', 'Debian 13', BOTH],
  ['rocky-9', 'rocky', '9', 'Rocky Linux 9', BOTH],
];

/** The seeded catalogue of an account in `currency`. */
export function seededCatalogue(currency: 'USD' | 'EUR'): FakeCatalogue {
  const column = currency === 'USD' ? 0 : 1;
  return {
    currency,
    locations: LOCATIONS.map((entry) => ({ ...entry })),
    serverTypes: SEED_TYPES.map((seed) => ({
      id: seed.id,
      name: seed.name,
      cores: seed.cores,
      memoryGb: seed.memoryGb,
      diskGb: seed.diskGb,
      storageType: 'local',
      cpuType: seed.cpuType,
      architecture: seed.architecture,
      locations: Object.keys(seed.prices).map((name) => ({
        name,
        available: !(seed.unavailable ?? []).includes(name),
        unavailableAfter: null,
      })),
      prices: Object.entries(seed.prices).map(([name, prices]) => ({
        location: name,
        monthlyNet: prices[column],
      })),
    })),
    pricing: {
      currency,
      primaryIps: LOCATIONS.flatMap((entry) => [
        {
          type: 'ipv4' as const,
          location: entry.name,
          monthlyNet: currency === 'USD' ? '0.6000' : '0.5000',
        },
        { type: 'ipv6' as const, location: entry.name, monthlyNet: '0.0000' },
      ]),
      volumePerGbMonthNet: currency === 'USD' ? '0.0767' : '0.0572',
      serverBackupPercentage: '20.0000',
    },
    images: IMAGES.flatMap(
      ([name, osFlavor, osVersion, description, architectures]) =>
        architectures.map((architecture) => ({
          name,
          osFlavor,
          osVersion,
          description,
          architecture,
        })),
    ),
  };
}

/**
 * The Hetzner Cloud port, in memory: one account, holding machines,
 * Volumes, Primary IPs and their labels, answering with a catalogue a spec
 * can change, and refusing what a spec tells it to. Every e2e gets two
 * (`ctx.hetzner.machines`, the EUR account, and `ctx.hetzner.prices`, the
 * USD one), and `resetDb` resets both.
 *
 * It keeps the provider's rules a caller could otherwise get wrong and still
 * pass: a size changes only on a machine that is off, a deleted machine
 * leaves its Volumes and Primary IPs behind (detached, still there), and a
 * Volume or Primary IP is deleted only once nothing holds it. A machine's
 * backups go with it, and with its backups turned off; it keeps 7, the
 * oldest dropped when another is made. A rebuild is only from a whole
 * backup of the same machine, and changes nothing but its disk. Every action
 * it starts has already succeeded, but for a backup asked for, which is
 * being made until a spec calls {@link finishBackup}.
 */
export class FakeHetznerCloud implements HetznerCloudPort {
  /** Every call, in order, with its arguments. */
  readonly calls: FakeHetznerCall[] = [];
  catalogue: FakeCatalogue;

  private readonly machines = new Map<number, FakeMachine>();
  private readonly volumeRows = new Map<number, HetznerVolume>();
  private readonly ips = new Map<number, FakePrimaryIp>();
  /** Backup images, each bound to the machine it is of. */
  private readonly backupRows = new Map<
    number,
    HetznerBackup & { boundTo: number; actionId?: number }
  >();
  private readonly actions = new Map<number, HetznerAction>();
  private readonly refusals = new Map<
    HetznerMethod,
    Array<{ code: string; message: string }>
  >();
  private nextId = 1000;

  constructor(private readonly currency: 'USD' | 'EUR') {
    this.catalogue = seededCatalogue(currency);
  }

  /** Back to an empty account with the seeded catalogue, no calls and no refusals. */
  reset(): void {
    this.calls.length = 0;
    this.catalogue = seededCatalogue(this.currency);
    this.machines.clear();
    this.volumeRows.clear();
    this.ips.clear();
    this.backupRows.clear();
    this.actions.clear();
    this.refusals.clear();
    this.nextId = 1000;
  }

  /**
   * The next `times` calls to `method` are refused with `code`, in the
   * provider's words. A create that is sold out is
   * `refuse('createServer', 'resource_unavailable')`.
   */
  refuse(
    method: HetznerMethod,
    code: string = HETZNER_RESOURCE_UNAVAILABLE,
    times = 1,
    message = `refused by the fake: ${code}`,
  ): void {
    const queue = this.refusals.get(method) ?? [];
    for (let i = 0; i < times; i++) queue.push({ code, message });
    this.refusals.set(method, queue);
  }

  /** Marks a size sold out (or back in stock) in one Location. */
  setAvailable(serverType: string, location: string, available: boolean): void {
    const type = this.catalogue.serverTypes.find((t) => t.name === serverType);
    const listed = type?.locations.find((l) => l.name === location);
    if (!listed) throw new Error(`${serverType} is not listed in ${location}`);
    listed.available = available;
  }

  /** Every call to `method`, with its arguments. */
  callsTo(method: HetznerMethod): unknown[][] {
    return this.calls
      .filter((call) => call.method === method)
      .map((call) => call.args);
  }

  /** The machines the account holds now. */
  servers(): FakeMachine[] {
    return [...this.machines.values()].map((machine) => ({ ...machine }));
  }

  /** The Volumes the account holds now, attached or not. */
  volumes(): HetznerVolume[] {
    return [...this.volumeRows.values()].map((volume) => ({ ...volume }));
  }

  /**
   * Puts a backup on a machine, as the provider's daily run would: the
   * provider makes them by itself, so a spec seeds them rather than asks.
   */
  addBackup(serverId: number, seed: FakeBackupSeed): HetznerBackup {
    if (!this.machines.has(serverId)) {
      throw new Error(`no machine ${serverId} to back up`);
    }
    const machine = this.machines.get(serverId)!;
    const backup = {
      id: this.id(),
      description: seed.description ?? '',
      status: seed.status ?? 'available',
      created: seed.created,
      imageSizeGb: seed.imageSizeGb,
      diskSizeGb: this.diskOf(machine),
      boundTo: serverId,
    };
    this.keepBackupSlot(serverId);
    this.backupRows.set(backup.id, backup);
    const { boundTo: _boundTo, ...view } = backup;
    void _boundTo;
    return view;
  }

  /** The provider has made a backup it was asked for: it is whole, at this size. */
  finishBackup(backupId: number, imageSizeGb: number): void {
    const backup = this.backupRows.get(backupId);
    if (!backup) throw new Error(`no backup ${backupId} to finish`);
    backup.status = 'available';
    backup.imageSizeGb = imageSizeGb;
    const action =
      backup.actionId !== undefined ? this.actions.get(backup.actionId) : null;
    if (action) action.status = 'success';
  }

  /** The Primary IPs the account holds now, assigned or not. */
  primaryIps(): FakePrimaryIp[] {
    return [...this.ips.values()].map((ip) => ({ ...ip }));
  }

  listServerTypes(): Promise<HetznerAnswer<HetznerServerType[]>> {
    return this.answer('listServerTypes', [], () =>
      structuredClone(this.catalogue.serverTypes),
    );
  }

  listLocations(): Promise<HetznerAnswer<HetznerLocation[]>> {
    return this.answer('listLocations', [], () =>
      structuredClone(this.catalogue.locations),
    );
  }

  getPricing(): Promise<HetznerAnswer<HetznerPricing>> {
    return this.answer('getPricing', [], () =>
      structuredClone(this.catalogue.pricing),
    );
  }

  listImages(): Promise<HetznerAnswer<HetznerImage[]>> {
    return this.answer('listImages', [], () =>
      structuredClone(this.catalogue.images),
    );
  }

  createServer(
    request: CreateServerRequest,
  ): Promise<HetznerAnswer<CreatedServer>> {
    return this.answer('createServer', [request], () => {
      const type = this.catalogue.serverTypes.find(
        (t) => t.name === request.serverType,
      );
      const listed = type?.locations.find((l) => l.name === request.location);
      if (!type || !listed) {
        return refusal('invalid_input', 'server type not in location');
      }
      if (!listed.available) {
        return refusal(HETZNER_RESOURCE_UNAVAILABLE, 'not available for order');
      }
      // An image is built for one architecture, as the provider's are.
      const image = this.catalogue.images.find(
        (i) => i.name === request.image && i.architecture === type.architecture,
      );
      if (!image) {
        return refusal('invalid_input', 'image not found for architecture');
      }
      if ([...this.machines.values()].some((m) => m.name === request.name)) {
        return refusal('uniqueness_error', 'server name is already used');
      }
      const id = this.id();
      const ipv4 = this.primaryIp('ipv4', id, request.labels);
      const ipv6 = this.primaryIp('ipv6', id, request.labels);
      const machine: FakeMachine = {
        id,
        name: request.name,
        status: 'running',
        serverType: request.serverType,
        location: request.location,
        ipv4: ipv4.ip,
        primaryIpv4Id: ipv4.id,
        ipv6: ipv6.ip,
        primaryIpv6Id: ipv6.id,
        backups: false,
        volumeIds: [],
        labels: { ...request.labels },
        created: new Date().toISOString(),
        sshPublicKey: request.sshPublicKey,
        image: request.image,
        rebuiltFrom: null,
      };
      this.machines.set(id, machine);
      return {
        server: this.view(machine),
        action: this.action('create_server'),
      };
    });
  }

  getServer(serverId: number): Promise<HetznerAnswer<HetznerServer>> {
    return this.answer('getServer', [serverId], () =>
      this.withMachine(serverId, (machine) => this.view(machine)),
    );
  }

  listServers(
    labels: Record<string, string>,
  ): Promise<HetznerAnswer<HetznerServer[]>> {
    return this.answer('listServers', [labels], () =>
      [...this.machines.values()]
        .filter((machine) =>
          Object.entries(labels).every(
            ([key, value]) => machine.labels[key] === value,
          ),
        )
        .map((machine) => this.view(machine)),
    );
  }

  changeServerType(
    serverId: number,
    serverType: string,
  ): Promise<HetznerAnswer<HetznerAction>> {
    return this.answer('changeServerType', [serverId, serverType], () =>
      this.withMachine(serverId, (machine) => {
        if (machine.status !== 'off') {
          return refusal('server_not_stopped', 'server must be powered off');
        }
        machine.serverType = serverType;
        return this.action('change_server_type');
      }),
    );
  }

  powerOn(serverId: number): Promise<HetznerAnswer<HetznerAction>> {
    return this.answer('powerOn', [serverId], () =>
      this.withMachine(serverId, (machine) => {
        machine.status = 'running';
        return this.action('start_server');
      }),
    );
  }

  powerOff(serverId: number): Promise<HetznerAnswer<HetznerAction>> {
    return this.answer('powerOff', [serverId], () =>
      this.withMachine(serverId, (machine) => {
        machine.status = 'off';
        return this.action('stop_server');
      }),
    );
  }

  enableBackup(serverId: number): Promise<HetznerAnswer<HetznerAction>> {
    return this.answer('enableBackup', [serverId], () =>
      this.withMachine(serverId, (machine) => {
        machine.backups = true;
        return this.action('enable_backup');
      }),
    );
  }

  disableBackup(serverId: number): Promise<HetznerAnswer<HetznerAction>> {
    return this.answer('disableBackup', [serverId], () =>
      this.withMachine(serverId, (machine) => {
        machine.backups = false;
        this.dropBackups(machine.id);
        return this.action('disable_backup');
      }),
    );
  }

  /** In the order they were made, as the provider lists images: a caller sorts. */
  listBackups(serverId: number): Promise<HetznerAnswer<HetznerBackup[]>> {
    return this.answer('listBackups', [serverId], () =>
      [...this.backupRows.values()]
        .filter((backup) => backup.boundTo === serverId)
        .map(({ boundTo: _boundTo, actionId: _actionId, ...backup }) => {
          void _boundTo;
          void _actionId;
          return backup;
        }),
    );
  }

  /**
   * Being made until {@link finishBackup}, and only while the machine's
   * backups are on, as the provider's slots are.
   */
  createBackup(
    serverId: number,
    description: string,
  ): Promise<HetznerAnswer<CreatedBackup>> {
    return this.answer('createBackup', [serverId, description], () =>
      this.withMachine(serverId, (machine) => {
        if (!machine.backups) {
          return refusal('invalid_input', 'backups are not enabled');
        }
        const action = this.action('create_image');
        this.actions.get(action.id)!.status = 'running';
        const backup = {
          id: this.id(),
          description,
          status: 'creating' as const,
          created: new Date().toISOString(),
          imageSizeGb: null,
          diskSizeGb: this.diskOf(machine),
        };
        this.keepBackupSlot(serverId);
        this.backupRows.set(backup.id, {
          ...backup,
          boundTo: serverId,
          actionId: action.id,
        });
        return { backup, action: { ...action, status: 'running' as const } };
      }),
    );
  }

  /**
   * Only from a backup of this machine that is whole, as the provider's
   * images are bound. The machine keeps its id, addresses, labels, Volumes
   * and power state: only its disk is the backup's.
   */
  rebuild(
    serverId: number,
    imageId: number,
  ): Promise<HetznerAnswer<HetznerAction>> {
    return this.answer('rebuild', [serverId, imageId], () =>
      this.withMachine(serverId, (machine) => {
        const backup = this.backupRows.get(imageId);
        if (!backup || backup.boundTo !== machine.id) {
          return refusal(HETZNER_NOT_FOUND, 'image not found');
        }
        if (backup.status !== 'available') {
          return refusal('image_not_available', 'image is not available');
        }
        machine.rebuiltFrom = imageId;
        return this.action('rebuild_server');
      }),
    );
  }

  setReverseDns(
    serverId: number,
    ip: string,
    dnsPtr: string,
  ): Promise<HetznerAnswer<HetznerAction>> {
    return this.answer('setReverseDns', [serverId, ip, dnsPtr], () =>
      this.withMachine(serverId, (machine) => {
        const primary = [...this.ips.values()].find(
          (entry) => entry.serverId === machine.id && entry.ip === ip,
        );
        if (!primary) return refusal('invalid_input', 'ip is not the server’s');
        primary.dnsPtr = dnsPtr;
        return this.action('change_dns_ptr');
      }),
    );
  }

  deleteServer(serverId: number): Promise<HetznerAnswer<HetznerAction>> {
    return this.answer('deleteServer', [serverId], () =>
      this.withMachine(serverId, (machine) => {
        // Volumes and Primary IPs are detached, not deleted, as the provider does.
        for (const volume of this.volumeRows.values()) {
          if (volume.serverId === machine.id) volume.serverId = null;
        }
        for (const ip of this.ips.values()) {
          if (ip.serverId === machine.id) ip.serverId = null;
        }
        this.dropBackups(machine.id);
        this.machines.delete(machine.id);
        return this.action('delete_server');
      }),
    );
  }

  createVolume(
    request: CreateVolumeRequest,
  ): Promise<HetznerAnswer<CreatedVolume>> {
    return this.answer('createVolume', [request], () => {
      if (request.sizeGb < 10 || request.sizeGb > 10240) {
        return refusal('invalid_input', 'size must be 10 to 10240 GB');
      }
      const id = this.id();
      const volume: HetznerVolume = {
        id,
        name: request.name,
        sizeGb: request.sizeGb,
        location: request.location,
        serverId: null,
        linuxDevice: `/dev/disk/by-id/scsi-0HC_Volume_${id}`,
        labels: { ...request.labels },
      };
      this.volumeRows.set(id, volume);
      return { volume: { ...volume }, action: this.action('create_volume') };
    });
  }

  getVolume(volumeId: number): Promise<HetznerAnswer<HetznerVolume>> {
    return this.answer('getVolume', [volumeId], () => {
      const volume = this.volumeRows.get(volumeId);
      return volume
        ? { ...volume }
        : refusal(HETZNER_NOT_FOUND, 'volume not found');
    });
  }

  listVolumes(
    labels: Record<string, string>,
  ): Promise<HetznerAnswer<HetznerVolume[]>> {
    return this.answer('listVolumes', [labels], () =>
      [...this.volumeRows.values()]
        .filter((volume) =>
          Object.entries(labels).every(
            ([key, value]) => volume.labels[key] === value,
          ),
        )
        .map((volume) => ({ ...volume, labels: { ...volume.labels } })),
    );
  }

  attachVolume(
    volumeId: number,
    serverId: number,
  ): Promise<HetznerAnswer<HetznerAction>> {
    return this.answer('attachVolume', [volumeId, serverId], () => {
      const volume = this.volumeRows.get(volumeId);
      if (!volume) return refusal(HETZNER_NOT_FOUND, 'volume not found');
      return this.withMachine(serverId, (machine) => {
        if (machine.location !== volume.location) {
          return refusal('invalid_input', 'volume is in another location');
        }
        volume.serverId = machine.id;
        return this.action('attach_volume');
      });
    });
  }

  resizeVolume(
    volumeId: number,
    sizeGb: number,
  ): Promise<HetznerAnswer<HetznerAction>> {
    return this.answer('resizeVolume', [volumeId, sizeGb], () => {
      const volume = this.volumeRows.get(volumeId);
      if (!volume) return refusal(HETZNER_NOT_FOUND, 'volume not found');
      if (sizeGb <= volume.sizeGb || sizeGb > 10240) {
        return refusal('invalid_input', 'size must be greater than current');
      }
      volume.sizeGb = sizeGb;
      return this.action('resize_volume');
    });
  }

  deleteVolume(volumeId: number): Promise<HetznerAnswer<void>> {
    return this.answer('deleteVolume', [volumeId], () => {
      const volume = this.volumeRows.get(volumeId);
      if (!volume) return refusal(HETZNER_NOT_FOUND, 'volume not found');
      if (volume.serverId !== null) {
        return refusal('locked', 'volume is attached to a server');
      }
      this.volumeRows.delete(volumeId);
      return undefined;
    });
  }

  deletePrimaryIp(primaryIpId: number): Promise<HetznerAnswer<void>> {
    return this.answer('deletePrimaryIp', [primaryIpId], () => {
      const ip = this.ips.get(primaryIpId);
      if (!ip) return refusal(HETZNER_NOT_FOUND, 'primary ip not found');
      if (ip.serverId !== null) {
        return refusal('primary_ip_assigned', 'primary ip is assigned');
      }
      this.ips.delete(primaryIpId);
      return undefined;
    });
  }

  getAction(actionId: number): Promise<HetznerAnswer<HetznerAction>> {
    return this.answer('getAction', [actionId], () => {
      const action = this.actions.get(actionId);
      return action
        ? { ...action }
        : refusal(HETZNER_NOT_FOUND, 'action not found');
    });
  }

  /**
   * Records the call, answers a refusal queued for it if there is one, and
   * otherwise runs it: a {@link Refusal} it returns is the provider's no.
   */
  private answer<T>(
    method: HetznerMethod,
    args: unknown[],
    run: () => T | Refusal,
  ): Promise<HetznerAnswer<T>> {
    this.calls.push({ method, args: structuredClone(args) });
    const queued = this.refusals.get(method)?.shift();
    if (queued) return Promise.resolve({ ok: false, ...queued });
    const value = run();
    if (value instanceof Refusal) {
      return Promise.resolve({
        ok: false,
        code: value.code,
        message: value.message,
      });
    }
    return Promise.resolve({ ok: true, value });
  }

  private withMachine<T>(
    serverId: number,
    run: (machine: FakeMachine) => T | Refusal,
  ): T | Refusal {
    const machine = this.machines.get(serverId);
    return machine
      ? run(machine)
      : refusal(HETZNER_NOT_FOUND, 'server not found');
  }

  /** The port's view of a machine: no key, no image. */
  private view(machine: FakeMachine): HetznerServer {
    const {
      sshPublicKey: _key,
      image: _image,
      rebuiltFrom: _rebuiltFrom,
      ...server
    } = machine;
    void _key;
    void _image;
    void _rebuiltFrom;
    return {
      ...server,
      labels: { ...server.labels },
      volumeIds: [...this.volumeRows.values()]
        .filter((volume) => volume.serverId === machine.id)
        .map((volume) => volume.id),
    };
  }

  private diskOf(machine: FakeMachine): number {
    const type = this.catalogue.serverTypes.find(
      (t) => t.name === machine.serverType,
    );
    return type?.diskGb ?? 0;
  }

  /** Room for one more: with 7 already, the oldest is deleted, as the provider does. */
  private keepBackupSlot(serverId: number): void {
    const held = [...this.backupRows.values()]
      .filter((backup) => backup.boundTo === serverId)
      .sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
    for (const backup of held.slice(0, Math.max(0, held.length - 6))) {
      this.backupRows.delete(backup.id);
    }
  }

  /** The provider deletes a machine's backups with it, and when they are turned off. */
  private dropBackups(serverId: number): void {
    for (const [id, backup] of this.backupRows) {
      if (backup.boundTo === serverId) this.backupRows.delete(id);
    }
  }

  private primaryIp(
    type: 'ipv4' | 'ipv6',
    serverId: number,
    labels: Record<string, string>,
  ): FakePrimaryIp {
    const id = this.id();
    const ip: FakePrimaryIp = {
      id,
      type,
      ip:
        type === 'ipv4'
          ? `203.0.113.${(id % 250) + 1}`
          : `2001:db8:${id.toString(16)}::1`,
      serverId,
      labels: { ...labels },
      dnsPtr: null,
    };
    this.ips.set(id, ip);
    return ip;
  }

  private action(command: string): HetznerAction {
    const action: HetznerAction = {
      id: this.id(),
      command,
      status: 'success',
      error: null,
    };
    this.actions.set(action.id, action);
    return { ...action };
  }

  private id(): number {
    return this.nextId++;
  }
}

/** The provider's no, as the fake's methods return it. */
class Refusal {
  constructor(
    readonly code: string,
    readonly message: string,
  ) {}
}

function refusal(code: string, message: string): Refusal {
  return new Refusal(code, message);
}
