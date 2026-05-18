// MCP (Model Context Protocol) client manager.
//
// Lets aether-code consume any MCP server as agent tools. Users configure
// servers in ~/.aether/mcp.json (mirror of Claude Code's pattern):
//
//   {
//     "mcpServers": {
//       "filesystem": {
//         "command": "npx",
//         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/some/path"]
//       },
//       "ida": {
//         "command": "python",
//         "args": ["-m", "ida_pro_mcp"],
//         "env": { "IDA_PATH": "/opt/ida" }
//       }
//     }
//   }
//
// Each server's tools are exposed to the model namespaced as
// `mcp__<serverName>__<toolName>` so a `filesystem` server's `read_file`
// doesn't collide with our built-in `read_file`. The manager handles the
// JSON-RPC handshake, tool discovery, call routing, and cleanup on exit.
//
// Failure model is fail-soft per server: if `ida` fails to start (binary
// missing, init handshake errors out), we log it and continue with the
// servers that DID start. One bad server should not break the whole CLI.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".aether", "mcp.json");
const NAMESPACE_SEP = "__";
const NAMESPACE_PREFIX = "mcp" + NAMESPACE_SEP;
const INIT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;

/**
 * Read + validate the MCP config file. Returns the parsed config or null if
 * the file is missing (which is the normal case for users who don't use MCP).
 * Throws on malformed JSON or schema violations so the user sees the error
 * immediately instead of silently running without their servers.
 */
export function loadMcpConfig(configPath) {
  const p = configPath || DEFAULT_CONFIG_PATH;
  if (!fs.existsSync(p)) return null;
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    throw new Error(`MCP config exists at ${p} but isn't readable: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`MCP config at ${p} is not valid JSON: ${e.message}`);
  }
  return validateMcpConfig(parsed, p);
}

export function validateMcpConfig(parsed, sourcePath = "(inline)") {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`MCP config at ${sourcePath} must be a JSON object`);
  }
  const servers = parsed.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error(`MCP config at ${sourcePath} needs an "mcpServers" object`);
  }
  for (const [name, cfg] of Object.entries(servers)) {
    if (!/^[a-z0-9_-]{1,40}$/i.test(name)) {
      throw new Error(
        `MCP server name "${name}" invalid — must be 1-40 chars of [A-Za-z0-9_-]. Used in tool namespacing.`,
      );
    }
    if (!cfg || typeof cfg !== "object") {
      throw new Error(`MCP server "${name}" entry must be an object`);
    }
    if (typeof cfg.command !== "string" || cfg.command.length === 0) {
      throw new Error(`MCP server "${name}" needs a non-empty "command" string`);
    }
    if (cfg.args !== undefined && !Array.isArray(cfg.args)) {
      throw new Error(`MCP server "${name}".args must be an array of strings`);
    }
    if (Array.isArray(cfg.args) && cfg.args.some((a) => typeof a !== "string")) {
      throw new Error(`MCP server "${name}".args must be an array of STRINGS`);
    }
    if (cfg.env !== undefined && (typeof cfg.env !== "object" || Array.isArray(cfg.env))) {
      throw new Error(`MCP server "${name}".env must be an object {KEY: value}`);
    }
  }
  return parsed;
}

/**
 * Build the `mcp__<server>__<tool>` namespaced tool name. Defense against
 * underscores in the user-defined server name accidentally collapsing the
 * boundary (config validation already rejects those, but we double-check
 * here since this string is what the model sees).
 */
export function namespaceToolName(serverName, toolName) {
  if (serverName.includes(NAMESPACE_SEP) || toolName.includes(NAMESPACE_SEP)) {
    // Replace with a single underscore so the boundary stays unambiguous.
    return (
      NAMESPACE_PREFIX +
      serverName.replaceAll(NAMESPACE_SEP, "_") +
      NAMESPACE_SEP +
      toolName.replaceAll(NAMESPACE_SEP, "_")
    );
  }
  return NAMESPACE_PREFIX + serverName + NAMESPACE_SEP + toolName;
}

/**
 * Inverse of namespaceToolName: split a `mcp__server__tool` name back into
 * its parts. Returns null if the name doesn't follow the convention (i.e.
 * it's a built-in tool, not an MCP one).
 */
export function unnamespaceToolName(namespaced) {
  if (!namespaced.startsWith(NAMESPACE_PREFIX)) return null;
  const rest = namespaced.slice(NAMESPACE_PREFIX.length);
  const sepIdx = rest.indexOf(NAMESPACE_SEP);
  if (sepIdx <= 0 || sepIdx >= rest.length - NAMESPACE_SEP.length) return null;
  return {
    serverName: rest.slice(0, sepIdx),
    toolName: rest.slice(sepIdx + NAMESPACE_SEP.length),
  };
}

export class MCPManager {
  constructor() {
    this.servers = new Map(); // name -> { client, transport, tools: [...] }
    this.startErrors = []; // [{ serverName, error }]
  }

  /**
   * Start every server in the config. Failures are collected (in
   * `startErrors`) rather than thrown so one bad server doesn't kill the
   * CLI. Returns the count of successfully-started servers.
   */
  async start(config) {
    if (!config || !config.mcpServers) return 0;
    const entries = Object.entries(config.mcpServers);
    await Promise.allSettled(
      entries.map(async ([name, cfg]) => {
        try {
          await this.#startOne(name, cfg);
        } catch (e) {
          this.startErrors.push({ serverName: name, error: e.message || String(e) });
        }
      }),
    );
    return this.servers.size;
  }

  async #startOne(name, cfg) {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...process.env, ...(cfg.env ?? {}) },
    });
    const client = new Client(
      { name: "aether-code", version: "0.9.0" },
      { capabilities: {} },
    );
    // Bound the init handshake so a hung server doesn't stall startup.
    await withTimeout(client.connect(transport), INIT_TIMEOUT_MS, `MCP server "${name}" init`);
    const toolList = await withTimeout(client.listTools(), INIT_TIMEOUT_MS, `MCP server "${name}" listTools`);
    const tools = (toolList?.tools ?? []).map((t) => ({
      originalName: t.name,
      namespacedName: namespaceToolName(name, t.name),
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }));
    this.servers.set(name, { client, transport, tools });
  }

  /**
   * Returns OpenAI-format tool definitions for every connected MCP tool,
   * ready to merge into TOOL_DEFINITIONS for the agent loop.
   */
  getToolDefinitions() {
    const out = [];
    for (const { tools } of this.servers.values()) {
      for (const t of tools) {
        out.push({
          type: "function",
          function: {
            name: t.namespacedName,
            description: t.description || `(MCP tool ${t.originalName})`,
            parameters: t.inputSchema,
          },
        });
      }
    }
    return out;
  }

  /**
   * Resolve a namespaced tool name to the right server + original name.
   * Returns null if the name isn't an MCP tool or no server matches.
   */
  resolve(namespacedName) {
    const split = unnamespaceToolName(namespacedName);
    if (!split) return null;
    const server = this.servers.get(split.serverName);
    if (!server) return null;
    return { server, serverName: split.serverName, toolName: split.toolName };
  }

  /**
   * Invoke a namespaced MCP tool. Returns { ok, output } matching the
   * shape executeTool() uses for built-in tools.
   */
  async callTool(namespacedName, args) {
    const resolved = this.resolve(namespacedName);
    if (!resolved) {
      return { ok: false, output: `Unknown MCP tool: ${namespacedName}` };
    }
    try {
      const result = await withTimeout(
        resolved.server.client.callTool({
          name: resolved.toolName,
          arguments: args,
        }),
        CALL_TIMEOUT_MS,
        `MCP tool ${namespacedName}`,
      );
      // MCP tool results are { content: [{type, text|data, ...}], isError? }
      const textParts = (result?.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text);
      const text = textParts.join("\n") || JSON.stringify(result, null, 2);
      return { ok: !result?.isError, output: text };
    } catch (e) {
      return { ok: false, output: `MCP call ${namespacedName} failed: ${e.message}` };
    }
  }

  async shutdown() {
    const tasks = [];
    for (const { client } of this.servers.values()) {
      tasks.push(client.close().catch(() => {}));
    }
    await Promise.allSettled(tasks);
    this.servers.clear();
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
