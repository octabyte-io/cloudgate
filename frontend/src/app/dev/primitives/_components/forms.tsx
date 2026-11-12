"use client";

import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api/api-error";
import { Row } from "./shell";

/**
 * The backend is zod-first, so a form schema is the same shape of thing the
 * endpoint will check. The messages are written the way the backend's are —
 * about the field, in a sentence.
 */
const schema = z.object({
  name: z
    .string()
    .min(1, "Name cannot be empty.")
    .regex(/^[a-z0-9-]+$/, "Use lowercase letters, digits and dashes only."),
  domain: z.string().min(1, "Domain cannot be empty."),
});

type Values = z.infer<typeof schema>;

/** What the buttons make the fake endpoint throw. */
type Outcome = "ok" | "field" | "forbidden";

let outcome: Outcome = "ok";

async function fakeEndpoint(values: Values) {
  if (outcome === "field") {
    throw new ApiError(400, "Validation failed", {
      issues: [
        { path: "name", message: "an Application with this name already exists" },
        { path: "domain", message: "this domain is already claimed in this Environment" },
      ],
    });
  }
  if (outcome === "forbidden") {
    throw new ApiError(403, "Forbidden resource");
  }
  toast.done(`Created ${values.name}.`);
}

export function FormsGallery() {
  const form = useApiForm<Values>({
    schema,
    defaultValues: { name: "", domain: "" },
    onSubmit: fakeEndpoint,
    onError: (error) => toast.error(error),
  });

  return (
    <>
      <Row
        label="Field — label, hint, error, all wired"
        note="react-hook-form + zod. The backend's own message lands under the field it is about."
        className="block"
      >
        <FormProvider {...form}>
          <form
            onSubmit={form.submit}
            noValidate
            className="flex max-w-100 flex-col gap-4"
          >
            <Field
              name="name"
              label="Name"
              hint="Lowercase letters, digits and dashes. This becomes the container's name."
            >
              <Input placeholder="checkout-api" />
            </Field>

            <Field
              name="domain"
              label="Domain"
              hint="Where this Application answers. Cloudgate issues the certificate."
            >
              <Input placeholder="checkout.example.com" />
            </Field>

            <FormError message={form.rootError} />

            <div className="flex flex-wrap gap-2">
              <Button
                variant="pri"
                type="submit"
                onClick={() => {
                  outcome = "ok";
                }}
              >
                Create Application
              </Button>
              <Button
                variant="gh"
                type="submit"
                onClick={() => {
                  outcome = "field";
                }}
              >
                …and have the backend refuse two fields
              </Button>
              <Button
                variant="gh"
                type="submit"
                onClick={() => {
                  outcome = "forbidden";
                }}
              >
                …and have it answer 403
              </Button>
            </div>
          </form>
        </FormProvider>
      </Row>

      <Row
        label="Field — on its own, with an error handed straight in"
        note="no form around it; the gallery and one-off filters use it this way"
        className="block"
      >
        <div className="flex max-w-100 flex-col gap-4">
          <Field
            name="replicas"
            label="Replicas"
            hint="How many copies of this container Swarm keeps running."
          >
            <Input defaultValue="3" inputMode="numeric" />
          </Field>
          <Field
            name="port"
            label="Port"
            error="Port must be between 1 and 65535."
          >
            <Input defaultValue="70000" inputMode="numeric" />
          </Field>
          <Field
            name="registry"
            label="Registry credentials"
            optional
            hint="Leave empty for a public image."
          >
            <Input placeholder="ghcr-read-only" />
          </Field>
          {/* A Switch is a button, not an input, so `register` has nothing to
              attach to. Inside a form it wants react-hook-form's Controller;
              Field still owns the label, the hint and the layout. */}
          <Field
            name="deployOnPush"
            label="Deploy on push"
            hint="Every push to the tracked branch starts a Deployment."
            orientation="horizontal"
          >
            <Switch defaultChecked />
          </Field>
        </div>
      </Row>
    </>
  );
}
