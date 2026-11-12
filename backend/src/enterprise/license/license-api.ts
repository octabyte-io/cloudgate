/**
 * The remote license server, as an injectable boundary so tests never reach
 * the network (FETCH_CLIENT precedent).
 */

export const LICENSE_API = Symbol('LICENSE_API');

/**
 * What `POST /licenses/activate` answers. A non-ok response throws, and
 * anything else counts as activated. The fields below are read when present,
 * which is how `validUntil`/`features` reach the license row; a server that
 * sends neither yields a license that never expires and enumerates no named
 * features.
 */
export interface LicenseActivation {
  validUntil?: string | null;
  features?: string[] | null;
}

export interface LicenseApi {
  /** Rejects when the license server refuses the key or is unreachable. */
  activate(licenseKey: string): Promise<LicenseActivation>;
  /** `data.valid` from `POST /licenses/validate`. */
  validate(licenseKey: string): Promise<boolean>;
  deactivate(licenseKey: string): Promise<void>;
}
