import { z } from 'zod';

/**
 * The longest name a Service may carry: an Application, a Compose stack or a
 * database.
 *
 * A Service's `name` is a label for people. It is not what Docker sees: the
 * container, the Swarm service, its volumes and its Traefik router are all
 * named from `appName`, which is held to 63 characters because a Swarm service
 * name is a DNS label (one hostname segment, at most 63) and every create DTO
 * caps it so. `name` had no cap at all, and a 300-character Application pushed
 * every other column of the Environment's Services table about 2,000px to the
 * right and its Delete dialog's buttons out of view.
 *
 * 100 rather than 63, so the cap does not read as the Docker limit it is not,
 * and so a descriptive label ("Billing API — EU read replica") fits with room
 * to spare, while a name still renders in a table cell, a dialog title and a
 * toast. The console's forms hold the same number
 * (`frontend/src/lib/forms/service-name.ts`).
 */
export const SERVICE_NAME_MAX_LENGTH = 100;

/** A Service's `name`, on both its create and its update DTO. */
export const serviceNameSchema = z
  .string()
  .min(1, 'name cannot be empty')
  .max(
    SERVICE_NAME_MAX_LENGTH,
    `name may be at most ${SERVICE_NAME_MAX_LENGTH} characters`,
  );
