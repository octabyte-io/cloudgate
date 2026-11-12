import { CodeWell } from "@/components/console/code-well";
import { CopyButton } from "@/components/console/copy-button";
import { Tabs } from "@/components/console/tabs";

import {
  connectSnippets,
  mcpEndpoint,
  type ConnectSnippet,
} from "./connect-snippets";

/**
 * The console's origin, which is the MCP endpoint's origin too (ADR-0025).
 *
 * Read from `location` rather than a configured public URL for the reason
 * `invitationLink` gives: nothing reliably answers with one, and the origin the
 * operator reached the console on is the one their client can reach.
 */
function consoleOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

const VERIFIED: Record<
  NonNullable<ConnectSnippet["verified"]>["how"],
  (client: string, version: string) => string
> = {
  connected: (client, version) => `Connected with ${client} ${version}.`,
  read: (client, version) =>
    `Read back by ${client} ${version}; its documentation confirms the header.`,
  docs: (client, version) =>
    `Checked against ${client}’s documentation at ${version}.`,
};

/**
 * Ready-to-paste client configuration for an Agent, one tab per client.
 *
 * It is never handed the key, so it cannot show one: the reveal renders it
 * under the key, and the row's Connect dialog renders it with no key at all.
 * The text is `connectSnippets`' verbatim, and the copy button copies exactly
 * what the well shows.
 */
export function ConnectPanel() {
  const origin = consoleOrigin();
  const snippets = connectSnippets(origin);

  return (
    <section aria-label="Connect a client" className="grid gap-2">
      <p className="text-body text-tx-2">
        Paste one of these into the client. The endpoint is{" "}
        <code className="font-mono text-ui wrap-anywhere text-tx">
          {mcpEndpoint(origin)}
        </code>{" "}
        and the key goes in an{" "}
        <code className="font-mono text-ui text-tx">
          Authorization: Bearer
        </code>{" "}
        header. None of them holds the key, so they are safe to commit.
      </p>
      <Tabs defaultValue={snippets[0].client}>
        <Tabs.Bar>
          {snippets.map((snippet) => (
            <Tabs.Tab key={snippet.client} value={snippet.client}>
              {snippet.client}
            </Tabs.Tab>
          ))}
        </Tabs.Bar>
        {snippets.map((snippet) => (
          <Tabs.Panel
            key={snippet.client}
            value={snippet.client}
            className="grid gap-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-meta text-tx-2">
                {snippet.file ? (
                  <>
                    In{" "}
                    <code className="font-mono text-tx">{snippet.file}</code>.{" "}
                  </>
                ) : null}
                {snippet.key}
              </p>
              <CopyButton
                value={snippet.text}
                label={`${snippet.client} config`}
              />
            </div>
            <CodeWell content={snippet.text} label={`${snippet.client} config`} />
            {snippet.verified ? (
              <p className="text-meta text-tx-3">
                {VERIFIED[snippet.verified.how](
                  snippet.client,
                  snippet.verified.version,
                )}
              </p>
            ) : null}
          </Tabs.Panel>
        ))}
      </Tabs>
    </section>
  );
}
