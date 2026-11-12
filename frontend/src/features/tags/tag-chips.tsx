import { Chip } from "@/components/console/chip";
import { Dash } from "@/components/console/dash";
import { Skeleton } from "@/components/console/skeleton";
import type { Tag } from "@/lib/api/endpoints/tags";

/**
 * A Project's Tags, as chips.
 *
 * Three states and they are all different sentences: a Skeleton while the
 * request is out, "None" once we know there are none, and the chips. A blank
 * cell would say "none" a request too early, which is the same mistake F07's
 * `CountTile` was built to stop.
 *
 * **The chips are not painted from `tag.color`.** The column exists and holds a
 * hex string, and nothing here reads it: an arbitrary hex has no promise about
 * contrast in either theme, let alone both, and the design system's rule is that
 * a hue never carries meaning on its own — the word on the chip is the Tag. Our
 * create form does not offer a colour either, so the column stays null rather
 * than filling with values nothing renders.
 */
export function TagChips({
  tags,
  /** More than this and the rest become "+3". A Project can carry many. */
  limit = 3,
}: {
  tags: Tag[] | undefined;
  limit?: number;
}) {
  if (tags === undefined) return <Skeleton className="h-chip w-20" />;
  if (tags.length === 0) return <Dash word="No tags" />;

  const shown = tags.slice(0, limit);
  const rest = tags.length - shown.length;
  // The overflow chip's names, for a pointer (`title`) and a screen reader,
  // which never hears a title.
  const hidden = tags
    .slice(limit)
    .map((tag) => tag.name)
    .join(", ");

  return (
    <span className="flex flex-wrap items-center gap-1">
      {/* A Tag's name has no length limit, so a chip stops at a measure and
          ends in an ellipsis rather than widening the column. */}
      {shown.map((tag) => (
        <Chip key={tag.tagId} title={tag.name} className="max-w-40">
          <span className="min-w-0 truncate">{tag.name}</span>
        </Chip>
      ))}
      {rest > 0 ? (
        <Chip title={hidden}>
          +{rest}
          <span className="sr-only">: {hidden}</span>
        </Chip>
      ) : null}
    </span>
  );
}
