import dns from 'node:dns';
import { promisify } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import { detectCDNProvider } from './cdn-providers';

/** Injectable resolve4 so tests never hit real DNS (FETCH_CLIENT precedent). */
export const DNS_RESOLVER = Symbol('DNS_RESOLVER');

export type DnsResolver = (host: string) => Promise<string[]>;

export const dnsResolverProvider = {
  provide: DNS_RESOLVER,
  useValue: promisify(dns.resolve4) as DnsResolver,
};

export interface DomainValidationResult {
  isValid: boolean;
  resolvedIp?: string;
  error?: string;
  cdnProvider?: string;
}

/**
 * Domain validation with CDN detection — the only consumer of the cdn
 * provider tables: resolve the domain, warn (but pass) when a CDN proxy masks
 * the origin, otherwise compare against the expected server IP.
 */
@Injectable()
export class CdnService {
  constructor(@Inject(DNS_RESOLVER) private readonly resolve: DnsResolver) {}

  async validateDomain(
    domain: string,
    expectedIp?: string,
  ): Promise<DomainValidationResult> {
    try {
      // Remove protocol and path if present
      const cleanDomain = domain.replace(/^https?:\/\//, '').split('/')[0];

      const ips = await this.resolve(cleanDomain || '');
      const resolvedIps = ips.map((ip) => ip.toString());

      // Check if any IP belongs to a CDN provider
      const cdnProvider = ips
        .map((ip) => detectCDNProvider(ip))
        .find((provider) => provider !== null);

      // If behind a CDN, we consider it valid but inform the user
      if (cdnProvider) {
        return {
          isValid: true,
          resolvedIp: resolvedIps.join(', '),
          cdnProvider: cdnProvider.displayName,
          error: cdnProvider.warningMessage,
        };
      }

      // If we have an expected IP, validate against it
      if (expectedIp) {
        return {
          isValid: resolvedIps.includes(expectedIp),
          resolvedIp: resolvedIps.join(', '),
          error: !resolvedIps.includes(expectedIp)
            ? `Domain resolves to ${resolvedIps.join(', ')} but should point to ${expectedIp}`
            : undefined,
        };
      }

      // If no expected IP, just return the resolved IP
      return {
        isValid: true,
        resolvedIp: resolvedIps.join(', '),
      };
    } catch (error) {
      return {
        isValid: false,
        error:
          error instanceof Error ? error.message : 'Failed to resolve domain',
      };
    }
  }
}
