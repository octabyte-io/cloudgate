import { Chip } from "@/components/console/chip";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { ComposeDetail } from "@/lib/api/endpoints/compose";
import { Icon } from "@/lib/design/icons";

import { useComposeServices } from "../use-compose";
import { composeFileIsEmpty } from "./yaml-check";

/**
 * What the platform reads out of the file: the service names it declares.
 *
 * `GET /compose/:id/services` is the only route that says anything about a compose
 * file's *contents*, and its states say genuinely different things — which is the
 * whole reason this is a component rather than a `.map`:
 *
 * - **A refusal**, for a git source that has never been deployed. The route
 *   `cat`s the clone on the build Server, and there is no clone until a Deployment
 *   has made one, so the shell-out fails and Nest answers 500. That is not "no
 *   services" and it is not broken; it is "nothing has been cloned yet", and the
 *   sentence says so.
 * - **Empty**, which for a `raw` file splits in two, and saying only the first
 *   half of it was a past defect.
 *   A file that *parses* and declares no services is a readable file with
 *   nothing in it to deploy — the deploy refuses it by that name now, where it used
 *   to reach Docker and come back as `no service selected`. A file nothing has
 *   been written to is a different sentence: this route is the only one
 *   in the platform that accepts it — it answers `[]` — while
 *   `GET /compose/:id/converted` and the deploy both stop at
 *   `Compose file is empty`, because `parseComposeFile("")` is `null`. It is
 *   also the state every stack is in for its entire first visit, so it is the
 *   sentence most people read first. `composeFileIsEmpty` tells the two apart
 *   off the column this screen is already holding — no extra read.
 * - **Names**, the useful case — and it is *the file's* answer, not Docker's.
 *   Whether any of them is running is the Containers tab, and the two disagreeing
 *   is the most interesting thing this screen can show.
 */
export function DeclaredServices({ compose }: { compose: ComposeDetail }) {
  const services = useComposeServices(compose.composeId);
  const raw = compose.sourceType === "raw";
  const empty = raw && composeFileIsEmpty(compose.composeFile);
  const rows = services.data ?? [];

  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="text-meta font-medium text-tx-2">
          Services in this file
        </span>
        {services.isPending ? (
          <Skeleton className="h-3.5 w-40" />
        ) : services.error ? null : rows.length > 0 ? (
          <>
            {rows.map((name) => (
              <Chip key={name} variant="mono">
                {name}
              </Chip>
            ))}
            <span className="text-meta text-tx-3">
              {rows.length === 1 ? "1 service" : `${rows.length} services`}
            </span>
          </>
        ) : (
          <span className="text-meta text-tx-2">
            {empty
              ? "Nothing to read yet — write the file above."
              : raw
                ? "None — the file parses and declares no services, so there is nothing to deploy."
                : "None came back."}
          </span>
        )}
        <Button
          size="xs"
          className="ml-auto"
          onClick={() => void services.refetch()}
          aria-busy={services.isFetching || undefined}
        >
          <Icon name="refresh" size={14} />
          Re-read
        </Button>
      </div>

      {/**
       * The refusal, in the words this screen can be sure of.
       *
       * **`errorMessage` is deliberately not the whole sentence for a git
       * source.** Its 500 reads "the backend hit an error handling that", which
       * is written for a mutation and says nothing useful here: the route did
       * not fail so much as find no file, because it `cat`s the clone and a stack
       * that has never deployed has no clone. This screen knows that and the
       * generic sentence does not. A `raw` source is the other way round — the
       * only way that path fails is an unparsable file, where the parser's own
       * complaint is the answer and the editor above has already made it.
       */}
      {services.error ? (
        <p className="mt-2 text-meta text-tx-2">
          {raw
            ? `${errorMessage(services.error)} A file that is not valid YAML fails here too — the editor above says so if that is what happened.`
            : "Cloudgate reads this out of the clone on the deploy target, and there is nothing there until this stack has been deployed once. Deploy it, then re-read."}
        </p>
      ) : null}
    </div>
  );
}
