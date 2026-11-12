/**
 * The Hetzner Cloud port: the one seam through which Cloudgate reaches the
 * provider that makes **Bought Servers** (ADR-0071). It stands beside the AWS
 * and Google ports rather than in them: those reach a customer's own Cloud
 * account, and this reaches Octabyte's.
 *
 * Its only implementation is `HetznerCloudAdapter`
 * (`./hetzner-cloud.adapter.ts`), the one file in `src` that names the
 * provider's API, which speaks it over `fetch` and never through the `hcloud`
 * CLI (`test/coding-standards/cloud-port.spec.ts`). Every e2e gets an
 * in-memory fake in its place (`test/utils/fake-hetzner-cloud.ts`, as
 * `ctx.hetzner`).
 *
 * **Two instances, one per token** (ADR-0071): {@link HETZNER_MACHINES} is the
 * EUR account, which makes and changes every machine, and
 * {@link HETZNER_PRICES} is the empty USD account, which is only ever asked
 * for prices. The USD list is its own list, not a conversion (an account's
 * currency is fixed when it is made, and the API prices only in it), so
 * prices are never read from the machines account.
 *
 * **The whole surface the spec names, so later work only uses it**: the
 * catalogue (server types with their per-Location prices and availability,
 * Locations with coordinates, the account's price list), and on a machine:
 * create with labels and a public key, read, change type without growing the
 * disk, power on and off, backups on and off, a Volume's create, attach and
 * resize, delete of the machine, its Volume and its Primary IP, reverse DNS,
 * and a list by label. Snapshots, firewalls, floating IPs, networks, ISO
 * images and rescue mode are out of scope (ADR-0071), so they are not here.
 *
 * **Answers, not exceptions**, as the Google port. A call the provider
 * refuses resolves to `{ ok: false, code, message }` with the provider's own
 * error code (`resource_unavailable`, `not_found`, `locked`, …) and words; an
 * exception means the call never got an answer (no network, no token, a
 * timeout), and the caller fails rather than concludes. An action the
 * provider starts is answered at once, still `running` perhaps: waiting on it
 * is {@link HetznerCloudPort.getAction}'s, so a restart can resume the wait
 * from the stored action id.
 */
export const HETZNER_MACHINES = Symbol('HETZNER_MACHINES');
export const HETZNER_PRICES = Symbol('HETZNER_PRICES');

/** The provider's code for a thing that is not there. */
export const HETZNER_NOT_FOUND = 'not_found';
/** The provider's code for a create it cannot place right now (sold out). */
export const HETZNER_RESOURCE_UNAVAILABLE = 'resource_unavailable';

/** What the provider answered: the value, or its refusal in its own words. */
export type HetznerAnswer<T> =
  { ok: true; value: T } | { ok: false; code: string; message: string };

/** `GET /locations`: everything a map needs, with no extra lookup. */
export interface HetznerLocation {
  id: number;
  /** The provider's short name, `fsn1`: what a create names. */
  name: string;
  description: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** `Falkenstein`, or `Ashburn, VA`. */
  city: string;
  latitude: number;
  longitude: number;
  networkZone: string;
}

/** One Location a server type is listed in, with whether it can be bought there now. */
export interface HetznerServerTypeLocation {
  /** The Location's short name. */
  name: string;
  /**
   * Whether it is orderable now. Only a hint: the provider says so itself,
   * and a create can still be refused (`resource_unavailable`).
   */
  available: boolean;
  /** `deprecation.unavailable_after`: past it, never orderable here again. */
  unavailableAfter: string | null;
}

/** One Location's price for a server type, in the account's currency. */
export interface HetznerTypePrice {
  location: string;
  /** Net, as the provider writes it: a decimal string, `"6.4900000000"`. */
  monthlyNet: string;
}

/** `GET /server_types`, one entry. */
export interface HetznerServerType {
  id: number;
  /** The provider's code, `cpx22`. Never shown to a customer. */
  name: string;
  cores: number;
  memoryGb: number;
  diskGb: number;
  storageType: 'local' | 'network';
  cpuType: 'shared' | 'dedicated';
  architecture: 'x86' | 'arm';
  locations: HetznerServerTypeLocation[];
  prices: HetznerTypePrice[];
}

/** `GET /pricing`: the account's list for what is not a server type. */
export interface HetznerPricing {
  /** `USD` or `EUR`: fixed when the account was made. */
  currency: string;
  /** Primary IPs per type and Location, monthly net. IPv6 is free. */
  primaryIps: Array<{
    type: 'ipv4' | 'ipv6';
    location: string;
    monthlyNet: string;
  }>;
  /** One price per GB a month, for every Location. */
  volumePerGbMonthNet: string;
  /** Backups add this percentage of the server's own price. */
  serverBackupPercentage: string;
}

/** An asynchronous task the provider started, and how it stands. */
export interface HetznerAction {
  id: number;
  command: string;
  status: 'running' | 'success' | 'error';
  error: { code: string; message: string } | null;
}

/** A machine, as Cloudgate needs to know it. */
export interface HetznerServer {
  id: number;
  name: string;
  /** `initializing`, `starting`, `running`, `stopping`, `off`, `deleting`, … */
  status: string;
  serverType: string;
  location: string;
  /** The public IPv4 address, once the machine has one. */
  ipv4: string | null;
  /** The Primary IP behind {@link ipv4}, which outlives the machine unless deleted. */
  primaryIpv4Id: number | null;
  ipv6: string | null;
  primaryIpv6Id: number | null;
  /** Whether the daily backup is on. */
  backups: boolean;
  volumeIds: number[];
  labels: Record<string, string>;
  created: string;
}

/** A Volume: extra storage, in one Location, attached to at most one machine. */
export interface HetznerVolume {
  id: number;
  name: string;
  sizeGb: number;
  location: string;
  serverId: number | null;
  /** Where the machine sees it, `/dev/disk/by-id/scsi-0HC_Volume_123`. */
  linuxDevice: string;
  labels: Record<string, string>;
}

export interface CreateServerRequest {
  /** Unique in the account, and an RFC 1123 hostname. */
  name: string;
  serverType: string;
  location: string;
  /** The image to start from, `ubuntu-24.04`. */
  image: string;
  /**
   * The Server's public key, the only credential the provider is given
   * (ADR-0071): no root password is made or emailed.
   */
  sshPublicKey: string;
  /** Names the Organization and the Server, so a restart and the orphan check can find it. */
  labels: Record<string, string>;
}

export interface CreatedServer {
  server: HetznerServer;
  action: HetznerAction;
}

export interface CreateVolumeRequest {
  name: string;
  sizeGb: number;
  location: string;
  labels: Record<string, string>;
}

export interface CreatedVolume {
  volume: HetznerVolume;
  action: HetznerAction | null;
}

export interface HetznerCloudPort {
  /** Every server type the account can see, with its per-Location prices and availability. */
  listServerTypes(): Promise<HetznerAnswer<HetznerServerType[]>>;
  /** Every Location, with its city and coordinates. */
  listLocations(): Promise<HetznerAnswer<HetznerLocation[]>>;
  /** The account's price list beside the server types: Primary IPs, Volumes, backups. */
  getPricing(): Promise<HetznerAnswer<HetznerPricing>>;

  /**
   * Makes a machine with this public key and these labels. The key is
   * handed over as the provider asks, as a key of the account's own, and
   * removed again once the machine holds it.
   */
  createServer(
    request: CreateServerRequest,
  ): Promise<HetznerAnswer<CreatedServer>>;
  /** One machine; `not_found` once it is gone. */
  getServer(serverId: number): Promise<HetznerAnswer<HetznerServer>>;
  /** Every machine whose labels hold all of `labels`; with none, every machine. */
  listServers(
    labels: Record<string, string>,
  ): Promise<HetznerAnswer<HetznerServer[]>>;
  /**
   * A new size for a machine that is off, keeping its disk
   * (`upgrade_disk=false`), so it can always move back down.
   */
  changeServerType(
    serverId: number,
    serverType: string,
  ): Promise<HetznerAnswer<HetznerAction>>;
  powerOn(serverId: number): Promise<HetznerAnswer<HetznerAction>>;
  /** At once, as pulling the plug: what an abuse stop and a size change need. */
  powerOff(serverId: number): Promise<HetznerAnswer<HetznerAction>>;
  enableBackup(serverId: number): Promise<HetznerAnswer<HetznerAction>>;
  /** Also deletes every backup the machine has, at once (the provider's rule). */
  disableBackup(serverId: number): Promise<HetznerAnswer<HetznerAction>>;
  /** Sets the reverse DNS of one of the machine's addresses. */
  setReverseDns(
    serverId: number,
    ip: string,
    dnsPtr: string,
  ): Promise<HetznerAnswer<HetznerAction>>;
  /**
   * Deletes the machine and its backups. Its Volumes and Primary IPs are
   * only detached, and go on being billed until deleted themselves.
   */
  deleteServer(serverId: number): Promise<HetznerAnswer<HetznerAction>>;

  /** A Volume between 10 GB and 10 TB, formatted ext4, unattached. */
  createVolume(
    request: CreateVolumeRequest,
  ): Promise<HetznerAnswer<CreatedVolume>>;
  getVolume(volumeId: number): Promise<HetznerAnswer<HetznerVolume>>;
  /** Every Volume whose labels hold all of `labels`: a create a restart cut off is found, not repeated. */
  listVolumes(
    labels: Record<string, string>,
  ): Promise<HetznerAnswer<HetznerVolume[]>>;
  /** Attaches a Volume to a machine in the same Location. */
  attachVolume(
    volumeId: number,
    serverId: number,
  ): Promise<HetznerAnswer<HetznerAction>>;
  /** Grows a Volume; it never shrinks. The filesystem is grown on the machine afterwards. */
  resizeVolume(
    volumeId: number,
    sizeGb: number,
  ): Promise<HetznerAnswer<HetznerAction>>;
  /** Deletes a Volume that is attached to nothing. */
  deleteVolume(volumeId: number): Promise<HetznerAnswer<void>>;
  /** Deletes a Primary IP that is assigned to nothing. */
  deletePrimaryIp(primaryIpId: number): Promise<HetznerAnswer<void>>;

  /** How an action the provider started stands now. */
  getAction(actionId: number): Promise<HetznerAnswer<HetznerAction>>;
}
