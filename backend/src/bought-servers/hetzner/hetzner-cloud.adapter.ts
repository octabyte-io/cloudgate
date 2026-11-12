import type {
  CreateServerRequest,
  CreateVolumeRequest,
  CreatedServer,
  CreatedVolume,
  HetznerAction,
  HetznerAnswer,
  HetznerCloudPort,
  HetznerLocation,
  HetznerPricing,
  HetznerServer,
  HetznerServerType,
  HetznerVolume,
} from './hetzner-cloud.port';

/** The provider's API. Named here and nowhere else in `src` (`cloud-port.spec.ts`). */
const API = 'https://api.hetzner.cloud/v1';

/** Long enough for a create, which answers once the machine is placed. */
const CALL_TIMEOUT_MS = 60_000;

/** The provider's largest page. */
const PER_PAGE = 50;

/**
 * The Hetzner Cloud port's adapter: **the only file in `src` that calls the
 * provider's API** (`test/coding-standards/cloud-port.spec.ts`, and its
 * outbound-dial census entry). It speaks the REST API over `fetch`: the
 * `hcloud` CLI was rejected (ADR-0071), since a spawned binary is a call no
 * fake can stand in for and no census can see.
 *
 * One instance per token (`HETZNER_MACHINES`, `HETZNER_PRICES`). The token is
 * read on every call rather than at construction, so an instance with no
 * token boots, and only a call made without one fails, by throwing: no token
 * is no answer, never a refusal to conclude from.
 */
export class HetznerCloudAdapter implements HetznerCloudPort {
  constructor(
    private readonly token: () => string | undefined,
    private readonly account: string,
  ) {}

  async listServerTypes(): Promise<HetznerAnswer<HetznerServerType[]>> {
    const answer = await this.everyPage<ApiServerType>(
      '/server_types',
      'server_types',
    );
    return answer.ok
      ? { ok: true, value: answer.value.map(serverTypeOf) }
      : answer;
  }

  async listLocations(): Promise<HetznerAnswer<HetznerLocation[]>> {
    const answer = await this.everyPage<ApiLocation>('/locations', 'locations');
    return answer.ok
      ? { ok: true, value: answer.value.map(locationOf) }
      : answer;
  }

  async getPricing(): Promise<HetznerAnswer<HetznerPricing>> {
    const answer = await this.call<{ pricing: ApiPricing }>('GET', '/pricing');
    return answer.ok
      ? { ok: true, value: pricingOf(answer.value.pricing) }
      : answer;
  }

  /**
   * The provider takes keys by the id of a key in the account, never inline,
   * so the public key is added as one for the length of the create and
   * deleted again once the machine has it: a key on a machine stays there.
   * Its name carries the time, so a key a crash left behind never blocks the
   * next try under the same name.
   */
  async createServer(
    request: CreateServerRequest,
  ): Promise<HetznerAnswer<CreatedServer>> {
    const key = await this.call<{ ssh_key: { id: number } }>(
      'POST',
      '/ssh_keys',
      {
        name: `${request.name}-${Date.now()}`,
        public_key: request.sshPublicKey,
        labels: request.labels,
      },
    );
    if (!key.ok) return key;
    try {
      const created = await this.call<{ server: ApiServer; action: ApiAction }>(
        'POST',
        '/servers',
        {
          name: request.name,
          server_type: request.serverType,
          location: request.location,
          image: request.image,
          ssh_keys: [key.value.ssh_key.id],
          labels: request.labels,
          start_after_create: true,
          public_net: { enable_ipv4: true, enable_ipv6: true },
        },
      );
      return created.ok
        ? {
            ok: true,
            value: {
              server: serverOf(created.value.server),
              action: actionOf(created.value.action),
            },
          }
        : created;
    } finally {
      await this.call('DELETE', `/ssh_keys/${key.value.ssh_key.id}`);
    }
  }

  async getServer(serverId: number): Promise<HetznerAnswer<HetznerServer>> {
    const answer = await this.call<{ server: ApiServer }>(
      'GET',
      `/servers/${serverId}`,
    );
    return answer.ok
      ? { ok: true, value: serverOf(answer.value.server) }
      : answer;
  }

  async listServers(
    labels: Record<string, string>,
  ): Promise<HetznerAnswer<HetznerServer[]>> {
    const selector = Object.entries(labels)
      .map(([key, value]) => `${key}==${value}`)
      .join(',');
    // No labels is every machine in the account (the orphan check's list).
    const answer = await this.everyPage<ApiServer>(
      '/servers',
      'servers',
      selector ? { label_selector: selector } : {},
    );
    return answer.ok ? { ok: true, value: answer.value.map(serverOf) } : answer;
  }

  changeServerType(
    serverId: number,
    serverType: string,
  ): Promise<HetznerAnswer<HetznerAction>> {
    return this.action(`/servers/${serverId}/actions/change_type`, {
      server_type: serverType,
      upgrade_disk: false,
    });
  }

  powerOn(serverId: number): Promise<HetznerAnswer<HetznerAction>> {
    return this.action(`/servers/${serverId}/actions/poweron`);
  }

  powerOff(serverId: number): Promise<HetznerAnswer<HetznerAction>> {
    return this.action(`/servers/${serverId}/actions/poweroff`);
  }

  enableBackup(serverId: number): Promise<HetznerAnswer<HetznerAction>> {
    return this.action(`/servers/${serverId}/actions/enable_backup`);
  }

  disableBackup(serverId: number): Promise<HetznerAnswer<HetznerAction>> {
    return this.action(`/servers/${serverId}/actions/disable_backup`);
  }

  setReverseDns(
    serverId: number,
    ip: string,
    dnsPtr: string,
  ): Promise<HetznerAnswer<HetznerAction>> {
    return this.action(`/servers/${serverId}/actions/change_dns_ptr`, {
      ip,
      dns_ptr: dnsPtr,
    });
  }

  async deleteServer(serverId: number): Promise<HetznerAnswer<HetznerAction>> {
    const answer = await this.call<{ action: ApiAction }>(
      'DELETE',
      `/servers/${serverId}`,
    );
    return answer.ok
      ? { ok: true, value: actionOf(answer.value.action) }
      : answer;
  }

  async createVolume(
    request: CreateVolumeRequest,
  ): Promise<HetznerAnswer<CreatedVolume>> {
    const answer = await this.call<{
      volume: ApiVolume;
      action: ApiAction | null;
    }>('POST', '/volumes', {
      name: request.name,
      size: request.sizeGb,
      location: request.location,
      labels: request.labels,
      format: 'ext4',
      automount: false,
    });
    return answer.ok
      ? {
          ok: true,
          value: {
            volume: volumeOf(answer.value.volume),
            action: answer.value.action ? actionOf(answer.value.action) : null,
          },
        }
      : answer;
  }

  async getVolume(volumeId: number): Promise<HetznerAnswer<HetznerVolume>> {
    const answer = await this.call<{ volume: ApiVolume }>(
      'GET',
      `/volumes/${volumeId}`,
    );
    return answer.ok
      ? { ok: true, value: volumeOf(answer.value.volume) }
      : answer;
  }

  async listVolumes(
    labels: Record<string, string>,
  ): Promise<HetznerAnswer<HetznerVolume[]>> {
    const selector = Object.entries(labels)
      .map(([key, value]) => `${key}==${value}`)
      .join(',');
    const answer = await this.everyPage<ApiVolume>('/volumes', 'volumes', {
      label_selector: selector,
    });
    return answer.ok ? { ok: true, value: answer.value.map(volumeOf) } : answer;
  }

  attachVolume(
    volumeId: number,
    serverId: number,
  ): Promise<HetznerAnswer<HetznerAction>> {
    return this.action(`/volumes/${volumeId}/actions/attach`, {
      server: serverId,
      automount: false,
    });
  }

  resizeVolume(
    volumeId: number,
    sizeGb: number,
  ): Promise<HetznerAnswer<HetznerAction>> {
    return this.action(`/volumes/${volumeId}/actions/resize`, {
      size: sizeGb,
    });
  }

  async deleteVolume(volumeId: number): Promise<HetznerAnswer<void>> {
    const answer = await this.call('DELETE', `/volumes/${volumeId}`);
    return answer.ok ? { ok: true, value: undefined } : answer;
  }

  async deletePrimaryIp(primaryIpId: number): Promise<HetznerAnswer<void>> {
    const answer = await this.call('DELETE', `/primary_ips/${primaryIpId}`);
    return answer.ok ? { ok: true, value: undefined } : answer;
  }

  async getAction(actionId: number): Promise<HetznerAnswer<HetznerAction>> {
    const answer = await this.call<{ action: ApiAction }>(
      'GET',
      `/actions/${actionId}`,
    );
    return answer.ok
      ? { ok: true, value: actionOf(answer.value.action) }
      : answer;
  }

  /** A `POST …/actions/<command>`, answered with the action it started. */
  private async action(
    path: string,
    body: unknown = {},
  ): Promise<HetznerAnswer<HetznerAction>> {
    const answer = await this.call<{ action: ApiAction }>('POST', path, body);
    return answer.ok
      ? { ok: true, value: actionOf(answer.value.action) }
      : answer;
  }

  /** Every page of a list, by `meta.pagination.next_page`. */
  private async everyPage<T>(
    path: string,
    items: string,
    query: Record<string, string> = {},
  ): Promise<HetznerAnswer<T[]>> {
    const found: T[] = [];
    let page: number | null = 1;
    while (page !== null) {
      const search = new URLSearchParams({
        ...query,
        page: String(page),
        per_page: String(PER_PAGE),
      });
      const answer = await this.call<Record<string, unknown>>(
        'GET',
        `${path}?${search.toString()}`,
      );
      if (!answer.ok) return answer;
      found.push(...((answer.value[items] ?? []) as T[]));
      const meta = answer.value.meta as
        { pagination?: { next_page?: number | null } } | undefined;
      page = meta?.pagination?.next_page ?? null;
    }
    return { ok: true, value: found };
  }

  /** One request: its JSON on a 2xx, the provider's `{ error: { code, message } }` otherwise. */
  private async call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<HetznerAnswer<T>> {
    const token = this.token();
    if (!token) {
      throw new Error(`The ${this.account} provider token is not configured`);
    }
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (response.ok) return { ok: true, value: parsed as T };
    const error = (parsed as { error?: { code?: string; message?: string } })
      ?.error;
    return {
      ok: false,
      code: error?.code ?? String(response.status),
      message: error?.message ?? (text.trim() || response.statusText),
    };
  }
}

interface ApiLocation {
  id: number;
  name: string;
  description: string;
  country: string;
  city: string;
  latitude: number;
  longitude: number;
  network_zone: string;
}

interface ApiServerType {
  id: number;
  name: string;
  cores: number;
  memory: number;
  disk: number;
  storage_type: 'local' | 'network';
  cpu_type: 'shared' | 'dedicated';
  architecture: 'x86' | 'arm';
  prices: Array<{ location: string; price_monthly: { net: string } }>;
  locations?: Array<{
    name: string;
    available?: boolean;
    deprecation?: { unavailable_after?: string } | null;
  }>;
}

interface ApiPricing {
  currency: string;
  primary_ips?: Array<{
    type: 'ipv4' | 'ipv6';
    prices: Array<{ location: string; price_monthly: { net: string } }>;
  }>;
  volume: { price_per_gb_month: { net: string } };
  server_backup: { percentage: string };
}

interface ApiAction {
  id: number;
  command: string;
  status: 'running' | 'success' | 'error';
  error?: { code: string; message: string } | null;
}

interface ApiServer {
  id: number;
  name: string;
  status: string;
  server_type: { name: string };
  location?: { name: string };
  /** Removed in 2026 in favour of `location`; read while it may still come. */
  datacenter?: { location?: { name: string } };
  public_net?: {
    ipv4?: { id: number; ip: string } | null;
    ipv6?: { id: number; ip: string } | null;
  };
  backup_window?: string | null;
  volumes?: number[];
  labels?: Record<string, string>;
  created: string;
}

interface ApiVolume {
  id: number;
  name: string;
  size: number;
  location: { name: string };
  server: number | null;
  linux_device: string;
  labels?: Record<string, string>;
}

function locationOf(api: ApiLocation): HetznerLocation {
  return {
    id: api.id,
    name: api.name,
    description: api.description,
    country: api.country,
    city: api.city,
    latitude: api.latitude,
    longitude: api.longitude,
    networkZone: api.network_zone,
  };
}

function serverTypeOf(api: ApiServerType): HetznerServerType {
  return {
    id: api.id,
    name: api.name,
    cores: api.cores,
    memoryGb: api.memory,
    diskGb: api.disk,
    storageType: api.storage_type,
    cpuType: api.cpu_type,
    architecture: api.architecture,
    locations: (api.locations ?? []).map((location) => ({
      name: location.name,
      available: location.available ?? false,
      unavailableAfter: location.deprecation?.unavailable_after ?? null,
    })),
    prices: api.prices.map((price) => ({
      location: price.location,
      monthlyNet: price.price_monthly.net,
    })),
  };
}

function pricingOf(api: ApiPricing): HetznerPricing {
  return {
    currency: api.currency,
    primaryIps: (api.primary_ips ?? []).flatMap((ip) =>
      ip.prices.map((price) => ({
        type: ip.type,
        location: price.location,
        monthlyNet: price.price_monthly.net,
      })),
    ),
    volumePerGbMonthNet: api.volume.price_per_gb_month.net,
    serverBackupPercentage: api.server_backup.percentage,
  };
}

function actionOf(api: ApiAction): HetznerAction {
  return {
    id: api.id,
    command: api.command,
    status: api.status,
    error: api.error ?? null,
  };
}

function serverOf(api: ApiServer): HetznerServer {
  return {
    id: api.id,
    name: api.name,
    status: api.status,
    serverType: api.server_type.name,
    location: api.location?.name ?? api.datacenter?.location?.name ?? '',
    ipv4: api.public_net?.ipv4?.ip ?? null,
    primaryIpv4Id: api.public_net?.ipv4?.id ?? null,
    ipv6: api.public_net?.ipv6?.ip ?? null,
    primaryIpv6Id: api.public_net?.ipv6?.id ?? null,
    backups: Boolean(api.backup_window),
    volumeIds: api.volumes ?? [],
    labels: api.labels ?? {},
    created: api.created,
  };
}

function volumeOf(api: ApiVolume): HetznerVolume {
  return {
    id: api.id,
    name: api.name,
    sizeGb: api.size,
    location: api.location.name,
    serverId: api.server,
    linuxDevice: api.linux_device,
    labels: api.labels ?? {},
  };
}
