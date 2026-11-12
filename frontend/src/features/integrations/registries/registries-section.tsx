"use client";

import { ResourceList } from "@/components/console/resource-list";
import { useProbeServerPicker } from "@/lib/forms/probe-server-picker";
import { useInvalidate } from "@/lib/api/use-invalidate";

import { useRegistries } from "../use-integrations";
import { registrySpec } from "./registries-spec";

/**
 * Registries: one `ResourceList` and one configuration file.
 *
 * There is nothing else on this screen, and that is the point of the phase —
 * a registry is `POST /` · `GET /` · `PATCH /:id` · `DELETE /:id` with six
 * fields, which is exactly what F10 built the pattern for.
 */
export function RegistriesSection() {
  const invalidate = useInvalidate();
  const query = useRegistries();
  // On the Hosted instance a test runs from a Server the dialog asks for.
  const probeFrom = useProbeServerPicker();

  return (
    <ResourceList
      spec={registrySpec(invalidate.registries, probeFrom)}
      query={query}
    />
  );
}
