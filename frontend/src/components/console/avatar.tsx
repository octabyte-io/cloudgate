import { useState } from "react";

import { personInitials, type Person } from "@/lib/format/person";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

export type AvatarProps = {
  person: Person & { image?: string | null };
  className?: string;
};

/**
 * A person's picture, or their initials, or the person glyph — in that order.
 *
 * The picture is the Avatar URL from Settings → Account, which is an address
 * rather than an upload (Cloudgate has nowhere to keep one), so it can be
 * anything: a 404, a host that is down, a page that is not an image. A broken
 * one falls back exactly like a missing one, and the fallback is keyed by the
 * URL that failed, so saving a different address tries again.
 *
 * **Decoration, never the only name.** Every surface that shows an avatar names
 * the person beside it or on its control, so the whole thing is `aria-hidden`
 * and the `img` has an empty `alt`: a screen reader hearing "Ursa Ownerton,
 * Ursa Ownerton" is the duplicate this avoids.
 *
 * A plain `img` rather than `next/image`: that one wants every remote host
 * listed in `next.config.ts`, and an operator's avatar can be on any host.
 * `no-referrer`, because the address is somebody else's server and the console's
 * own URLs — ids included — are not theirs to log.
 */
export function Avatar({ person, className }: AvatarProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = person.image?.trim() || null;
  const initials = personInitials(person);

  return (
    <span
      aria-hidden="true"
      data-slot="avatar"
      className={cn(
        "grid size-6 shrink-0 place-items-center overflow-hidden rounded-pill bg-raise-2 text-chip font-semibold text-tx-2",
        className,
      )}
    >
      {src && failed !== src ? (
        // eslint-disable-next-line @next/next/no-img-element -- any host, see above
        <img
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailed(src)}
          className="size-full object-cover"
        />
      ) : initials ? (
        initials
      ) : (
        <Icon name="user" size={14} />
      )}
    </span>
  );
}
