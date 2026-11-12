import { z } from 'zod';

import { nativeAwsWireSchema } from './aws-native';
import { nativeDockerWireSchema } from './docker-native';
import { nativeGcpWireSchema } from './gcp-native';

/**
 * `native`: one block per Deploy target, `docker`, `aws`
 * (`aws-native.ts`) and `gcp` (`gcp-native.ts`).
 */
export const nativeWireSchema = z
  .strictObject({
    docker: nativeDockerWireSchema.optional(),
    aws: nativeAwsWireSchema.optional(),
    gcp: nativeGcpWireSchema.optional(),
  })
  .meta({
    description:
      "Settings in the Deploy target's own language; only the Environment's target's block is used.",
  });

export type NativeBlock = z.infer<typeof nativeWireSchema>;
