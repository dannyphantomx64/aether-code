// Agent loop. Streams each turn from /api/v1/agent/stream, prints text deltas
// in real-time, executes any tool calls, loops until the model returns no
// tool calls (task done) or max-turns is reached.

import os from "node:os";
import path from "node:path";
import { agentTurnStream, AetherError } from "./api.js";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
import { unnamespaceToolName } from "./mcp.js";
import { loadAllSkills, selectSkills, renderSkillsBlock } from "./skills.js";
import { c, divider, turn, toolLabel, toolSummary, makeTokenStripper, errorLine, startSpinner } from "./render.js";

const DEFAULT_MAX_TURNS = 25;

// Environment block prepended to the first user message so the model can
// resolve named locations to real absolute paths.
function envContext(cwd) {
  const home = os.homedir();
  const desktop = path.join(home, "Desktop");
  const documents = path.join(home, "Documents");
  return (
    `[environment]\n` +
    `os: ${process.platform}\n` +
    `cwd: ${cwd}\n` +
    `home: ${home}\n` +
    `desktop: ${desktop}\n` +
    `documents: ${documents}\n` +
    `When the user names a location ("my desktop", "home", "documents"), write to ` +
    `the matching ABSOLUTE path above (e.g. desktop -> ${desktop}). Otherwise ` +
    `work under the cwd. Use absolute paths when a specific location is named.\n` +
    `[/environment]\n\n`
  );
}

export async function runAgent({
  initialPrompt,
  priorMessages,
  cwd,
  autoYes = false,
  unsafePaths = false,
  maxTurns = DEFAULT_MAX_TURNS,
  onTokens = () => {},
  // Optional MCPManager. When provided, its tools are merged into the agent's
  // toolset and tool calls prefixed `mcp__` are routed to it instead of the
  // built-in executeTool.
  mcpManager = null,
}) {
  // Merge built-in tools with MCP-provided tools. MCP tools come second so
  // any name collision (unlikely given namespacing, but defense in depth)
  // resolves to the built-in.
  const tools = mcpManager
    ? [...TOOL_DEFINITIONS, ...mcpManager.getToolDefinitions()]
    : TOOL_DEFINITIONS;

  // Load skills once per runAgent call (bundled + user-installed). They
  // get selected per-turn against the current prompt + any file paths the
  // model has read so far. Loading errors are non-fatal — a bad skill file
  // shouldn't kill the agent.
  let allSkills = [];
  try {
    allSkills = loadAllSkills();
  } catch (e) {
    process.stderr.write(c.yellow(`(skill load failed: ${e.message})\n`));
  }
  const referencedPaths = [];
  // Two callers: one-shot (initialPrompt only, fresh conversation) and REPL
  // (priorMessages + initialPrompt to continue an ongoing chat).
  // On the FIRST message of a session, prepend an environment block so the
  // model knows real absolute paths (cwd / home / desktop). Without it, "build
  // X on my desktop" became `mkdir X` in whatever dir aether was launched from
  // (e.g. C:\WINDOWS\system32). Only prepended once — later turns carry it in
  // history.
  const messages = priorMessages
    ? [...priorMessages, { role: "user", content: initialPrompt }]
    : [{ role: "user", content: envContext(cwd) + initialPrompt }];
  let totalCredits = 0;
  let totalIn = 0;
  let totalOut = 0;
  let lastBalance = null;
  // Loop guard: count identical (name+args) tool calls across the whole run so a
  // confused model can't burn turns re-running the same call (e.g. glob *.md x9).
  const callCounts = new Map();

  for (let i = 0; i < maxTurns; i++) {
    // No turn header and no leading blank here — each step (assistant text and
    // each tool label) begins with its own "\n● ", so spacing stays exactly one
    // blank line per step instead of stacking up.

    // Stream the assistant's response. Print text deltas as they arrive,
    // along with tool-call announcements as soon as the model commits to
    // calling a particular tool (i.e. the `name` arrives in the stream).
    const announced = new Set();
    let lastWasText = false;
    const stripper = makeTokenStripper();

    // Select skills for this turn against the current user prompt + any
    // paths the model has read so far. Prepend the matching skills' bodies
    // to the last user message of a shallow-cloned messages array — we
    // don't want skill text accumulating in the persisted history, only
    // being available to the model for the turn where it's relevant.
    const turnMessages = buildTurnMessages(messages, allSkills, referencedPaths);

    let res;
    // "Thinking" spinner: shown from request-send until the first token or tool
    // call arrives, so the wait doesn't look dead. Stopped exactly once.
    const spinner = startSpinner("thinking");
    let spinStopped = false;
    const stopSpin = () => { if (!spinStopped) { spinStopped = true; spinner.stop(); } };
    try {
      res = await agentTurnStream({
        messages: turnMessages,
        tools,
        onDelta: (text) => {
          // Buffered strip of leaked model channel/control tokens (which can
          // be split across stream chunks) before display.
          const clean = stripper.push(text);
          if (!clean) return;
          stopSpin();
          if (!lastWasText) {
            process.stdout.write("\n" + c.cyan("● "));
            lastWasText = true;
          }
          process.stdout.write(clean);
        },
        onToolCallDelta: (delta) => {
          // Just close the streamed text line when the model starts a tool
          // call — the clean label is printed at execution time, so no noisy
          // "preparing args" placeholder here.
          if (delta.name && !announced.has(delta.index)) {
            stopSpin();
            announced.add(delta.index);
            if (lastWasText) process.stdout.write("\n");
            lastWasText = false;
          }
        },
      });
    } catch (err) {
      stopSpin();
      if (err instanceof AetherError) {
        return { ok: false, error: err, totalCredits, totalIn, totalOut, balance: lastBalance, messages };
      }
      throw err;
    }
    stopSpin(); // ensure it's cleared even if the turn produced no output

    // Flush any held-back partial token, then close the line.
    const tail = stripper.flush();
    if (tail) {
      if (!lastWasText) { process.stdout.write("\n" + c.cyan("● ")); lastWasText = true; }
      process.stdout.write(tail);
    }
    if (lastWasText) process.stdout.write("\n");
    totalCredits += res.creditsCharged ?? 0;
    totalIn += res.usage?.prompt_tokens ?? 0;
    totalOut += res.usage?.completion_tokens ?? 0;
    if (typeof res.balanceAfter === "number") lastBalance = res.balanceAfter;
    onTokens({ totalCredits, totalIn, totalOut, balance: lastBalance });
    // Per-turn cost line removed for a cleaner look — the session summary at the
    // end carries the totals.

    // Push assistant message into history
    messages.push({
      role: "assistant",
      content: res.message.content,
      tool_calls: res.message.tool_calls,
    });

    const toolCalls = res.message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return { ok: true, totalCredits, totalIn, totalOut, turns: i + 1, balance: lastBalance, messages };
    }

    // Execute each tool call. Show the actual args (now that we have them
    // fully assembled) and run.
    for (const call of toolCalls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* leave empty */ }
      // todo_write renders its own Plan box, so it returns an empty label.
      const label = toolLabel(call.function.name, args);
      if (label) console.log("\n" + c.cyan("●") + " " + label);

      // Loop guard — short-circuit a tool call we've already run 3+ times with
      // the same args, and tell the model to change approach instead of looping.
      const sig = `${call.function.name}:${call.function.arguments || ""}`;
      const seen = (callCounts.get(sig) || 0) + 1;
      callCounts.set(sig, seen);
      if (seen > 3) {
        console.log("  " + c.red("└─") + " " + c.gray("skipped (repeated call)"));
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content:
            "STOP: you have already run this exact tool call 3 times and the result will not change. Do NOT call it again. " +
            "If you were looking for a file that doesn't exist, create it with write_file. Otherwise change approach or finish and summarize.",
        });
        continue;
      }

      // Route to MCP if the tool name is namespaced (mcp__server__tool);
      // otherwise execute the built-in tool. unnamespaceToolName returns
      // null for non-MCP names, which is our cheap dispatch test.
      const slow = call.function.name === "web_search" || call.function.name === "web_fetch";
      const tspin = slow ? startSpinner(call.function.name === "web_search" ? "searching the web" : "fetching page") : null;
      let result;
      try {
        if (mcpManager && unnamespaceToolName(call.function.name)) {
          result = await mcpManager.callTool(call.function.name, args);
        } else {
          result = await executeTool(call, { cwd, autoYes, unsafePaths });
        }
      } finally {
        if (tspin) tspin.stop();
      }

      // Track paths the model has touched. Skills with path-pattern triggers
      // (e.g. RE skill on `*.exe`) match against this list, so reading a
      // binary in turn 3 can activate the RE skill in turn 4.
      if (call.function.name === "read_file" || call.function.name === "edit_file" || call.function.name === "write_file") {
        if (typeof args.path === "string") referencedPaths.push(args.path);
      }
      const summary = toolSummary(call.function.name, result);
      if (summary) console.log(summary);

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.output ?? (result.ok ? "(no output)" : "Failed."),
      });
    }
  }

  console.log(c.yellow(`\nReached max turns (${maxTurns}). Stopping.`));
  return { ok: false, error: new Error("Max turns reached"), totalCredits, totalIn, totalOut, balance: lastBalance, messages };
}

/**
 * Per-turn skill injection. Selects skills against the latest user message
 * + paths the model has touched, then prepends matching bodies onto the
 * final user message of a shallow-cloned messages array. Returns the
 * original array unchanged when no skills match — zero overhead on the
 * no-skills path.
 *
 * Why prepend to user message instead of inserting a system message:
 * the server's AGENT_SYSTEM check skips its own system prompt when ANY
 * system message is present in the request. Adding a skills system
 * message would silently delete the server's discipline — which is
 * worse than no skills at all. Prepending into the user message keeps
 * both layers active.
 */
function buildTurnMessages(messages, allSkills, referencedPaths) {
  if (allSkills.length === 0) return messages;
  // Find the latest user message — that's where the current task lives.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return messages;
  const prompt = typeof messages[lastUserIdx].content === "string"
    ? messages[lastUserIdx].content
    : "";
  const active = selectSkills({ skills: allSkills, prompt, referencedPaths });
  if (active.length === 0) return messages;
  const block = renderSkillsBlock(active);
  const cloned = [...messages];
  cloned[lastUserIdx] = {
    ...cloned[lastUserIdx],
    content: `${block}\n\n---\n\n${prompt}`,
  };
  return cloned;
}
