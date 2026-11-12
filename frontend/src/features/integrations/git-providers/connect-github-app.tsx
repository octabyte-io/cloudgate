import { useState } from "react";

import { Card } from "@/components/console/card";
import { Field } from "@/components/console/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { gitProviderOauthApi } from "@/lib/api/endpoints/git-providers";
import { errorMessage } from "@/lib/api/error-message";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { example } from "@/components/console/form-spec";

/**
 * Submits a real form to github.com, because GitHub's app-manifest flow is
 * defined as a form POST: the response is github.com's own app-creation page,
 * pre-filled from the manifest, and no `fetch` can put a person in front of it.
 *
 * Built imperatively rather than rendered, so there is no render pass between
 * having the manifest and leaving the page — a hidden `<form>` in the tree would
 * need a ref, an effect and a reason to trust that both ran.
 */
function postManifestToGithub(action: string, manifest: unknown): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = action;
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = "manifest";
  field.value = JSON.stringify(manifest);
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
}

/**
 * **The one-press path.** Cloudgate describes the app it wants — the permissions,
 * the events and the three URLs on this instance that GitHub must call — GitHub
 * shows you that app for approval, and the private key, client secret and webhook
 * secret come back to Cloudgate without ever being on screen.
 *
 * The connection row is created *before* the trip, which is why the name is asked
 * for here: the state GitHub hands back has to name a row that already exists.
 * That also means a trip abandoned at github.com leaves an empty connection
 * behind. It is listed rather than hidden and can be removed or completed.
 */
export function ConnectGithubApp({ onDone }: { onDone: () => Promise<unknown> }) {
  const [name, setName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [pending, setPending] = useState(false);
  // Two messages, because they are two different things and the design system's
  // rule is that nothing does double duty: a missing name belongs under the Name
  // field, and a refusal from the backend belongs where the action was pressed.
  const [nameError, setNameError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  // `POST /git-providers/oauth/github/manifest` is `gitProviders: ['create']`
  // off, with the reason, for a role that would only meet the 403.
  const canCreate = usePermission({ gitProviders: ["create"] });

  const submit = async () => {
    const trimmed = name.trim();
    setRefusal(null);
    if (trimmed === "") {
      setNameError("Give this connection a name first.");
      return;
    }
    setNameError(null);
    setPending(true);
    try {
      const started = await gitProviderOauthApi.startGithubApp({
        name: trimmed,
        organizationName: organizationName.trim() || undefined,
      });
      // The empty row is already saved, so the list behind us is out of date
      // whether or not the person comes back.
      await onDone();
      postManifestToGithub(started.action, started.manifest);
    } catch (error) {
      setRefusal(errorMessage(error));
      setPending(false);
    }
  };

  return (
    <Card tone="plain">
      <Card.Header
        title="Create the GitHub App for me"
        // The app asks for read on contents and metadata, write on pull
        // requests (preview comments), and push and pull_request events
        // pointed at this instance; GitHub lists all of it before creating it.
        sub="GitHub shows you the app Cloudgate needs before creating it, and sends its private key straight back here."
        headingLevel={3}
      />
      <Card.Body className="grid gap-3">
        <div className="grid gap-3 md:grid-cols-2">
          <Field
            name="githubAppConnectionName"
            label="Name this connection"
            hint="What it is called in Cloudgate. Only you see it."
            error={nameError ?? undefined}
          >
            <Input
              value={name}
              placeholder={example("Acme on GitHub")}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field
            name="githubAppOrganization"
            label="GitHub organization"
            optional
            hint="Leave it empty to create the app under your own GitHub account."
          >
            <Input
              value={organizationName}
              placeholder={example("octabyte-io")}
              className="font-mono"
              onChange={(event) => setOrganizationName(event.target.value)}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* `pri` is the brand fill, and this is the one action on the card. */}
          <Button
            type="button"
            variant="pri"
            disabled={pending || !canCreate.allowed}
            title={canCreate.allowed ? undefined : CREATE_REFUSAL}
            aria-busy={pending || undefined}
            onClick={() => canCreate.allowed && void submit()}
          >
            {pending ? "Taking you to GitHub…" : "Create the app on GitHub"}
          </Button>
          <p className="min-w-0 flex-1 basis-60 text-meta text-tx-2">
            You will be asked to install the app on an account before it can
            reach any repository. Already have an App? Use{" "}
            <strong className="font-medium text-tx">Connect GitHub</strong>{" "}
            below and paste its credentials instead.
          </p>
        </div>
        {refusal ? (
          <p
            role="alert"
            className="rounded-md border border-bad-line bg-bad-tint px-3 py-2.5 text-meta wrap-anywhere text-tx"
          >
            {refusal}
          </p>
        ) : null}
      </Card.Body>
    </Card>
  );
}

const CREATE_REFUSAL = roleRefusal("connect a git provider");
