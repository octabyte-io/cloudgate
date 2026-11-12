import { useQuery } from "@tanstack/react-query";

import { settingsApi } from "./endpoints/settings";
import { keys } from "./keys";

/**
 * `GET /settings/web-server`: the one `web_server_settings` row this instance
 * has, keyed under `instance` (`keys.webServerSettings`).
 *
 * **Promoted out of `features/settings/platform/use-platform.ts`** under §1.4
 * when an Application's Requested previews card became its second feature
 * which reads the instance's requested-preview maximum for its Extend
 * dialog. Every mutation of the row still lives in `use-platform.ts` and
 * invalidates the whole `instance` root, this key included.
 */
export function useWebServerSettings() {
  return useQuery({
    queryKey: keys.webServerSettings(),
    queryFn: settingsApi.webServer,
  });
}
