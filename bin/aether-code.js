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
import { c, errorLine, divider } from "../src/render.js";

const VERSION = "0.3.0";

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

  const prompt = args._.join(" ").trim();

  // No task → drop into interactive REPL (Claude-CLI-style)
  if (!prompt) {
    if (cwd !== process.cwd()) process.chdir(cwd);
    await runRepl({ cwd, autoYes, maxTurns });
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

  const result = await runAgent({
    initialPrompt: prompt,
    cwd,
    autoYes,
    unsafePaths,
    maxTurns,
  });

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

main().catch((err) => {
  console.error(errorLine(err.message || String(err)));
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
