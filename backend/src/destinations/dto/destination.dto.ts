import { ApiSchema } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Create body: credentials, bucket, region and endpoint. No additionalFlags
// (out of scope for this phase) and no serverId.
export const createDestinationSchema = z.object({
  name: z.string().min(1, 'name cannot be empty'),
  provider: z.string().nullish(),
  accessKey: z.string().min(1, 'accessKey cannot be empty'),
  secretAccessKey: z.string().min(1, 'secretAccessKey cannot be empty'),
  bucket: z.string().min(1, 'bucket cannot be empty'),
  region: z.string(),
  endpoint: z.string(),
});

export class CreateDestinationDto extends createZodDto(
  createDestinationSchema,
) {}

// Test-connection input — the create payload plus the server to probe from
// (local docker host when omitted).
export const testConnectionSchema = createDestinationSchema.extend({
  serverId: z.string().nullish(),
});

// Named explicitly for the OpenAPI document — see the matching note on
// ai/dto/ai.dto.ts, which exports a `TestConnectionDto` of its own.
@ApiSchema({ name: 'DestinationTestConnectionDto' })
export class TestConnectionDto extends createZodDto(testConnectionSchema) {}

// The saved-probe input: the id travels in the URL and the credentials come off the
// row, so the only thing left to say is *where to probe from* — and that is
// optional, since the platform's own host is the default.
//
// `preprocess`, because a caller with nothing to say sends **no body at all**,
// which reaches the pipe as `undefined` rather than `{}` and would otherwise
// fail validation on the common case (the AppInfosQueryDto precedent).
export const testSavedConnectionSchema = z.preprocess(
  (value) => value ?? {},
  z.object({ serverId: z.string().nullish() }),
);

export class TestSavedConnectionDto extends createZodDto(
  testSavedConnectionSchema,
) {}

// The listing input — the object-key prefix to browse under, e.g. the
// `<appName>/<prefix>` a volume backup writes its tarballs to. Omitted (or
// empty) lists the whole bucket. Not `.default('')`: a zod default makes the
// field required in the type createZodDto derives.
//
// `serverId` is where the listing is read *from*, the same question
// testSavedConnection and `GET /backups/files` both take an answer to. Without
// the field a `serverId` in the query string was dropped by validation and the
// listing ran on the platform host anyway — no 400, no warning, just an answer
// from the wrong machine, which on a multi-server instance reads as an empty
// bucket with no way to ask again from the host that can see it.
export const listDestinationObjectsSchema = z.object({
  prefix: z.string().optional(),
  serverId: z.string().nullish(),
});

export class ListDestinationObjectsDto extends createZodDto(
  listDestinationObjectsSchema,
) {}

// Update body (partial; id travels in the URL).
export const updateDestinationSchema = createDestinationSchema.partial();

export class UpdateDestinationDto extends createZodDto(
  updateDestinationSchema,
) {}
