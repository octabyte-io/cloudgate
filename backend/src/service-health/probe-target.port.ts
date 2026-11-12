/**
 * Where a Probe connects, as a seam (the spec's first test double).
 *
 * An HTTP check resolves its Domain through ordinary DNS, as any client
 * would, so in production this is the identity: the URL a Probe asks
 * for is the URL it dials. A suite binds {@link PROBE_TARGET} to a mapping
 * that sends a Domain's host to a local stub server instead, so the real
 * transport — the timeout, the status judgement, the error classes — runs
 * against something the suite can switch between 2xx, 5xx and a hang.
 *
 * **Why the address and not the transport.** Replacing the transport would
 * test the Incident rule over a fake of the very thing that decides up or
 * down; replacing only where it connects keeps `probeHttp` and `probeTcp`
 * under test, the keyword and header checks with them.
 */
export interface ProbeTarget {
  /** The URL an HTTP Probe of `url` actually requests. */
  http(url: URL): URL;
  /** Where a TCP Probe of `host:port` actually connects. */
  tcp(host: string, port: number): { host: string; port: number };
}

export const PROBE_TARGET = 'PROBE_TARGET';

/** Production: a Probe goes where the Domain says, resolved by DNS. */
export const directProbeTarget: ProbeTarget = {
  http: (url) => url,
  tcp: (host, port) => ({ host, port }),
};
