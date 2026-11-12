import { useMutation } from "@tanstack/react-query";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  applicationsApi,
  type Application,
} from "@/lib/api/endpoints/applications";
import { useInvalidate } from "@/lib/api/use-invalidate";

const schema = z.object({
  zip: z.custom<File | null>(
    (value) => value instanceof File,
    "Choose a .zip of the code to upload.",
  ),
  dropBuildPath: z.string().trim(),
});
type Values = z.infer<typeof schema>;

/**
 * Upload a zip of the code and build that.
 *
 * `POST /applications/:id/drop` takes the archive as the multipart `zip` part,
 * unpacks it on the build host and sets the row to `drop` in one call — so
 * unlike every other source form, **saving is the upload**, and there is no
 * `PATCH` behind it. It does not deploy: the header's Deploy builds what was
 * unpacked. Uploading again replaces the files.
 *
 * The mutation lives here rather than in `use-application.ts` because this is
 * its one caller, and the invalidation is the ordinary Application one: the
 * upload answers the row, and the Overview re-reads it.
 */
export function DropSourceForm({
  application,
  onDone,
}: {
  application: Application;
  onDone: () => void;
}) {
  const invalidate = useInvalidate();
  const upload = useMutation({
    mutationFn: (values: { zip: File; dropBuildPath: string }) =>
      applicationsApi.uploadDrop(
        application.applicationId,
        values.zip,
        values.dropBuildPath || undefined,
      ),
    onSuccess: () =>
      invalidate.application({ applicationId: application.applicationId }),
  });

  const form = useApiForm<Values>({
    schema,
    defaultValues: {
      zip: null,
      dropBuildPath: application.dropBuildPath ?? "",
    },
    onSubmit: async (values) => {
      if (!values.zip) return;
      await upload.mutateAsync({
        zip: values.zip,
        dropBuildPath: values.dropBuildPath,
      });
      toast.done("Files uploaded.", {
        description: `The next Deployment builds ${values.zip.name}.`,
      });
      onDone();
    },
    onError: (error) => toast.error(error),
  });

  return (
    <FormProvider {...form}>
      <form method="post" noValidate onSubmit={form.submit} className="grid gap-3.5">
        <Field
          name="zip"
          label="Archive"
          manual
          hint={
            application.sourceType === "drop"
              ? "A .zip of the code. Uploading one replaces the files this Application builds from now."
              : "A .zip of the code. It is unpacked on the Server that builds this Application."
          }
        >
          <Input
            type="file"
            accept=".zip,application/zip"
            onChange={(event) =>
              form.setValue("zip", event.target.files?.[0] ?? null, {
                shouldValidate: true,
              })
            }
          />
        </Field>

        <Field
          name="dropBuildPath"
          label="Build path"
          optional
          hint="The directory inside the archive to build, such as /frontend. Leave it empty to build the archive's root."
        >
          <Input
            placeholder="/"
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-meta md:text-meta"
          />
        </Field>

        <FormError message={form.rootError} />

        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton pending={form.formState.isSubmitting}>
            Upload
          </SubmitButton>
          <Button type="button" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}
