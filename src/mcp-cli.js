// `aether mcp` subcommand machinery: add / remove / list MCP servers
// in ~/.aether/mcp.json without the user hand-editing JSON.
//
// All read/write goes through this module so the validation (delegated to
// mcp.js) is consistent with what MCPManager will accept at runtime.
// configPath is injectable for tests; production code uses DEFAULT_PATH.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateMcpConfig } from "./mcp.js";

const DEFAULT_PATH = path.join(os.homedir(), ".aether", "mcp.json");

function resolvePath(opts) {
  return opts?.configPath || DEFAULT_PATH;
}

export function readConfig(opts) {
  const p = resolvePath(opts);
  if (!fs.existsSync(p)) return { mcpServers: {} };
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    throw new Error(`MCP config at ${p} unreadable: ${e.message}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") {
      return { ...parsed, mcpServers: {} };
    }
    return parsed;
  } catch (e) {
    throw new Error(`MCP config at ${p} is not valid JSON: ${e.message}`);
  }
}

function writeConfig(config, opts) {
  const p = resolvePath(opts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Pretty-print so users can read + hand-edit if they want, and trailing
  // newline so diff tools don't bicker.
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/**
 * Add a server entry. Mutates ~/.aether/mcp.json (creating it + the dir
 * if missing). Validates the full resulting config via validateMcpConfig
 * so a bad add can't poison the file with a config the runtime would
 * later reject.
 */
export function addServer({ configPath, name, command, args = [], env = {} }) {
  const cfg = readConfig({ configPath });
  if (cfg.mcpServers[name]) {
    throw new Error(
      `MCP server "${name}" already configured. Remove it first with \`aether mcp remove ${name}\` or pick a different name.`,
    );
  }
  const entry = { command };
  if (args.length > 0) entry.args = args;
  if (Object.keys(env).length > 0) entry.env = env;
  const next = {
    ...cfg,
    mcpServers: { ...cfg.mcpServers, [name]: entry },
  };
  validateMcpConfig(next, configPath || "<add>"); // throws on schema failure
  writeConfig(next, { configPath });
  return entry;
}

/**
 * Remove a server entry by name. Throws if it doesn't exist (so the user
 * notices typos instead of silently no-op'ing).
 */
export function removeServer({ configPath, name }) {
  const cfg = readConfig({ configPath });
  if (!cfg.mcpServers[name]) {
    throw new Error(`MCP server "${name}" not configured.`);
  }
  const nextServers = { ...cfg.mcpServers };
  delete nextServers[name];
  const next = { ...cfg, mcpServers: nextServers };
  writeConfig(next, { configPath });
}

/**
 * Return [[name, entry], ...] for every configured server. Empty array
 * when no config exists or mcpServers is empty.
 */
export function listServers(opts) {
  const cfg = readConfig(opts);
  return Object.entries(cfg.mcpServers);
}
