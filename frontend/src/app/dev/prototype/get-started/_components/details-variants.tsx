"use client";

import { useState } from "react";
import { FormProvider, useForm, useWatch } from "react-hook-form";

import { Card } from "@/components/console/card";
import { Tabs } from "@/components/console/tabs";
import { Field } from "@/components/console/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProjectChoice } from "@/features/templates/project-choice";
import { AskedField, DomainHostFields } from "@/features/templates/setup-fields";
import { NEW_PROJECT } from "@/features/templates/use-templates";

import { ASKED, BOUGHT, DOMAINS, GENERATED, PROJECTS } from "./fixtures";

type Values = {
  values: string[];
  hosts: string[];
  projectName: string;
  setupName: string;
};

/**
 * Step two at parity with a Template setup: the asked values, each
 * Domain's host (generated, or the person's own with its A record and
 * Check DNS, from `DomainHostFields`), the Project (new by default) and
 * the setup's name. `folded` puts the last two behind More options.
 */
export function DetailsCard({ folded }: { folded: boolean }) {
  const form = useForm<Values>({
    defaultValues: {
      values: ASKED.map((input) => input.default ?? ""),
      hosts: DOMAINS.map((domain) => GENERATED[domain.name as "flatnotes"]),
      projectName: "flatnotes",
      setupName: "flatnotes",
    },
  });
  const [projectId, setProjectId] = useState<string>(NEW_PROJECT);
  const [more, setMore] = useState(!folded);
  const projectName = useWatch({ control: form.control, name: "projectName" });
  const setupName = useWatch({ control: form.control, name: "setupName" });
  const where =
    projectId === NEW_PROJECT
      ? `A new Project, ${projectName || "unnamed"}`
      : `The ${PROJECTS.find((p) => p.projectId === projectId)?.name} Project`;

  const placeFields = (
    <div className="grid gap-4">
      <ProjectChoice
        projects={PROJECTS}
        pending={false}
        value={projectId}
        onChange={setProjectId}
      />
      {projectId === NEW_PROJECT ? (
        <Field name="projectName" label="Project name" className="max-w-md">
          <Input autoComplete="off" />
        </Field>
      ) : null}
      <Field
        name="setupName"
        label="Setup name"
        hint="What this setup is called in the Project. Letters, digits and dashes."
        className="max-w-md"
      >
        <Input autoComplete="off" spellCheck={false} className="font-mono text-meta md:text-meta" />
      </Field>
    </div>
  );

  return (
    <FormProvider {...form}>
      <Card>
        <Card.Header
          title="A few details for flatnotes"
          sub="Passwords and keys it needs are made for you."
          headingLevel={2}
        />
        <Card.Body className="grid gap-5">
          <section aria-labelledby="d-app" className="grid gap-3">
            <h3 id="d-app" className="text-body font-medium text-tx">
              Sign-in
            </h3>
            {ASKED.map((input, at) => (
              <AskedField key={input.name} input={input} at={at} />
            ))}
          </section>
          <section aria-labelledby="d-web" className="grid gap-3 border-t border-line pt-4">
            <h3 id="d-web" className="text-body font-medium text-tx">
              Web address
            </h3>
            <DomainHostFields domains={DOMAINS} generated={GENERATED} cloud={null} />
          </section>
          <section aria-labelledby="d-where" className="grid gap-3 border-t border-line pt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div className="grid min-w-0 gap-0.5">
                <h3 id="d-where" className="text-body font-medium text-tx">
                  Where it goes
                </h3>
                {folded && !more ? (
                  <p className="text-ui wrap-anywhere text-tx-2">
                    {where}, on {BOUGHT.name}, set up as{" "}
                    <span className="font-mono text-meta">{setupName}</span>.
                  </p>
                ) : null}
              </div>
              {folded ? (
                <Button
                  variant="qt"
                  size="sm"
                  aria-expanded={more}
                  onClick={() => setMore((now) => !now)}
                >
                  {more ? "Fewer options" : "More options"}
                </Button>
              ) : null}
            </div>
            {more ? <div className={folded ? "animate-rise" : undefined}>{placeFields}</div> : null}
          </section>
        </Card.Body>
        <Card.Footer className="flex flex-wrap items-center gap-2.5">
          <Button variant="pri" type="button">
            Deploy flatnotes
          </Button>
          <Button variant="qt" type="button">
            Use a different server
          </Button>
        </Card.Footer>
      </Card>
    </FormProvider>
  );
}

/**
 * Step two's two open layouts, as tabs: A shows every field; B keeps the
 * asked values and the web address in view and folds the Project and the
 * setup name behind More options, with their defaults said in one line.
 */
export function DetailsVariants() {
  return (
    <Tabs defaultValue="a">
      <Tabs.Bar aria-label="Step two layouts">
        <Tabs.Tab value="a">A · Everything visible</Tabs.Tab>
        <Tabs.Tab value="b">B · Project and name under More options</Tabs.Tab>
      </Tabs.Bar>
      <Tabs.Panel value="a" className="pt-6">
        <div className="mx-auto max-w-3xl">
          <DetailsCard folded={false} />
        </div>
      </Tabs.Panel>
      <Tabs.Panel value="b" className="pt-6">
        <div className="mx-auto max-w-3xl">
          <DetailsCard folded />
        </div>
      </Tabs.Panel>
    </Tabs>
  );
}
