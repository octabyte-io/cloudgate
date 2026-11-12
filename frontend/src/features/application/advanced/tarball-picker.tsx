import { Chip } from "@/components/console/chip";
import { SearchInput } from "@/components/console/search-input";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import type { DestinationObject } from "@/lib/api/endpoints/destinations";
import { errorMessage } from "@/lib/api/error-message";
import { Icon } from "@/lib/design/icons";
import { timeAgo, timeExact } from "@/lib/format/time";
import { readBytes } from "@/lib/format/units";
import { cn } from "@/lib/utils";

/**
 * Which tarball to unpack — a list of what is really in the destination.
 *
 * **Picked, not typed.** Until `GET /destinations/:id/objects`
 * this step was a
 * text field for a full S3 key, and a typo in it was indistinguishable from a
 * missing object until the restore had already stopped the service. The keys are
 * derivable — a run writes `<appName>/<prefix>/<timestamp>.tar` — but not
 * guessable, because `keepLatestCount` deletes the older ones and nothing
 * outside the bucket knows which survived.
 *
 * **Newest first, and the newest one says so.** That ordering is not a
 * convenience: the difference between last night's tarball and one from three
 * weeks ago is the entire decision this step is making, and it is the only part
 * of the restore that is not recoverable afterwards. So the top row carries the
 * one marker on this screen, and every row states its size and its age rather
 * than making the timestamp in the file name do that work.
 *
 * A `Picker` popup was the other option and is the wrong control here: a bucket
 * that has been backed up nightly for a month holds thirty tarballs whose names
 * differ in one digit, which is exactly the list you cannot typeahead through.
 * It is the same reasoning that made `repository-picker.tsx` a filterable list,
 * and this borrows its shape — search row, scrolling rows, four distinct states.
 *
 * The four states are kept apart deliberately. Nothing chosen, still loading, a
 * refusal, and a genuinely empty bucket are four different sentences, and
 * collapsing any of them into "no backups" would be a claim about somebody's
 * data made because of how the request went.
 *
 * **Empty has one more cause, and it is not the bucket's.** `GET
 * /destinations/:id/objects` is filtered by the caller's Service entitlements, so a
 * bucket holding a year of tarballs answers `[]` to somebody entitled to none of the
 * Services that wrote them. So the empty state does not say the destination is empty: a
 * member who cannot see another Service's tarballs is the intended outcome, not a
 * misconfiguration for them to go and fix. The sentence has to be true of both causes,
 * which is why it names what is restorable rather than what is there.
 */
export function TarballPicker({
  objects,
  pending,
  error,
  waiting,
  fetching,
  prefix,
  onPrefixChange,
  bucket,
  value,
  onChoose,
  onRefresh,
  id,
  "aria-describedby": describedBy,
}: {
  objects: DestinationObject[] | undefined;
  pending: boolean;
  error: unknown;
  /** No destination is chosen yet, so nothing has been asked for. */
  waiting: boolean;
  /** A refresh is in flight over a listing already on screen. */
  fetching: boolean;
  /** `<appName>/<prefix>` — what the listing is narrowed to. */
  prefix: string;
  onPrefixChange: (value: string) => void;
  bucket: string | undefined;
  /** The chosen object's key, or `""`. */
  value: string;
  onChoose: (object: DestinationObject) => void;
  onRefresh: () => void;
  id?: string;
  "aria-describedby"?: string;
}) {
  const rows = objects ?? [];

  return (
    <div
      id={id}
      aria-describedby={describedBy}
      className="rounded-lg border border-line bg-panel"
    >
      <div className="flex items-center gap-2 border-b border-line p-2">
        <SearchInput
          label="Path in the bucket"
          value={prefix}
          onChange={(event) => onPrefixChange(event.target.value)}
          placeholder="storefront/"
          spellCheck={false}
          autoComplete="off"
          disabled={waiting}
          className="font-mono text-meta md:text-meta"
        />
        <Button
          size="icon-sm"
          type="button"
          onClick={onRefresh}
          disabled={waiting}
          aria-busy={fetching || undefined}
          aria-label="Refresh the listing"
          title="Refresh the listing"
        >
          <Icon name="refresh" size={14} />
        </Button>
      </div>

      <div
        role="group"
        aria-label="Tarballs in the destination"
        className="max-h-64 overflow-y-auto overscroll-contain p-1.5"
      >
        {waiting ? (
          <p className="px-2.25 py-3 text-meta text-tx-2">
            Choose a destination above and its tarballs appear here.
          </p>
        ) : pending ? (
          <div className="grid gap-1.5" aria-busy="true">
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
          </div>
        ) : error ? (
          <ListingRefusal error={error} />
        ) : rows.length === 0 ? (
          <p className="px-2.25 py-3 text-meta text-tx-2">
            {prefix.trim() === ""
              ? `Nothing here you can restore — ${bucket ?? "the bucket"} holds no tarballs for the services you can reach.`
              : `Nothing under ${prefix.trim()} you can restore. Clear the path to list the whole of ${bucket ?? "the bucket"} you can reach.`}
          </p>
        ) : (
          rows.map((object, index) => (
            <TarballRow
              key={object.key}
              object={object}
              latest={index === 0 && rows.length > 1}
              selected={object.key === value}
              onChoose={() => onChoose(object)}
            />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * The backend's own marker for a message it cut the middle out of.
 * `capFailureMessage` (`backend/src/destinations/rclone-exec.ts`) writes it as
 * `\n… <n> characters elided …\n` — **on its own line**, which is what lets
 * everything below split on lines and never on code units.
 */
const ELIDED_LINE = /^… \d+ characters elided …$/;

/**
 * Longer than this and the slot bounds the message instead of growing to hold
 * it. Four hundred code units is about five wrapped lines at `text-meta` in
 * this box — a refusal that long has stopped being a sentence and started being
 * tool output.
 */
const INLINE_LIMIT = 400;

/**
 * Why the listing did not come back — bounded, and read from whichever end has
 * something in it.
 *
 * A refusal here is usually one sentence and renders as one. It is not always:
 * `GET /destinations/:id/objects` shells out to `rclone` against somebody
 * else's S3 endpoint, and an S3 provider's `<Message>` is a tool's own words
 * and can be anything at all. One was measured at **12 000 characters**. The
 * backend caps that at 8 KB
 * and the console then rendered all 8 KB of it inline as one paragraph: 2 192 px
 * of `🐳` inside this box's 256 px, so the cap's own elision marker sat ~1 090 px
 * below the fold and the `status code: 403` the cap had deliberately kept at the
 * end was never reached.
 *
 * **The message is not the problem, so the message is not touched.** Nothing
 * here truncates, sanitises, re-encodes or reflows it — ADR-0012 §18's rule
 * about a tool's own words. What is bounded is the presentation, and its shape
 * follows what the cap kept and why (`capFailureMessage`'s own docblock: the
 * head is the diagnosis, the tail is the summary, and *"in all three the middle
 * is the part with nothing in it"*):
 *
 * - the split is on the marker's **line**, a boundary that cannot fall inside a
 *   surrogate pair. The cap steps back off a pair it would split and so can
 *   leave a lone surrogate at each end of the marker; re-cutting this string on
 *   code units is how one of those becomes U+FFFD on the screen;
 * - the marker itself sits between the two halves, verbatim, and is the one
 *   part that never scrolls out of view;
 * - the head half is read from the **top** and the tail half from the
 *   **bottom**, because that is where each half's information is — rclone
 *   writes `retry 1` first and the fatal summary last.
 *
 * Every code unit the backend sent is in the DOM, in two boxes that stop it
 * pushing the listing off the screen.
 *
 * **`role="alert"`, the way `FormError` has it.** A listing fails while the
 * reader is looking at the destination picker two fields up, so the one thing
 * the slot must not be is silent. The alert is on the outermost refusal element
 * of either shape, which for a capped message means the announcement is as long
 * as the body — the same property `FormError` has had all along, since it takes
 * arbitrary `errorMessage()` output. Bounding the *announcement* separately
 * would mean writing a summary sentence of our own to stand in front of the
 * tool's, which is the one thing this slot does not do.
 */
function ListingRefusal({ error }: { error: unknown }) {
  const message = errorMessage(error);

  // `whitespace-pre-wrap` on the short path too: a refusal the backend writes
  // as two lines is two lines here as well, for `restore-modal.tsx`'s
  // `RestoreRefusal` reasons.
  if (message.length <= INLINE_LIMIT) {
    return (
      <p
        role="alert"
        className="px-2.25 py-3 text-meta whitespace-pre-wrap wrap-anywhere text-bad"
      >
        {message}
      </p>
    );
  }

  const lines = message.split("\n");
  const at = lines.findIndex((line) => ELIDED_LINE.test(line));

  return (
    <div role="alert" className="grid gap-1.5 p-1.5">
      <RefusalHalf text={at === -1 ? message : lines.slice(0, at).join("\n")} />
      {at === -1 ? null : (
        <>
          {/* The cap's own words, and the one line of a capped message that is
              never below a fold. */}
          <p className="text-center text-chip text-tx-3">{lines[at]}</p>
          <RefusalHalf text={lines.slice(at + 1).join("\n")} fromEnd />
        </>
      )}
    </div>
  );
}

/**
 * One end of a message too long to render whole, verbatim and bounded.
 *
 * `tabIndex` because a scroll region nobody can reach with a keyboard is a
 * region whose second half nobody reads — the reason `LogWell`'s scroller
 * carries one.
 */
function RefusalHalf({
  text,
  fromEnd,
}: {
  text: string;
  /** Open at the bottom: this half's summary line is its last one. */
  fromEnd?: boolean;
}) {
  return (
    <div
      data-slot="refusal-half"
      /*
        A DOM write rather than a state update, the way `LogWell` writes its
        tail: this is a scroll position, and nothing else on the screen reads
        it. eslint bans setState-in-effect (§3.9) and this needs neither.
      */
      ref={(node) => {
        if (node && fromEnd) node.scrollTop = node.scrollHeight;
      }}
      tabIndex={0}
      className="max-h-20 overflow-y-auto overscroll-contain rounded-md border border-bad-line bg-bad-tint px-2.5 py-2 text-meta whitespace-pre-wrap wrap-anywhere text-bad"
    >
      {text}
    </div>
  );
}

function TarballRow({
  object,
  latest,
  selected,
  onChoose,
}: {
  object: DestinationObject;
  latest: boolean;
  selected: boolean;
  onChoose: () => void;
}) {
  // The file name is what tells two tarballs apart; the directory above it is
  // the same for every row in a narrowed listing, so it goes underneath.
  const name = object.key.split("/").pop() ?? object.key;
  const written = timeAgo(object.lastModified);

  return (
    <button
      type="button"
      onClick={onChoose}
      aria-pressed={selected}
      title={object.key}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.25 py-1.75 text-left transition-colors duration-100 hover:bg-raise",
        selected && "bg-brand-tint",
      )}
    >
      <Icon
        name={selected ? "check" : "box"}
        size={15}
        className={cn("flex-none", selected ? "text-brand-tx" : "text-tx-3")}
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate font-mono text-meta tracking-mono",
            selected ? "font-medium text-brand-tx" : "text-tx",
          )}
        >
          {name}
        </span>
        <span className="mt-0.5 block truncate text-chip font-normal text-tx-3">
          {readBytes(object.size)}
          {written ? (
            <>
              {" · "}
              <span title={timeExact(object.lastModified)}>{written}</span>
            </>
          ) : null}
        </span>
      </span>
      {latest ? (
        <Chip variant="brand" className="flex-none">
          Newest
        </Chip>
      ) : null}
    </button>
  );
}
