import { Chip } from "@/components/console/chip";
import { CodeWell } from "@/components/console/code-well";
import { Field } from "@/components/console/field";
import { Picker } from "@/components/console/picker";
import { Textarea } from "@/components/ui/textarea";
import type { AiSuggestion } from "@/lib/api/endpoints/ai";

/**
 * Step one: say what is wanted, and which provider is asked.
 *
 * The prompt behind this branches on whether you named an application or a need,
 * so the placeholder shows one of each. The provider picker only appears when
 * there is a choice to make.
 */
export function DescribeStep({
  available,
  provider,
  onProvider,
  input,
  onInput,
}: {
  available: readonly { aiId: string; name: string; model: string }[];
  provider: string;
  onProvider: (aiId: string) => void;
  input: string;
  onInput: (input: string) => void;
}) {
  return (
    <>
      {available.length > 1 ? (
        <Field name="draft-provider" label="Provider" manual>
          <Picker
            options={available.map((each) => ({
              value: each.aiId,
              label: each.name,
              detail: each.model,
            }))}
            value={provider}
            onValueChange={onProvider}
          />
        </Field>
      ) : null}
      <Field
        name="draft-input"
        label="What do you need?"
        hint="Name a specific application and you get variants of it. Describe a need and you get different projects that solve it."
        manual
      >
        <Textarea
          rows={3}
          value={input}
          onChange={(event) => onInput(event.target.value)}
          placeholder={
            "Deploy Ghost with Postgres\nor: a place for the team to write things down"
          }
        />
      </Field>
    </>
  );
}

/**
 * Step three: **read the file** before it becomes a service on your Server.
 *
 * This step exists for one reason: everything in it — the images, the ports, the
 * passwords — was written by a model, and the whole file is on screen at the
 * moment it can still be abandoned.
 */
export function ReviewStep({ chosen }: { chosen: AiSuggestion }) {
  return (
    <>
      <p className="text-body text-tx-2">{chosen.description}</p>

      {chosen.domains.length > 0 ? (
        <p className="text-meta text-tx-2">
          It asks for {chosen.domains.length === 1 ? "a domain" : "domains"}:{" "}
          {chosen.domains.map((domain) => (
            <Chip key={domain.host} variant="mono" className="mr-1.5">
              {domain.host}:{domain.port}
            </Chip>
          ))}
          — created alongside the stack, and answering only once DNS points here.
        </p>
      ) : null}

      <CodeWell
        label={`Compose file for ${chosen.name}`}
        content={chosen.dockerCompose}
      />

      {chosen.envVariables.length > 0 ? (
        <CodeWell
          label={`Variables for ${chosen.name}`}
          content={chosen.envVariables
            .map((variable) => `${variable.name}=${variable.value}`)
            .join("\n")}
        />
      ) : null}

      <p className="text-meta text-tx-2">
        Every password and secret above was made up by a model. Change the ones
        that matter on the stack&rsquo;s Variables tab before you deploy it.
      </p>
    </>
  );
}
