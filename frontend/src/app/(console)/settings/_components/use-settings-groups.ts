import { useIsOperator } from "@/features/operator/use-operator";
import { useSeesPlatformHost } from "@/features/operator/use-sees-platform-host";
import { settingsGroups, type SettingsGroup } from "@/lib/settings/sections";

/**
 * The settings groups this reader is shown: every section, the Operator
 * section only for an Operator on the Hosted instance (ADR-0050), and the
 * platform host's sections only for whoever is shown them (ADR-0053). The
 * index's cards and the column beside each screen both read it, so the two
 * cannot disagree about which pages exist.
 */
export function useSettingsGroups(): SettingsGroup[] {
  const { operator } = useIsOperator();
  const { sees } = useSeesPlatformHost();
  return settingsGroups({ operator, platformHost: sees });
}
