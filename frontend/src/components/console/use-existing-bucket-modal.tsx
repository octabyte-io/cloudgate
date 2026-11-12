import { useMutation, useQuery } from "@tanstack/react-query";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Skeleton } from "@/components/console/skeleton";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { bucketsApi } from "@/lib/api/endpoints/buckets";
import { errorMessage } from "@/lib/api/error-message";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";
import { example } from "@/components/console/form-spec";

/** `POST /buckets/existing` is `service: ['create']`, as any create. */
export const USE_EXISTING_BUCKET_REFUSAL = roleRefusal(
  "use an existing bucket for a Service",
);

// An S3 name on AWS, a Cloud Storage one on Google Cloud, which may
// hold underscores: the backend checks which the Cloud account takes.
const schema = z.object({
  bucketName: z
    .string()
    .trim()
    .regex(
      /^(?=.{3,222}$)[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
      "A bucket name: lowercase letters, digits, dots and hyphens (and underscores on Google Cloud).",
    ),
});
type Values = z.infer<typeof schema>;

/**
 * "Use an existing bucket" (ADR-0033): an Environment's `bucket`
 * entry stands for an S3 bucket the operator already has, named here,
 * without the Project config changing. Opened from the plan row that would
 * create the entry. Once saved, the next plan looks the bucket up instead
 * of creating one; Cloudgate never changes it — no CORS, versioning or
 * encryption — and its Delete leaves it and its files as they were.
 */
export function UseExistingBucketModal({
  open,
  onOpenChange,
  environmentId,
  configName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  configName: string;
}) {
  const invalidate = useInvalidate();
  const allowed = usePermission({ service: ["create"] });
  const { organizationId } = useActiveOrganizationId();
  // On Google Cloud: the grant a bucket in another project needs.
  const reach = useQuery({
    queryKey: keys.environments.existingReach(
      organizationId,
      environmentId,
      "bucket",
    ),
    queryFn: () => bucketsApi.existingReach(environmentId),
    enabled: open && organizationId !== null,
  });
  // Which cloud's words fit is known only once `reach` answers (CODING_STANDARDS
  // §3.5): a refusal or a wait is neither S3's nor Cloud Storage's.
  const google = reach.data?.google ?? null;
  const cloud = reach.error
    ? null
    : reach.isPending
      ? null
      : google
        ? "gcp"
        : "aws";
  const create = useMutation({
    mutationFn: (values: Values) =>
      bucketsApi.createExisting({ environmentId, configName, ...values }),
    onSuccess: async () => {
      await invalidate.environment({ environmentId });
      await invalidate.environmentPlan(environmentId);
    },
  });
  const form = useApiForm<Values>({
    schema,
    defaultValues: { bucketName: "" },
    onSubmit: async (values) => {
      if (!allowed.allowed) {
        form.setError("root", {
          type: "manual",
          message: USE_EXISTING_BUCKET_REFUSAL,
        });
        return;
      }
      await create.mutateAsync(values);
      toast.done(`${configName} uses ${values.bucketName}.`, {
        description:
          "Check for changes: the next plan looks it up instead of creating one.",
      });
      onOpenChange(false);
    },
    onError: (error) => toast.error(error),
  });

  const typed = form.watch("bucketName")?.trim() || "<bucket>";

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={`Use an existing bucket for ${configName}`}
        description={
          cloud === "gcp"
            ? "A Cloud Storage bucket you already have, in any project and location. Cloudgate looks it up at every plan and never changes it or its files, and its Delete leaves it as it was. The Project config does not change."
            : cloud === "aws"
              ? "An S3 bucket you already have, in this Environment's Cloud account and region. Cloudgate looks it up at every plan and never changes it or its files, and its Delete leaves it as it was. The Project config does not change."
              : "A bucket you already have. Cloudgate looks it up at every plan and never changes it or its files, and its Delete leaves it as it was. The Project config does not change."
        }
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Modal.Body>
            <Field
              name="bucketName"
              label="Bucket name"
              hint={`As the ${cloud === "gcp" ? "Cloud Storage" : cloud === "aws" ? "S3" : "cloud's"} console lists it, e.g. acme-prod-uploads. A bucket Cloudgate made, for any Environment, is refused.`}
            >
              <Input placeholder={example("acme-prod-uploads")} autoComplete="off" />
            </Field>
            {reach.error ? (
              <p
                role="alert"
                className="mt-3.5 flex gap-2 text-meta wrap-anywhere text-tx-2"
              >
                <Icon name="alert" className="mt-0.5 flex-none text-bad" />
                {errorMessage(reach.error)}
              </p>
            ) : reach.isPending ? (
              <Skeleton className="mt-3.5 h-16 w-full rounded-lg" />
            ) : google ? (
              <div className="mt-3.5 grid gap-1 rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-meta text-tx-2">
                <p className="font-medium text-tx">
                  Reached by a key of its own, which you grant access
                </p>
                <p>
                  The Apply makes {configName}&apos;s own service account and
                  HMAC key, shared by every Service linking it. Cloudgate never
                  adds a grant on your bucket: its page then shows the exact
                  line that grants the key access, and says &quot;waiting for
                  access&quot; until it works. Linked Services deploy at once.
                </p>
                <p>
                  In another project than{" "}
                  <span className="font-mono">{google.projectId}</span>, let
                  Cloudgate read it so every plan can look it up:{" "}
                  <span className="font-mono break-all">
                    {google.readGrant.replace("<bucket>", typed)}
                  </span>
                </p>
              </div>
            ) : (
              <p className="mt-3.5 text-meta text-tx-2">
                Services linking it get the same Outputs and the same access as
                with a bucket Cloudgate makes: their task role reads and writes
                its objects. Its CORS stays yours, set in AWS.
              </p>
            )}
            {form.rootError ? <FormError message={form.rootError} /> : null}
          </Modal.Body>
          <Modal.Footer>
            <Modal.Close render={<Button type="button">Cancel</Button>} />
            <SubmitButton pending={form.formState.isSubmitting}>
              Use this bucket
            </SubmitButton>
          </Modal.Footer>
        </form>
      </FormProvider>
    </Modal>
  );
}
