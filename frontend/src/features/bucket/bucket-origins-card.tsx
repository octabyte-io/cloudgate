import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";

import { Card } from "@/components/console/card";
import { Field, FormError } from "@/components/console/field";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/error-message";
import { bucketsApi, type Bucket } from "@/lib/api/endpoints/buckets";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { usePermission } from "@/lib/auth/use-permission";

/** Why the controls are off, for a role the route would refuse. */
export const ORIGINS_REFUSAL =
  "Your role cannot change this bucket's origins — that needs service update.";

/**
 * The web origins trusted to upload to a bucket straight from a browser
 * this Environment's alone, Cloudgate's and never the Project
 * config's. Empty by default, so no browser uploads until one is added.
 *
 * Adding or removing one sends the whole list as it then stands
 * (`PUT /buckets/:id/origins`, `service: ['update']`). Whether an entry is
 * a web origin is the server's to say: its refusal names the origin and is
 * shown as it is.
 */
export function BucketOriginsCard({ bucket }: { bucket: Bucket }) {
  const invalidate = useInvalidate();
  const canUpdate = usePermission({ service: ["update"] });
  const [draft, setDraft] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const refusalId = useId();

  const put = useMutation({
    mutationFn: (origins: string[]) =>
      bucketsApi.putOrigins(bucket.bucketId, origins),
    onSettled: () => invalidate.bucket(bucket.bucketId),
  });
  const locked = !canUpdate.allowed || put.isPending;

  async function write(origins: string[], done: string): Promise<boolean> {
    if (!canUpdate.allowed) {
      setRefusal(ORIGINS_REFUSAL);
      return false;
    }
    setRefusal(null);
    try {
      await put.mutateAsync(origins);
      toast.done(done);
      return true;
    } catch (error) {
      setRefusal(errorMessage(error));
      return false;
    }
  }

  async function add(event: React.SubmitEvent) {
    event.preventDefault();
    const origin = draft.trim();
    if (origin === "" || put.isPending) return;
    if (bucket.origins.includes(origin)) {
      setDraft("");
      return;
    }
    if (await write([...bucket.origins, origin], `${origin} can upload.`)) {
      setDraft("");
    }
  }

  return (
    <Card>
      <Card.Header
        title="Browser uploads"
        sub="Web origins trusted to upload to this bucket straight from a browser, in this Environment only."
        headingLevel={2}
      />
      <Card.Body className="grid gap-3.5">
        {bucket.origins.length === 0 ? (
          <p className="text-body text-tx-2">
            No origin is trusted, so no browser can upload to this bucket.
          </p>
        ) : (
          <ul className="grid gap-1.5" aria-label="Trusted origins">
            {bucket.origins.map((origin) => (
              <li
                key={origin}
                className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2"
              >
                <span className="min-w-0 truncate font-mono text-body">
                  {origin}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={locked}
                  title={canUpdate.allowed ? undefined : ORIGINS_REFUSAL}
                  aria-label={`Remove ${origin}`}
                  onClick={() =>
                    void write(
                      bucket.origins.filter((one) => one !== origin),
                      `${origin} can no longer upload.`,
                    )
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form
          method="post"
          noValidate
          onSubmit={add}
          className="flex flex-wrap items-end gap-2"
        >
          <Field
            name="origin"
            label="Origin"
            hint="As a browser sends it: scheme://host or scheme://host:port, with no path."
            className="min-w-0 flex-1"
          >
            <Input
              value={draft}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://app.example.com"
              className="font-mono"
              onChange={(event) => setDraft(event.target.value)}
            />
          </Field>
          <Button
            type="submit"
            disabled={locked || draft.trim() === ""}
            title={canUpdate.allowed ? undefined : ORIGINS_REFUSAL}
            aria-describedby={canUpdate.allowed ? undefined : refusalId}
          >
            Add origin
          </Button>
        </form>

        <FormError message={refusal ?? undefined} />
        {canUpdate.allowed ? null : (
          <p id={refusalId} className="text-meta text-tx-2">
            {ORIGINS_REFUSAL}
          </p>
        )}
      </Card.Body>
      <Card.Footer>
        Each origin may read, upload and see an upload&rsquo;s ETag. A
        bucket&rsquo;s own key is never sent to a browser.
      </Card.Footer>
    </Card>
  );
}
