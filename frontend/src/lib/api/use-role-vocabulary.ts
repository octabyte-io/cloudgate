import { useQuery } from "@tanstack/react-query";

import { rolesApi } from "./endpoints/roles";
import { keys } from "./keys";

/**
 * The permission vocabulary — `rbac/access-control.ts` and the three constants
 * that say how to read it, served by `GET /custom-roles/statements`.
 *
 * `staleTime: Infinity` because it is a constant of the running build: the only
 * thing that changes it is a deploy, and a deploy replaces the whole tab. This
 * is the one query in the app where a refetch could not possibly return
 * something different.
 *
 * **In `lib/api/` rather than with a feature**,
 * which is §3.5's
 * rule applied once this became genuinely cross-feature. It was
 * `usePermissionStatements` in `features/members/use-members.ts`, and
 * `features/enterprise/roles/roles-section.tsx` already reached across for it —
 * then `lib/auth/use-permission.ts` became a reader, and a `lib/` module
 * importing a feature's hook is the layering backwards.
 *
 * No `enabled` and no Organization in the key: this is not tenant data, so it is
 * one cache entry shared by every reader on the instance. That matters more than
 * it looks — `usePermission` is called behind gated controls all over the
 * console, and every one of them is this same entry rather than a request.
 */
export function useRoleVocabulary() {
  return useQuery({
    queryKey: keys.roleStatements(),
    queryFn: rolesApi.vocabulary,
    staleTime: Infinity,
  });
}
