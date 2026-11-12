import { Test } from '@nestjs/testing';
import { CommonModule } from '../../src/common/common.module';
import { EncryptionService } from '../../src/common/encryption/encryption.service';

describe('CommonModule', () => {
  beforeAll(() => {
    process.env.APP_ENCRYPTION_SECRET =
      'test-encryption-secret-at-least-32-chars';
  });

  it('provides an EncryptionService that round-trips values', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CommonModule],
    }).compile();

    const encryption = moduleRef.get(EncryptionService);
    const ciphertext = encryption.encrypt('a-secret');
    expect(ciphertext).not.toBe('a-secret');
    expect(encryption.decrypt(ciphertext)).toBe('a-secret');
  });
});
