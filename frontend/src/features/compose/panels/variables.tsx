"use client";

import { Card } from "@/components/console/card";
import { KVList, KVRow } from "@/components/console/kv-list";
import { PageHeader } from "@/components/console/page-header";
import { VariablesCard } from "@/components/console/variables-card";
import type { ComposeDetail } from "@/lib/api/endpoints/compose";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { countVariables } from "@/lib/format/env-blob";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { ComposeFactsCard } from "../compose-facts-card";
import { ComposePanel } from "../compose-panel";
import { useSaveComposeEnvironment } from "../use-compose";

/**
 * The stack's variables — one encrypted dotenv blob, the same shape as a
 * Project's, an Environment's or a database's, and F08's card renders it whole.
 *
 * **Where they end up is completely different from every other service kind, and
 * that is what this screen has to say.** For an Application or a database the blob
 * becomes the container's environment. For a stack it becomes a **`.env` file
 * beside the compose file** (`getCreateComposeEnvFileCommand`), which is what
 * Docker Compose reads to substitute `${VAR}` **into the compose file** — it does
 * *not* put anything into a container by itself. A container gets a variable only
 * where the file says so, through `environment:` or `env_file:`.
 *
 * So a `DATABASE_URL` set here and never mentioned in the file reaches nothing,
 * and the card below says so in those words rather than implying the Application's
 * behaviour.
 */
export default function Panel(props: PanelProps) {
  return (
    <ComposePanel
      panel={props}
      aside={(row) => (
        <>
          <ComposeFactsCard compose={row} />
          <ResolutionCard compose={row} />
        </>
      )}
      header={(row) => (
        <PageHeader
          title={props.label}
          icon={props.icon}
          lede={`Variables written beside ${row.name}'s compose file, for the file to substitute into.`}
        />
      )}
    >
      {(row) => <Body compose={row} />}
    </ComposePanel>
  );
}

function Body({ compose }: { compose: ComposeDetail }) {
  const save = useSaveComposeEnvironment(
    compose.composeId,
    compose.environmentId,
  );
  const swarm = compose.composeType === "stack";
  // `PATCH /compose/:id/environment` is `service: ['update']`.
  const canSave = usePermission({ service: ["update"] });

  return (
    <VariablesCard
      gate={{
        allowed: canSave.allowed,
        refusal: roleRefusal("change this Compose stack's variables"),
      }}
      env={compose.env ?? ""}
      // **`""`, not `null`.** `saveComposeEnvironmentSchema` types `env` as
      // `z.string().optional()`, which refuses a null — the opposite of the
      // database and Application routes, and the trap F10 and F11 each paid a
      // defect for.
      save={(next) => save.mutateAsync(next)}
      noun="Stack"
      title="Variables"
      sub={`Set on ${compose.name} itself.`}
      emptyBody={
        <>
          Nothing is set on this stack. Add a block of <code>KEY=value</code>{" "}
          lines and the compose file can substitute them with{" "}
          <code>${"{VAR}"}</code>.
        </>
      }
      meta={
        <>
          These are written {swarm ? "into the shell that runs " : "to a "}
          <strong>{swarm ? "docker stack deploy" : ".env beside the compose file"}</strong>{" "}
          on every Deployment, so the file can substitute them. A container only
          receives one if the file passes it — through{" "}
          <code>environment:</code> or <code>env_file:</code>. Values are masked
          when the <strong>key&rsquo;s name</strong> looks like a credential;
          nothing in the data marks a line as secret, so the rule is deliberately
          cautious.
        </>
      }
    />
  );
}

/**
 * What the deploy really writes, and what it does not.
 *
 * Two facts here are worth being exact about because each one costs an afternoon:
 *
 * 1. **These are interpolation values, not container environment.** See the note
 *    on the panel.
 * 2. **Project and Environment variables are not inherited**.
 *    `prepareEnvironmentVariables` (`docker/docker.utils.ts`) maps over the
 *    *service's own* variables and returns only those; the parents' blobs are
 *    interpolation sources for `${{project.KEY}}` and `${{environment.KEY}}` and
 *    are never merged. A key set only on the Project reaches nothing. Every
 *    consumer goes through that function, so this is as true for a stack as F11
 *    found it for a database.
 *
 * And **three** the deploy adds on its own, which are useful and not obvious
 * (the row said two, and the file on the target has always had three):
 *
 * - `APP_NAME` and `COMPOSE_PROJECT_NAME`, both the stack's `appName`. The
 *   second is what pins every container's name prefix.
 * - `DOCKER_CONFIG=/root/.docker`, appended by
 *   `getCreateComposeEnvFileCommand` **only when the stack's own variables do
 *   not mention the name**. It is the one of the three that can collide with
 *   something a stack sets deliberately, which is why the
 *   condition is worth stating rather than listing the key and moving on — and
 *   it is there because the deploy runs docker under `env -i`, so a pull from a
 *   private registry would otherwise have no config to read its auth out of.
 */
function ResolutionCard({ compose }: { compose: ComposeDetail }) {
  const swarm = compose.composeType === "stack";

  return (
    <Card>
      <Card.Header
        title="What the deploy writes"
        sub="Three sources, and none of them is inheritance."
        headingLevel={2}
      />
      <Card.Body>
        <KVList>
          <KVRow
            label="Added by Cloudgate"
            value="APP_NAME, COMPOSE_PROJECT_NAME, DOCKER_CONFIG"
          />
          <KVRow
            label="This stack"
            value={<span className="num">{countVariables(compose.env)}</span>}
          />
          <KVRow
            label="Written to"
            value={swarm ? "The deploy command's shell" : ".env beside the file"}
            title={
              swarm
                ? "Swarm has no .env support, so a stack deploy exports them as quoted assignments in front of the command."
                : "touch .env, then base64-decoded into it, in the same directory the compose file is in."
            }
          />
        </KVList>

        <p className="mt-3 text-meta text-tx-2">
          <code>APP_NAME</code> and <code>COMPOSE_PROJECT_NAME</code> are both{" "}
          <strong className="font-medium text-tx-2">{compose.appName}</strong>;
          the second is what pins every container&rsquo;s name prefix.{" "}
          <code>DOCKER_CONFIG=/root/.docker</code>{" "}
          is appended only when this stack&rsquo;s own variables do not mention
          the name — the deploy runs docker under <code>env -i</code>, so it is
          what keeps a pull from a private registry able to find its
          credentials. Set it yourself and yours is kept.
        </p>

        <p className="mt-3 text-meta text-tx-2">
          Variables on{" "}
          <strong className="font-medium text-tx-2">
            {compose.environment.project.name}
          </strong>{" "}
          and{" "}
          <strong className="font-medium text-tx-2">
            {compose.environment.name}
          </strong>{" "}
          are <strong className="font-medium text-tx-2">not inherited</strong> —
          they are only reachable by naming them here, so a key set one level up
          and never referenced reaches nothing.
        </p>

        <div className="mt-3 rounded-lg border border-line bg-panel-2 px-3 py-2.5">
          <p className="text-meta text-tx-2">To use one, reference it by name:</p>
          <pre className="mt-1.5 overflow-x-auto font-mono text-meta text-tx">
            <code>{"CACHE_URL=${{project.REDIS_URL}}"}</code>
          </pre>
          <p className="mt-1.5 text-meta text-tx-3">
            A reference to a name that is not set makes the deploy fail rather than
            resolving to empty.
          </p>
        </div>

        <KVList className="mt-3">
          <KVRow
            label="Available to reference"
            value={
              <span className="num">
                {countVariables(compose.environment.project.env) +
                  countVariables(compose.environment.env)}
              </span>
            }
            title={`${countVariables(compose.environment.project.env)} on the Project, ${countVariables(compose.environment.env)} on the Environment`}
          />
        </KVList>
      </Card.Body>
    </Card>
  );
}
