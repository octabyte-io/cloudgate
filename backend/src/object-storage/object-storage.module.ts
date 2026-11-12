import { Module } from '@nestjs/common';
import { OBJECT_STORAGE } from './object-storage.port';
import { S3ObjectStorage } from './s3-object-storage.adapter';

/**
 * The object-storage port bound to its real adapter. Every e2e
 * spec replaces {@link OBJECT_STORAGE} with the in-memory fake.
 */
@Module({
  providers: [{ provide: OBJECT_STORAGE, useClass: S3ObjectStorage }],
  exports: [OBJECT_STORAGE],
})
export class ObjectStorageModule {}
