import { useMemo } from "react";

import type { ServiceChoice } from "@/features/application/domains/domain-schema";
import type { Domain } from "@/lib/api/endpoints/domains";

import { useComposeServices, useConvertedCompose } from "../use-compose";
import { composeServicePorts } from "./service-ports";

/**
 * The services a stack's Domain dialog picks from, and the port each listens
 * on. The file is read through the Converted route only while a dialog is
 * open, because for a git source that route reads the clone over SSH.
 */
export function useServiceChoice(
  composeId: string,
  domains: readonly Domain[],
  dialogOpen: boolean,
): ServiceChoice {
  const services = useComposeServices(composeId);
  const converted = useConvertedCompose(composeId, dialogOpen);
  const content = converted.data;
  const ports = useMemo(
    () => composeServicePorts(content, domains),
    [content, domains],
  );
  return {
    names: services.error ? undefined : services.data,
    pending: services.isPending,
    ports,
  };
}
