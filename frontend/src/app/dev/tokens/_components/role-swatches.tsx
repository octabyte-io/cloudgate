"use client";

import { tokenHex } from "@/lib/design/contrast";
import { cn } from "@/lib/utils";
import type { RoleGroup } from "../_lib/rows";
import { useMeasured } from "../_lib/use-measured";
import { Label, Mono } from "./section";

/**
 * A role, shown three ways at once: the fill, text sitting on that fill, and
 * what the browser actually painted. The third one is the useful part — the
 * surface ladder is deliberately subtle, `--info` is declared as
 * `var(--brand-tx)`, and reading the pixel back is the only way to see either.
 */
export function RoleSwatches({ group }: { group: RoleGroup }) {
  const painted = useMeasured<Record<string, string | null>>(
    () =>
      Object.fromEntries(
        group.roles.map((role) => [role.token, tokenHex(role.token)]),
      ),
    {},
  );

  return (
    <div className="flex flex-col gap-3">
      <Label>
        Declared in oklch; the figure on the right is the sRGB this browser
        painted.
      </Label>
      <ul className="flex flex-col gap-2">
        {group.roles.map((role) => (
          <li
            key={role.token}
            className="flex flex-wrap items-center gap-x-3 gap-y-2"
          >
            <span
              className={cn(
                "inline-grid h-ctl w-32 place-items-center rounded-md border border-line text-ui",
                // The hatch is a pattern, not a colour — flattening it to a
                // swatch would misrepresent the one thing it means.
                role.token === "--hatch" ? "hatch bg-panel" : role.fillClass,
                role.onClass,
              )}
            >
              Aa · 1,204
            </span>
            <Mono className="text-tx">{role.token}</Mono>
            {role.note ? (
              <span className="text-meta text-tx-3">{role.note}</span>
            ) : null}
            <Mono className="ml-auto text-tx-3">
              {painted[role.token] ?? "not measured"}
            </Mono>
          </li>
        ))}
      </ul>
    </div>
  );
}
