import { useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  DEFAULT_TIME_RANGE,
  NARROW_RANGE,
  TIME_RANGES,
  rangeBounds,
  type TimeRangeValue,
} from "@/components/console/time-range";
import type { RequestStatusClass } from "@/lib/api/endpoints/monitoring";

const STATUS_CLASSES: readonly RequestStatusClass[] = [
  "info",
  "success",
  "redirect",
  "client",
  "server",
];

/**
 * The filters a Requests view keeps in its address — range, status, method,
 * search, page, and the Requests page's Service filter — so a link opens the
 * same view, on the Requests page and on a Service's Requests tab alike.
 *
 * `navigate` writes the address in place; any change but paging returns to
 * the first page, since a filter change that left you on page four would
 * page through a result set that no longer exists.
 *
 * Both ends of the range are always read; `rangeBounds` rounds them to the
 * minute so the query key is stable within one.
 */
export function useRequestsAddress() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const range = parseRange(params.get("range"));
  const term = params.get("q") ?? "";
  const classesKey = params.getAll("status").join(",");
  const methodsKey = params.getAll("method").join(",");
  const servicesKey = params.getAll("service").join(",");
  const noService = params.get("noService") === "1";
  const classes = useMemo(
    () =>
      new Set(
        classesKey
          .split(",")
          .filter((value): value is RequestStatusClass =>
            STATUS_CLASSES.includes(value as RequestStatusClass),
          ),
      ),
    [classesKey],
  );
  const methods = useMemo(
    () => new Set(methodsKey.split(",").filter(Boolean)),
    [methodsKey],
  );
  const serviceIds = useMemo(
    () => new Set(servicesKey.split(",").filter(Boolean)),
    [servicesKey],
  );
  const page = Math.max(0, Number.parseInt(params.get("page") ?? "0", 10) || 0);
  const bounds = useMemo(() => rangeBounds(range), [range]);

  function navigate(changes: Record<string, string | string[] | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      next.delete(key);
      if (value === null || value === "") continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        next.append(key, item);
      }
    }
    if (!("page" in changes)) next.delete("page");
    const search = next.toString();
    router.replace(search ? `${pathname}?${search}` : pathname, {
      scroll: false,
    });
  }

  return {
    params,
    range,
    bounds,
    term,
    classes,
    methods,
    serviceIds,
    noService,
    page,
    navigate,
  };
}

export type RequestsAddress = ReturnType<typeof useRequestsAddress>;

function parseRange(value: string | null): TimeRangeValue {
  return (
    [NARROW_RANGE, ...TIME_RANGES].find((each) => each.value === value)
      ?.value ?? DEFAULT_TIME_RANGE
  );
}
