import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { PermissionCtx } from '../rbac/permission.service';
import { DomainsService } from './domains.service';
import { readServedCertificate } from './served-certificate';
import type { ServedCertificate } from './served-certificate';

/** Reads what a host serves; a token so the e2e specs need no network. */
export const SERVED_CERTIFICATE_READER = Symbol('SERVED_CERTIFICATE_READER');
export type ServedCertificateReader = (
  host: string,
) => Promise<ServedCertificate>;

/**
 * `GET /domains/:id/served-certificate` (#130): the certificate a Domain's
 * host serves right now, so the console can say "issuing" while Traefik still
 * serves its default certificate, and stop saying it once Let's Encrypt's
 * has arrived.
 *
 * **The address is the Domain's own.** The caller names a Domain id and
 * nothing else; `DomainsService.findOne` resolves it inside their
 * Organization and asks `domain: read` and the parent Service's row access,
 * exactly as reading the Domain does, so a Domain they cannot read is refused
 * before anything is dialled, and identically to one that does not exist.
 * The host dialled is the stored one, on 443, for a handshake only
 * (`readServedCertificate`): a caller cannot point it anywhere else.
 */
@Injectable()
export class ServedCertificateService {
  constructor(
    private readonly domains: DomainsService,
    @Inject(SERVED_CERTIFICATE_READER)
    private readonly read: ServedCertificateReader,
  ) {}

  async servedCertificate(
    ctx: PermissionCtx,
    domainId: string,
  ): Promise<ServedCertificate> {
    const found = await this.domains.findOne(ctx, domainId);
    if (!found.https) {
      throw new BadRequestException(
        'This Domain is served over HTTP, so it has no certificate to read.',
      );
    }
    return this.read(found.host);
  }
}

export const servedCertificateReaderProvider = {
  provide: SERVED_CERTIFICATE_READER,
  useValue: ((host) => readServedCertificate(host)) as ServedCertificateReader,
};
