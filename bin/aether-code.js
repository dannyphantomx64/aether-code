#!/usr/bin/env node
// aether-code — uncensored AI coding agent.
//
// Examples:
//   aether-code "build me a TypeScript todo CLI in this folder"
//   aether-code --yes "add JSDoc to every exported function in src/"
//   aether-code --cwd ./my-project "fix the failing tests"
//   aether-code --max-turns 40 "refactor the auth module to use bcrypt"

import process from "node:process";
import path from "node:path";
import { runAgent } from "../src/agent.js";
import { runRepl } from "../src/repl.js";
import { runSetup } from "../src/setup.js";
import { fetchBalance, AetherError } from "../src/api.js";
import { writeConfigFile, getConfig, CONFIG_PATH } from "../src/config.js";
import { loadMcpConfig, MCPManager } from "../src/mcp.js";
import { addServer, removeServer, listServers } from "../src/mcp-cli.js";
import {
  MCP_REGISTRY,
  findRegistryEntry,
  resolveEntry,
  searchRegistry,
  suggestSimilar,
} from "../src/mcp-registry.js";
import readline from "node:readline";
import { c, errorLine, divider } from "../src/render.js";

const VERSION = "0.16.0";

/**
 * Try to start MCP servers from ~/.aether/mcp.json. Returns a started
 * MCPManager (possibly with zero servers) or null if no config exists.
 * Prints a one-line summary so the user can see what attached.
 */
async function bootMcp() {
  let config;
  try {
    config = loadMcpConfig();
  } catch (e) {
    console.log(errorLine(`MCP config: ${e.message}`));
    return null;
  }
  if (!config) return null;
  const manager = new MCPManager();
  const started = await manager.start(config);
  const requested = Object.keys(config.mcpServers).length;
  const failed = manager.startErrors.length;
  if (started > 0 || failed > 0) {
    const parts = [`${c.cyan("MCP")}`, `${started}/${requested} servers attached`];
    const toolCount = manager.getToolDefinitions().length;
    if (toolCount > 0) parts.push(`${toolCount} tools`);
    console.log(c.gray(parts.join(" · ")));
    for (const { serverName, error } of manager.startErrors) {
      console.log(c.gray(`  ${c.yellow("!")} ${serverName}: ${error}`));
    }
  }
  // Best-effort cleanup so child processes don't leak on normal exit.
  process.on("exit", () => { manager.shutdown().catch(() => {}); });
  process.on("SIGINT", () => { manager.shutdown().catch(() => {}); process.exit(130); });
  return manager;
}

const HELP = `${c.bold("aether")} — uncensored AI coding agent

${c.bold("USAGE")}
  aether                               Launch interactive REPL (Claude-CLI-style)
  aether [flags] "<task>"              Run agent once on a single task
  aether <subcommand> [args]           Run a utility subcommand

${c.bold("SUBCOMMANDS")}
  ${c.cyan("login")}                                Open browser, paste API key, save
  ${c.cyan("logout")}                               Clear saved API key
  ${c.cyan("balance")}                              Show plan + credit balance
  ${c.cyan("config")} show|set|set-base|path        Manage config file
  ${c.cyan("mcp")} list|search|install|add|remove   Manage MCP server connections

${c.bold("EXAMPLES")}
  aether                               # interactive REPL
  aether login                         # first-time setup
  aether balance                       # quick credit check
  aether "build a TypeScript todo CLI in this folder"
  aether --yes "add JSDoc to every exported function"
  aether --cwd ./my-project "fix the failing tests"

${c.bold("FLAGS")}
  --yes              Auto-approve all writes and shell commands. Use with care.
  --cwd <path>       Working directory for the agent (default: current dir).
  --max-turns <n>    Maximum turns before stopping (default: 25).
  --unsafe-paths     Allow the agent to read/write outside cwd.
  --help, -h         Show this help.
  --version, -v      Print version.

${c.bold("CONFIG")}
  Same config as aether-cli — uses ${c.cyan("AETHER_API_KEY")} or ${c.cyan("~/.aetherrc")}.
  Get a key at ${c.blue("https://trynoguard.com/account")}.

${c.bold("SAFETY")}
  - File writes show a unified diff and require y/N confirmation by default.
  - Shell commands show what's about to run and require y/N confirmation.
  - Paths are clamped to ${c.cyan("--cwd")} (override with ${c.cyan("--unsafe-paths")}).
  - Each shell command has a 2-minute hard timeout.

${c.gray(`v${VERSION}`)}
`;

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes") { args.flags.yes = true; }
    else if (a === "--unsafe-paths") { args.flags.unsafePaths = true; }
    else if (a === "--help" || a === "-h") { args.flags.help = true; }
    else if (a === "--version" || a === "-v") { args.flags.version = true; }
    else if (a === "--cwd") { args.flags.cwd = argv[++i]; }
    else if (a === "--max-turns") { args.flags.maxTurns = parseInt(argv[++i], 10); }
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) args.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else args.flags[a.slice(2)] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function die(msg, code = 1) {
  process.stderr.write(errorLine(msg) + "\n");
  process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.flags.version) {
    process.stdout.write(`aether-code ${VERSION}\n`);
    return;
  }

  const cwd = args.flags.cwd ? path.resolve(args.flags.cwd) : process.cwd();
  const autoYes = !!args.flags.yes;
  const unsafePaths = !!args.flags.unsafePaths;
  const maxTurns = Number.isInteger(args.flags.maxTurns) ? args.flags.maxTurns : 25;

  // Subcommand routing — these shadow the "task as positional arg" mode
  const sub = args._[0]?.toLowerCase();
  if (sub === "login" || sub === "auth") {
    const ok = await runSetup();
    process.exit(ok ? 0 : 1);
  }
  if (sub === "logout") {
    writeConfigFile({ apiKey: "" });
    console.log(c.gray(`Cleared API key from ${CONFIG_PATH}.`));
    return;
  }
  if (sub === "config") {
    await handleConfig(args._.slice(1));
    return;
  }
  if (sub === "balance") {
    await handleBalance();
    return;
  }
  if (sub === "mcp") {
    await handleMcp(args._.slice(1));
    return;
  }

  const prompt = args._.join(" ").trim();

  // No task → drop into interactive REPL (Claude-CLI-style)
  if (!prompt) {
    if (cwd !== process.cwd()) process.chdir(cwd);
    const mcpManager = await bootMcp();
    await runRepl({ cwd, autoYes, maxTurns, mcpManager });
    return;
  }

  // One-shot mode also needs an API key. If missing, run setup before the task.
  const cfg = getConfig();
  if (!cfg.apiKey) {
    const ok = await runSetup();
    if (!ok) process.exit(1);
  }

  console.log(divider());
  console.log(c.magenta(c.bold("aether-code")) + c.gray(` · cwd ${cwd}${autoYes ? " · auto-yes" : ""}${unsafePaths ? " · unsafe-paths" : ""}`));
  console.log(c.gray(`task: `) + prompt);
  console.log(divider());

  const mcpManager = await bootMcp();
  const result = await runAgent({
    initialPrompt: prompt,
    cwd,
    autoYes,
    unsafePaths,
    maxTurns,
    mcpManager,
  });
  if (mcpManager) await mcpManager.shutdown().catch(() => {});

  console.log("\n" + divider());
  if (result.ok) {
    console.log(c.green(c.bold("✓ Done")) + c.gray(`  ${result.turns} turn${result.turns === 1 ? "" : "s"} · ${result.totalCredits} credits · ${result.totalIn}→${result.totalOut} tokens`));
    if (typeof result.balance === "number") {
      console.log(c.gray(`  balance: ${result.balance.toLocaleString()} credits`));
    }
  } else {
    console.log(c.red(c.bold("✗ Stopped")) + c.gray(`  ${result.totalCredits} credits used · ${result.totalIn}→${result.totalOut} tokens`));
    if (result.error) console.log(errorLine(result.error.message));
  }
  console.log(divider());
}

async function handleConfig(rest) {
  const sub = (rest[0] || "").toLowerCase();
  if (sub === "show" || !sub) {
    const cfg = getConfig();
    console.log(`Config file: ${cfg.configPath}`);
    console.log(`API key:     ${cfg.apiKey ? cfg.apiKey.slice(0, 12) + "…" + cfg.apiKey.slice(-4) : c.gray("(none)")}`);
    console.log(`Base URL:    ${cfg.baseUrl}`);
    console.log(`Source:      ${process.env.AETHER_API_KEY ? "AETHER_API_KEY env" : "config file"}`);
    return;
  }
  if (sub === "set") {
    const key = rest[1];
    if (!key) die("config set: missing API key argument.");
    if (!key.startsWith("ak_live_")) {
      process.stderr.write(c.yellow("warning: keys normally start with ak_live_; saving anyway.\n"));
    }
    writeConfigFile({ apiKey: key });
    console.log(`${c.green("✓")} API key saved to ${CONFIG_PATH}`);
    return;
  }
  if (sub === "set-base") {
    const url = rest[1];
    if (!url) die("config set-base: missing URL argument.");
    writeConfigFile({ baseUrl: url });
    console.log(`${c.green("✓")} Base URL saved.`);
    return;
  }
  if (sub === "path") {
    console.log(CONFIG_PATH);
    return;
  }
  die(`config: unknown subcommand "${sub}". Try 'config show', 'config set <key>', 'config path'.`);
}

async function handleBalance() {
  try {
    const me = await fetchBalance();
    console.log(c.bold(c.magenta("Aether")));
    console.log(c.gray("─".repeat(50)));
    console.log(`Plan      ${c.cyan(me.plan)}${me.role !== "USER" ? c.gray(` · ${me.role}`) : ""}`);
    console.log(`Balance   ${c.bold(me.balance.toLocaleString())} credits`);
    console.log(`  plan    ${me.planCredits.toLocaleString()}`);
    console.log(`  topup   ${me.topupCredits.toLocaleString()}`);
    if (me.rate) {
      console.log(`Rate      ${me.rate.used}/${me.rate.limit} this hour${me.rate.resetIn ? ` · resets in ${me.rate.resetIn}s` : ""}`);
    }
    if (me.isSuspended) console.log(c.red("\n⚠ Account is suspended."));
  } catch (err) {
    if (err instanceof AetherError && err.code === "NO_API_KEY") {
      console.log(errorLine("No API key. Run `aether login` first."));
    } else {
      die(err.message || String(err));
    }
  }
}

async function handleMcp(rest) {
  const sub = (rest[0] || "list").toLowerCase();

  if (sub === "list" || sub === "ls") {
    const servers = listServers();
    if (servers.length === 0) {
      console.log(c.gray("No MCP servers configured."));
      console.log(c.gray("Add one with:"));
      console.log(c.gray("  aether mcp add <name> -- <command> [args...]"));
      console.log(c.gray("Example:"));
      console.log(
        c.gray('  aether mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem /path'),
      );
      return;
    }
    console.log(c.bold(`Configured MCP servers (${servers.length}):`));
    for (const [name, cfg] of servers) {
      const argsStr = cfg.args && cfg.args.length > 0 ? " " + cfg.args.join(" ") : "";
      console.log(`  ${c.cyan(name)}: ${cfg.command}${argsStr}`);
      if (cfg.env && Object.keys(cfg.env).length > 0) {
        for (const [k, v] of Object.entries(cfg.env)) {
          console.log(c.gray(`    env ${k}=${v}`));
        }
      }
    }
    return;
  }

  if (sub === "add") {
    // Syntax: aether mcp add <name> [--env KEY=VAL]... -- <command> [args...]
    const tail = rest.slice(1);
    const dashIdx = tail.indexOf("--");
    if (dashIdx === -1) {
      die(
        'Usage: aether mcp add <name> [--env KEY=VAL]... -- <command> [args...]\n' +
          'Example: aether mcp add fs -- npx -y @modelcontextprotocol/server-filesystem /tmp',
      );
    }
    const pre = tail.slice(0, dashIdx);
    const post = tail.slice(dashIdx + 1);
    const name = pre[0];
    if (!name) die("aether mcp add: missing <name>");
    if (post.length === 0) die("aether mcp add: missing <command> after '--'");

    const env = {};
    for (let i = 1; i < pre.length; i++) {
      if (pre[i] === "--env") {
        const kv = pre[++i];
        if (!kv) die("--env needs a KEY=VAL argument");
        const eq = kv.indexOf("=");
        if (eq <= 0) die(`--env value must be KEY=VAL, got: ${kv}`);
        env[kv.slice(0, eq)] = kv.slice(eq + 1);
      } else {
        die(`aether mcp add: unrecognized option "${pre[i]}" before the '--' separator`);
      }
    }

    const command = post[0];
    const cmdArgs = post.slice(1);
    try {
      const entry = addServer({ name, command, args: cmdArgs, env });
      console.log(`${c.green("✓")} Added MCP server "${c.cyan(name)}".`);
      const argsStr = entry.args && entry.args.length > 0 ? " " + entry.args.join(" ") : "";
      console.log(c.gray(`  ${entry.command}${argsStr}`));
      console.log(c.gray("Restart the agent (or run `aether`) to attach it."));
    } catch (e) {
      die(e.message || String(e));
    }
    return;
  }

  if (sub === "remove" || sub === "rm" || sub === "delete") {
    const name = rest[1];
    if (!name) die("aether mcp remove: missing <name>");
    try {
      removeServer({ name });
      console.log(`${c.green("✓")} Removed MCP server "${c.cyan(name)}".`);
    } catch (e) {
      die(e.message || String(e));
    }
    return;
  }

  if (sub === "search" || sub === "find") {
    const query = rest.slice(1).join(" ").trim();
    const results = searchRegistry(query);
    if (results.length === 0) {
      console.log(c.gray(`No MCP servers in the registry match "${query}".`));
      console.log(c.gray("Browse the full list: ") + c.cyan("aether mcp search"));
      return;
    }
    console.log(
      c.bold(query ? `MCP servers matching "${query}":` : `Available MCP servers (${results.length}):`),
    );
    for (const e of results) {
      const sourceTag = e.source === "official"
        ? c.gray("(official)")
        : c.yellow("(community)");
      console.log(`  ${c.cyan(e.id.padEnd(16))} ${sourceTag}  ${e.description}`);
    }
    console.log("");
    console.log(c.gray("Install one with: ") + c.cyan("aether mcp install <name>"));
    return;
  }

  if (sub === "install" || sub === "get") {
    const name = rest[1];
    if (!name) {
      die(
        "aether mcp install: missing <name>.\n" +
          "Try `aether mcp search` to see what's available.",
      );
    }
    const entry = findRegistryEntry(name);
    if (!entry) {
      const suggestions = suggestSimilar(name);
      let msg = `aether mcp install: unknown server "${name}".`;
      if (suggestions.length > 0) {
        msg += `\nDid you mean: ${suggestions.map((s) => c.cyan(s)).join(", ")}?`;
      } else {
        msg += `\nTry \`aether mcp search\` to browse the registry.`;
      }
      die(msg);
    }
    // Prompt for any required values (placeholders in args + env)
    const allRequired = [...(entry.requires ?? []), ...(entry.requiresEnv ?? [])];
    const values = {};
    if (allRequired.length > 0) {
      console.log(c.gray(`Installing ${c.cyan(entry.id)} — needs ${allRequired.length} input${allRequired.length === 1 ? "" : "s"}:`));
      for (const key of allRequired) {
        const promptText = entry.prompts?.[key] ?? key;
        // eslint-disable-next-line no-await-in-loop -- sequential prompts are intentional
        values[key] = await promptUser(`  ${promptText}: `);
        if (!values[key]) die(`Cancelled — "${key}" is required.`);
      }
    }
    let resolved;
    try {
      resolved = resolveEntry(entry, values);
    } catch (e) {
      die(e.message);
    }
    try {
      const added = addServer({
        name: entry.id,
        command: resolved.command,
        args: resolved.args,
        env: resolved.env,
      });
      console.log(`${c.green("✓")} Installed MCP server "${c.cyan(entry.id)}".`);
      console.log(c.gray(`  ${added.command}${added.args ? " " + added.args.join(" ") : ""}`));
      console.log(c.gray("Restart aether (or run `aether`) to attach it."));
    } catch (e) {
      die(e.message || String(e));
    }
    return;
  }

  die(
    `aether mcp: unknown subcommand "${sub}".\n` +
      "Try one of: list, add, install, search, remove.",
  );
}

function promptUser(question) {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error("Interactive prompt unavailable (non-TTY)"));
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

main().catch((err) => {
  console.error(errorLine(err.message || String(err)));
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
