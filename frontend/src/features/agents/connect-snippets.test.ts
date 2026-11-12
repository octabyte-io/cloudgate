import { parse as parseToml } from "toml";
import { describe, expect, it } from "vitest";

import { connectSnippets } from "./connect-snippets";

/**
 * The Connect snippets, parsed the way each client parses them.
 *
 * Every expected value is written out from the client's own documentation
 * rather than imported (§1.7), so a reworded key, a renamed file or a changed
 * interpolation syntax reds here instead of in an operator's client.
 */

const ORIGIN = "https://console.example.com";
const ENDPOINT = "https://console.example.com/mcp";

const snippets = connectSnippets(ORIGIN);
const byClient = (client: string) => {
  const found = snippets.find((snippet) => snippet.client === client);
  if (!found) throw new Error(`no ${client} snippet`);
  return found;
};

describe("connectSnippets", () => {
  it("covers the clients whose config was confirmed, in the order the panel shows them", () => {
    expect(snippets.map((snippet) => snippet.client)).toEqual([
      "Claude Code",
      "VS Code",
      "Cursor",
      "Codex CLI",
      "Any other client",
    ]);
  });

  it("parses every snippet as its declared format", () => {
    for (const snippet of snippets) {
      const parse = () =>
        snippet.format === "toml"
          ? parseToml(snippet.text)
          : JSON.parse(snippet.text);
      expect(parse, snippet.client).not.toThrow();
      expect(["json", "toml"]).toContain(snippet.format);
    }
  });

  it("names the client version each was verified with", () => {
    for (const snippet of snippets.filter((s) => s.verified)) {
      expect(snippet.verified?.version, snippet.client).toMatch(/\d+\.\d+/);
    }
    expect(byClient("Claude Code").verified).toEqual({
      version: "2.1.278",
      how: "connected",
    });
    expect(byClient("Codex CLI").verified).toEqual({
      version: "0.155.1",
      how: "read",
    });
  });

  it("gives Claude Code a project .mcp.json that expands CLOUDGATE_AGENT_KEY in the header", () => {
    const snippet = byClient("Claude Code");
    expect(snippet.file).toBe(".mcp.json");
    expect(JSON.parse(snippet.text)).toEqual({
      mcpServers: {
        cloudgate: {
          type: "http",
          url: ENDPOINT,
          headers: { Authorization: "Bearer ${CLOUDGATE_AGENT_KEY}" },
        },
      },
    });
  });

  it("gives VS Code a .vscode/mcp.json that prompts for the key rather than holding it", () => {
    const snippet = byClient("VS Code");
    expect(snippet.file).toBe(".vscode/mcp.json");
    expect(JSON.parse(snippet.text)).toEqual({
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
          url: ENDPOINT,
          headers: { Authorization: "Bearer ${input:cloudgate-agent-key}" },
        },
      },
    });
  });

  it("gives Cursor an mcp.json that reads CLOUDGATE_AGENT_KEY with its env: syntax", () => {
    const snippet = byClient("Cursor");
    expect(snippet.file).toBe("~/.cursor/mcp.json");
    expect(JSON.parse(snippet.text)).toEqual({
      mcpServers: {
        cloudgate: {
          url: ENDPOINT,
          headers: { Authorization: "Bearer ${env:CLOUDGATE_AGENT_KEY}" },
        },
      },
    });
  });

  it("gives Codex CLI a config.toml table whose bearer token comes from CLOUDGATE_AGENT_KEY", () => {
    const snippet = byClient("Codex CLI");
    expect(snippet.file).toBe("~/.codex/config.toml");
    expect(parseToml(snippet.text)).toEqual({
      mcp_servers: {
        cloudgate: {
          url: ENDPOINT,
          bearer_token_env_var: "CLOUDGATE_AGENT_KEY",
        },
      },
    });
  });

  it("gives any other client the URL and the header, with a placeholder where the key goes", () => {
    const snippet = byClient("Any other client");
    expect(snippet.file).toBeNull();
    expect(snippet.verified).toBeNull();
    expect(JSON.parse(snippet.text)).toEqual({
      url: ENDPOINT,
      headers: { Authorization: "Bearer <agent key>" },
    });
  });

  it("builds the endpoint from the origin it is given", () => {
    const local = connectSnippets("http://10.0.0.5:3000");
    for (const snippet of local) {
      expect(snippet.text, snippet.client).toContain(
        '"http://10.0.0.5:3000/mcp"',
      );
    }
  });
});
