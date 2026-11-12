import { useId, useState } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { lockedProps } from "@/components/console/resource-field";
import { PasswordInput } from "@/components/console/password-input";
import { SubmitButton } from "@/components/console/submit-button";
import {
  TestResult,
  testDetails,
  type TestOutcome,
} from "@/components/console/test-result";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  applicationsApi,
  type Application,
  type UpdateApplicationInput,
} from "@/lib/api/endpoints/applications";
import { errorMessage } from "@/lib/api/error-message";
import { redactSecrets } from "@/lib/format/redact";

const schema = z.object({
  dockerImage: z.string().trim().min(1, "Name the image to run."),
  registryUrl: z.string().trim(),
  username: z.string().trim(),
  password: z.string(),
});
type Values = z.infer<typeof schema>;

/**
 * Run an image somebody else built.
 *
 * There is no build here at all — the deployment pulls the reference and updates
 * the Swarm service — which is why this form is four fields and no builder, and
 * why the Build card says so rather than offering a `buildType` that nothing
 * would read.
 *
 * **The password is write-only.** `applications.service.ts` never sends it back
 * (`encryptedText`, stripped from the read), so the field starts empty on an
 * Application that plainly has one. Leaving it empty therefore has to mean *keep
 * the stored one* rather than *clear it*, and the hint says which — otherwise
 * saving a changed image would silently drop the credential that pulls it.
 *
 * **"Test connection" asks the registry before a Deployment does**
 * A wrong password
 * used to save without a word and fail at the pull. The test logs in with the
 * hostname and username on screen and the password typed — or, left empty, the
 * stored one, but only while the hostname and username are still the saved ones
 * — on the build host, where the pull logs in. A refusal is the registry's own sentence.
 * It sits beside Save rather than inside it: a registry that is down for a
 * minute is no reason to refuse a save.
 */
export function DockerSourceForm({
  application,
  save,
  onDone,
  locked,
}: {
  application: Application;
  save: (input: UpdateApplicationInput) => Promise<unknown>;
  onDone: () => void;
  /** Why the image is not this form's to change; the registry login stays. */
  locked?: string;
}) {
  const form = useApiForm<Values>({
    schema,
    defaultValues: {
      dockerImage: application.dockerImage ?? "",
      registryUrl: application.registryUrl ?? "",
      username: application.username ?? "",
      password: "",
    },
    onSubmit: async (values) => {
      await save({
        sourceType: "docker",
        dockerImage: values.dockerImage,
        registryUrl: values.registryUrl || null,
        username: values.username || null,
        // Empty means "leave the stored credential alone", so it is omitted
        // rather than sent as null.
        ...(values.password === "" ? {} : { password: values.password }),
      });
      toast.done("Source saved.", {
        description: `The next Deployment pulls ${values.dockerImage}.`,
      });
      onDone();
    },
    onError: (error) => toast.error(error),
  });

  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestOutcome | null>(null);
  const blockedId = useId();
  const [registryUrl, username, password] = form.watch([
    "registryUrl",
    "username",
    "password",
  ]);
  // Only a private image has a login to test, so the button waits for a
  // username rather than sitting disabled under every public one.
  const testable = username.trim() !== "";
  // `application.username` is the stand-in for "a password is stored", the
  // same one the hint below reads: the password itself never comes back.
  //
  // And the stored password is only ever tested against the hostname and
  // username it was saved with — the backend refuses anything else, because
  // it would otherwise hand the secret to whatever host was typed.
  const changedLogin =
    registryUrl.trim() !== (application.registryUrl ?? "") ||
    username.trim() !== (application.username ?? "");
  const blocked =
    !testable || password
      ? null
      : !application.username
        ? "Fill in the password and the test logs in with it. None is stored yet, so there is nothing else to log in with."
        : changedLogin
          ? "The stored password is only tested against the registry and username it was saved with. Type the password to test these values."
          : null;

  async function testLogin() {
    if (!testable || blocked !== null || testing) return;
    setResult(null);
    setTesting(true);
    const where = registryUrl.trim() || "Docker Hub";
    try {
      await applicationsApi.testRegistryLogin(application.applicationId, {
        registryUrl: registryUrl.trim() || null,
        username: username.trim(),
        ...(password === "" ? {} : { password }),
      });
      setResult({
        ok: true,
        message: password
          ? `${where} accepted ${username.trim()} with the password you typed.`
          : `${where} accepted ${username.trim()} with the password already stored.`,
      });
    } catch (error) {
      const said = errorMessage(error);
      const details = testDetails(error);
      setResult({
        ok: false,
        // Last pass before a shared screen; nothing the route answers should
        // hold the password in the first place.
        message: redactSecrets(said, [password]),
        details:
          details === undefined ? undefined : redactSecrets(details, [password]),
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <FormProvider {...form}>
      <form method="post" noValidate onSubmit={form.submit} className="grid gap-3.5">
        <Field
          name="dockerImage"
          label="Image"
          hint="The reference to pull, tag included — postgres:17.2, ghcr.io/acme/api:sha-4f2a1c."
        >
          <Input
            placeholder="ghcr.io/acme/api:latest"
            {...lockedProps(locked)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-meta md:text-meta"
          />
        </Field>

        <Field
          name="registryUrl"
          label="Registry"
          optional
          hint="Leave it empty for Docker Hub. Set it for a private registry the image lives in."
        >
          <Input
            placeholder="ghcr.io"
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-meta md:text-meta"
          />
        </Field>

        <Field
          name="username"
          label="Registry username"
          optional
          hint="Only needed for a private image."
        >
          <Input autoComplete="off" spellCheck={false} />
        </Field>

        <Field
          name="password"
          label="Registry password or token"
          optional
          hint={
            application.username
              ? "A password is already stored. Leave this empty to keep it, or type a new one to replace it."
              : "Stored encrypted, and never sent back to this screen."
          }
        >
          <PasswordInput autoComplete="new-password" />
        </Field>

        <FormError message={form.rootError} />

        {blocked ? (
          <p id={blockedId} className="text-meta text-tx-2">
            {blocked}
          </p>
        ) : null}
        {result ? <TestResult result={result} /> : null}

        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton pending={form.formState.isSubmitting}>
            Save source
          </SubmitButton>
          {testable ? (
            <Button
              type="button"
              onClick={testLogin}
              disabled={blocked !== null || testing}
              aria-busy={testing || undefined}
              aria-describedby={blocked ? blockedId : undefined}
            >
              Test connection
            </Button>
          ) : null}
          <Button type="button" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}
