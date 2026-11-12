import { z } from "zod";

import { isServerAddress, SERVER_ADDRESS_MESSAGE } from "./server-address";

export const ROLES = [
  { value: "deploy" as const, label: "Deploy" },
  { value: "build" as const, label: "Build" },
];

/**
 * **Six fields, and that is genuinely the whole row a `POST /servers` accepts** —
 * name, description, address, port, SSH user, key and role. There is no provider, no
 * region, no size and no image, because `createServerSchema` has none of those and
 * neither does the table (`00-INDEX.md`, locked decision 1).
 */
export const addServerSchema = z.object({
  name: z.string().trim().min(1, "A Server needs a name."),
  description: z.string().trim(),
  ipAddress: z
    .string()
    .trim()
    .min(1, "A Server needs an address Cloudgate can reach over SSH.")
    .refine(isServerAddress, SERVER_ADDRESS_MESSAGE),
  port: z.coerce
    .number()
    .int("A port is a whole number.")
    .min(1, "A port is between 1 and 65535.")
    .max(65535, "A port is between 1 and 65535."),
  username: z.string().trim().min(1, "Name the user Cloudgate signs in as."),
  sshKeyId: z.string().min(1, "Choose the key that reaches this Server."),
});

export type AddServerValues = z.infer<typeof addServerSchema>;
