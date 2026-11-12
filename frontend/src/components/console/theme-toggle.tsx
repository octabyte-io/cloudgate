"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";

import { Segmented, type SegmentedOption } from "@/components/console/segmented";

/** Never subscribes; the point is that the server snapshot differs from the client's. */
const NEVER = () => () => {};

type ThemeChoice = "light" | "dark" | "system";

const CHOICES: SegmentedOption<ThemeChoice>[] = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "system", label: "System", icon: "monitor" },
];

/**
 * Appearance. Lives in the avatar menu, where the reference keeps it
 * (e-console.html:2272-2280). Exported for F05's masthead; renders on its own
 * anywhere, which is how the token gallery proves both palettes.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  // The server cannot know which theme this visitor chose, so nothing is marked
  // selected until the client has read it back. Rendering `false` on the server
  // and `true` after hydration is exactly what useSyncExternalStore is for.
  const mounted = useSyncExternalStore(
    NEVER,
    () => true,
    () => false,
  );

  return (
    <Segmented
      label="Appearance"
      options={CHOICES}
      value={mounted ? ((theme ?? "system") as ThemeChoice) : null}
      onChange={setTheme}
      className={className}
    />
  );
}
