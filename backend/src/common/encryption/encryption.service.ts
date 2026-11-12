import { Injectable } from '@nestjs/common';
import { decryptValue, encryptValue, isEncrypted } from './encryption';

/**
 * Injectable facade over the pure encryption functions. Drizzle column types
 * (db/columns.ts) use the functions directly since custom types cannot be
 * injected; everything else should depend on this service.
 */
@Injectable()
export class EncryptionService {
  encrypt(value: string): string {
    return encryptValue(value);
  }

  decrypt(value: string): string {
    return decryptValue(value);
  }

  isEncrypted(value: string): boolean {
    return isEncrypted(value);
  }
}
