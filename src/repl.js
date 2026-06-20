// Interactive REPL — Claude-CLI-style. Launched when `aether-code` is run
// without a task argument.
//
// Behaviors:
//   - Banner on startup (version, model, balance, cwd, mode)
//   - Persistent message history across prompts within the session
//   - Slash commands: /help, /exit, /clear, /balance, /cwd, /yes, /turns
//   - Bottom status line is rendered after each turn
//   - Ctrl+C: first press cancels in-progress turn, second press exits

import path from "node:path";
import { runAgent } from "./agent.js";
import { fetchBalance, AetherError } from "./api.js";
import { runSetup } from "./setup.js";
import { c, errorLine, boxLines, sideBySide } from "./render.js";
import { checkForUpdate } from "./update-check.js";
import { promptBox, EXIT_SIGNAL } from "./box-input.js";

const VERSION = "0.32.0";
const MODEL_NAME = "Aether Core";

// /model aliases → { id, name }. id=null = server default (gemma / Aether Core).
// Premium models are gated SERVER-SIDE: if you haven't purchased credits, the
// server transparently uses Core instead — selecting one here can't bypass that.
const MODEL_ALIASES = {
  core: { id: null, name: "Aether Core" },
  gemma: { id: null, name: "Aether Core" },
  ultra: { id: "claude-opus-4-6", name: "Aether Ultra" },
  opus: { id: "claude-opus-4-6", name: "Aether Ultra" },
};

const SHORTCUTS = `
  ${c.cyan("/help")}      Show this help
  ${c.cyan("/exit")}      Exit (or Ctrl+C twice)
  ${c.cyan("/clear")}     Clear conversation history (start fresh)
  ${c.cyan("/balance")}   Refresh and show credit balance
  ${c.cyan("/cwd")} ${c.gray("[path]")}    Show or change working directory
  ${c.cyan("/yes")}       Toggle auto-approve mode (skip y/N prompts)
  ${c.cyan("/turns")} ${c.gray("<n>")}     Set max turns per prompt (default 25)
  ${c.cyan("/model")} ${c.gray("[core|ultra]")}  Show or switch model (ultra=Opus — premium)

${c.gray("Anything else is sent to the agent as your next message.")}
${c.gray("Conversation history is kept across messages until you /clear.")}
`;

export async function runRepl({ cwd: initialCwd, autoYes: initialAutoYes, unsafePaths: initialUnsafePaths, maxTurns: initialMaxTurns, model: initialModel = null, mcpManager = null }) {
  const initialAlias = Object.values(MODEL_ALIASES).find((a) => a.id === initialModel);
  const state = {
    cwd: initialCwd,
    autoYes: !!initialAutoYes,
    unsafePaths: !!initialUnsafePaths,
    maxTurns: initialMaxTurns ?? 25,
    model: initialModel ?? null,
    modelName: initialAlias?.name ?? MODEL_NAME,
    messages: [], // accumulates across turns
    balance: null,
    sessionCredits: 0,
    sessionIn: 0,
    sessionOut: 0,
  };

  // Kick off the npm update check concurrently with the balance fetch so it
  // adds no startup latency; the nudge (if any) prints just under the banner.
  const updatePromise = checkForUpdate().catch(() => null);

  // Free balance check up front. If no key configured, walk through first-time
  // setup flow (open browser → paste key → verify → save).
  let needsSetup = false;
  try {
    const me = await fetchBalance();
    state.balance = me.balance;
    state.plan = me.plan;
  } catch (err) {
    if (err instanceof AetherError && (err.code === "NO_API_KEY" || err.status === 401)) {
      needsSetup = true;
    } else {
      // Transient network or other — surface but don't block
      console.log(c.gray(`(could not fetch balance: ${err.message})`));
    }
  }

  if (needsSetup) {
    const ok = await runSetup();
    if (!ok) {
      console.log(c.gray("Aborting — no valid API key."));
      process.exit(1);
    }
    // Re-fetch balance now that the key is saved
    try {
      const me = await fetchBalance();
      state.balance = me.balance;
      state.plan = me.plan;
    } catch { /* tolerate — banner just won't show balance */ }
  }

  printBanner(state);
  const updateNudge = await updatePromise;
  if (updateNudge) console.log(updateNudge + "\n");

  // Input: a bordered raw-mode box (box-input.js) — cmd.exe-safe and identical
  // everywhere. (Ink's live redraw ghosts in the legacy Windows console, so we
  // don't use it.) Each prompt is independent; the tool y/N prompts and the
  // ask_user menu run BETWEEN prompts in raw mode too, so nothing overlaps.
  const inputHistory = [];

  while (true) {
    const raw = await promptBox({ history: inputHistory });
    if (raw === EXIT_SIGNAL) { console.log(c.gray("bye.")); return; }
    const line = (raw ?? "").trim();
    if (!line) continue;

    // promptBox already echoes "› <line>" on submit, so no echo needed here.
    inputHistory.push(line);

    // Slash command?
    if (line.startsWith("/") || line === "?") {
      const handled = await handleSlash(line, state);
      if (handled === "exit") return;
      printStatusLine(state);
      continue;
    }

    // Otherwise — send as a message to the agent
    const result = await runAgent({
      initialPrompt: line,
      priorMessages: state.messages.length > 0 ? state.messages : undefined,
      cwd: state.cwd,
      autoYes: state.autoYes,
      unsafePaths: state.unsafePaths,
      model: state.model,
      maxTurns: state.maxTurns,
      mcpManager,
    });

    state.sessionCredits += result.totalCredits ?? 0;
    state.sessionIn += result.totalIn ?? 0;
    state.sessionOut += result.totalOut ?? 0;
    if (typeof result.balance === "number") state.balance = result.balance;
    if (result.messages) state.messages = result.messages;

    if (!result.ok && result.error) {
      console.log("\n" + errorLine(result.error.message || String(result.error)));
      // Don't kill the session on a single error — surface it and continue.
    }

    printStatusLine(state);
  }
}

/* ───────── slash commands ───────── */

async function handleSlash(line, state) {
  const [cmd, ...rest] = line.replace(/^\//, "").split(/\s+/);
  const arg = rest.join(" ").trim();

  switch ((cmd || "").toLowerCase()) {
    case "":
    case "help":
    case "?":
      console.log(SHORTCUTS);
      break;
    case "exit":
    case "quit":
    case "q":
      console.log(c.gray("bye."));
      return "exit";
    case "clear":
      state.messages = [];
      state.sessionCredits = 0;
      state.sessionIn = 0;
      state.sessionOut = 0;
      console.log(c.gray("Conversation cleared."));
      break;
    case "balance": {
      try {
        const me = await fetchBalance();
        state.balance = me.balance;
        state.plan = me.plan;
        console.log(
          c.cyan(`balance: ${me.balance.toLocaleString()} credits`) +
            c.gray(` · plan: ${me.plan} (${me.planCredits} plan + ${me.topupCredits} topup)`),
        );
      } catch (err) {
        console.log(errorLine(err.message || String(err)));
      }
      break;
    }
    case "cwd":
      if (arg) {
        const next = path.resolve(arg);
        try {
          process.chdir(next);
          state.cwd = next;
          console.log(c.gray(`cwd → ${state.cwd}`));
        } catch (err) {
          console.log(errorLine(err.message));
        }
      } else {
        console.log(c.gray(`cwd: ${state.cwd}`));
      }
      break;
    case "yes":
      state.autoYes = !state.autoYes;
      console.log(c.gray(`auto-yes: ${state.autoYes ? "on (writes/shells will skip y/N)" : "off"}`));
      break;
    case "turns": {
      const n = parseInt(arg, 10);
      if (!Number.isFinite(n) || n < 1 || n > 200) {
        console.log(errorLine(`/turns expects 1..200, got "${arg}"`));
      } else {
        state.maxTurns = n;
        console.log(c.gray(`max turns: ${state.maxTurns}`));
      }
      break;
    }
    case "model": {
      const key = (arg || "").trim().toLowerCase();
      if (!key) {
        console.log(c.gray(`model: ${state.modelName}`));
        console.log(c.gray("switch with /model core | ultra   (ultra=Opus — premium, need credits)"));
      } else if (MODEL_ALIASES[key]) {
        state.model = MODEL_ALIASES[key].id;
        state.modelName = MODEL_ALIASES[key].name;
        const premium = state.model !== null;
        console.log(
          c.gray(`model → ${c.cyan(state.modelName)}`) +
            (premium ? c.gray("  (premium — needs purchased credits, else falls back to Core)") : ""),
        );
      } else {
        console.log(errorLine(`Unknown model "${key}". Try: core, ultra`));
      }
      break;
    }
    default:
      console.log(errorLine(`Unknown command: /${cmd}. Type ${c.cyan("/help")} for shortcuts.`));
  }
  return null;
}

/* ───────── banner + status ───────── */

const visLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const shortenPath = (p, max) => (p.length <= max ? p : "..." + p.slice(p.length - max + 3));

// Short, hand-curated highlights shown in the "What's new" box. Update with
// notable releases — keep it to ~3 lines so it balances the banner height.
const WHATS_NEW = [
  "Files now save to your Desktop",
  "Live thinking spinner + loop guard",
  "Asks you when a task is unclear",
];

function printBanner(state) {
  const mode = state.autoYes ? (state.unsafePaths ? "skip-permissions" : "auto-yes") : "review mode";
  const credits = state.balance != null ? `${state.balance.toLocaleString()} credits` : "";
  const left = boxLines(
    [
      c.bold(c.magenta("aether")) + c.gray("  ·  ") + c.bold(state.modelName) + c.gray("   v" + VERSION),
      c.gray("uncensored AI coding agent"),
      c.gray((credits ? credits + " · " : "") + mode),
      c.gray(shortenPath(state.cwd, 52)),
    ],
    { color: c.magenta, padX: 2 },
  );
  const right = boxLines(
    [c.bold(c.cyan("What's new")), ...WHATS_NEW.map((s) => c.gray("• " + s))],
    { color: c.cyan, padX: 2 },
  );

  console.log("");
  const cols = process.stdout.columns || 80;
  // Only place the two boxes side by side when there's room; otherwise the
  // banner alone (narrow terminals would wrap and tear the second box).
  if (cols >= visLen(left[0]) + visLen(right[0]) + 4) {
    console.log(sideBySide(left, right, 3));
  } else {
    console.log(left.join("\n"));
  }
  console.log("");
}

function printStatusLine(state) {
  const parts = [];
  parts.push(c.gray(`session: ${state.sessionCredits} cr · ${state.sessionIn}→${state.sessionOut} tokens`));
  if (state.balance != null) parts.push(c.gray(`balance: ${state.balance.toLocaleString()}`));
  if (state.messages.length > 0) {
    parts.push(c.gray(`history: ${state.messages.length} msg${state.messages.length === 1 ? "" : "s"}`));
  }
  parts.push(c.cyan(state.autoYes ? "auto-yes" : "review"));
  console.log(c.dim(parts.join("  ·  ")));
}
