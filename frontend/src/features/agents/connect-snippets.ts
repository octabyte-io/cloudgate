/**
 * The client configuration the Connect panel shows.
 *
 * A pure function of the console's origin, so the parse spec needs no DOM and
 * the reveal and the row's Connect dialog show byte-identical text.
 *
 * **A snippet never holds a key.** Each names `CLOUDGATE_AGENT_KEY` in the
 * syntax its client expands, and the config can then be committed. Where a
 * client's documentation does not promise that expansion, it gets the route it
 * does promise instead: VS Code documents only its `${input:…}` prompt for a
 * header, which asks once and keeps the answer in its secret storage, and the
 * generic block has a literal `<agent key>` for the reader to replace.
 *
 * **A client is here only if its own documentation confirms both the shape
 * and an `Authorization: Bearer` header**. `verified` says how
 * far that went, per client, and the panel says it in words:
 *
 * - `connected` — the snippet, as generated here, was written into that
 *   client's config and the client connected to a live `/mcp` and listed its
 *   tools at that version (`claude mcp list` → ✔ Connected, for Claude Code).
 * - `read` — the client, at that version, read the snippet back as a server
 *   with a bearer token from `CLOUDGATE_AGENT_KEY` (`codex mcp list`, for
 *   Codex CLI), and its documentation confirms the header; it has not
 *   connected, because nothing short of a model session makes it.
 * - `docs` — the shape, the file and the interpolation syntax were checked
 *   against the client's documentation while that version was current, and
 *   the snippet has not been connected with it.
 *
 * Bump a version only after doing the same check again at the new one.
 */

/** The environment variable every snippet that can expand one names. */
export const AGENT_KEY_ENV = "CLOUDGATE_AGENT_KEY";

/** What stands in for the key where a client expands nothing. */
export const AGENT_KEY_PLACEHOLDER = "<agent key>";

export interface ConnectSnippet {
  client: string;
  /** Where the text goes, as the client's documentation names it. */
  file: string | null;
  format: "json" | "toml";
  /** How the key reaches the client, in one sentence for the panel. */
  key: string;
  /** The version this was checked against, and how; null for the generic block. */
  verified: { version: string; how: "connected" | "read" | "docs" } | null;
  text: string;
}

/**
 * `<origin>/mcp` — the one rewrite beside `/backend/*` (ADR-0025). `origin` is
 * `location.origin`'s shape: scheme, host and port, no trailing slash.
 */
export function mcpEndpoint(origin: string): string {
  return `${origin}/mcp`;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

export function connectSnippets(origin: string): ConnectSnippet[] {
  const url = mcpEndpoint(origin);
  const setEnv = `Set ${AGENT_KEY_ENV} to the key in the environment you start the client from.`;

  return [
    {
      client: "Claude Code",
      file: ".mcp.json",
      format: "json",
      key: `${setEnv} Claude Code asks once before it uses a project’s .mcp.json.`,
      verified: { version: "2.1.278", how: "connected" },
      text: json({
        mcpServers: {
          cloudgate: {
            type: "http",
            url,
            headers: { Authorization: `Bearer \${${AGENT_KEY_ENV}}` },
          },
        },
      }),
    },
    {
      client: "VS Code",
      file: ".vscode/mcp.json",
      format: "json",
      key: "VS Code asks for the key the first time it starts the server and keeps it in its own secret storage.",
      verified: { version: "1.138.0", how: "docs" },
      text: json({
        inputs: [
          {
            type: "promptString",
            id: "cloudgate-agent-key",
            description: "Cloudgate agent key",
            password: true,
          },
        ],
        servers: {
          cloudgate: {
            type: "http",
            url,
            headers: { Authorization: "Bearer ${input:cloudgate-agent-key}" },
          },
        },
      }),
    },
    {
      client: "Cursor",
      file: "~/.cursor/mcp.json",
      format: "json",
      key: setEnv,
      verified: { version: "3.6.31", how: "docs" },
      text: json({
        mcpServers: {
          cloudgate: {
            url,
            headers: { Authorization: `Bearer \${env:${AGENT_KEY_ENV}}` },
          },
        },
      }),
    },
    {
      client: "Codex CLI",
      file: "~/.codex/config.toml",
      format: "toml",
      key: `${setEnv} Codex sends it as the bearer token.`,
      verified: { version: "0.155.1", how: "read" },
      text: [
        "[mcp_servers.cloudgate]",
        `url = ${JSON.stringify(url)}`,
        `bearer_token_env_var = "${AGENT_KEY_ENV}"`,
        "",
      ].join("\n"),
    },
    {
      client: "Any other client",
      file: null,
      format: "json",
      key: `Replace ${AGENT_KEY_PLACEHOLDER} with the key, or with your client’s way of reading ${AGENT_KEY_ENV}.`,
      verified: null,
      text: json({
        url,
        headers: { Authorization: `Bearer ${AGENT_KEY_PLACEHOLDER}` },
      }),
    },
  ];
}
