// Agent loop. Streams each turn from /api/v1/agent/stream, prints text deltas
// in real-time, executes any tool calls, loops until the model returns no
// tool calls (task done) or max-turns is reached.

import { agentTurnStream, AetherError } from "./api.js";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
import { c, divider, turn, toolHeader, toolResult, errorLine } from "./render.js";

const DEFAULT_MAX_TURNS = 25;

export async function runAgent({
  initialPrompt,
  priorMessages,
  cwd,
  autoYes = false,
  unsafePaths = false,
  maxTurns = DEFAULT_MAX_TURNS,
  onTokens = () => {},
}) {
  // Two callers: one-shot (initialPrompt only, fresh conversation) and REPL
  // (priorMessages + initialPrompt to continue an ongoing chat).
  const messages = priorMessages
    ? [...priorMessages, { role: "user", content: initialPrompt }]
    : [{ role: "user", content: initialPrompt }];
  let totalCredits = 0;
  let totalIn = 0;
  let totalOut = 0;
  let lastBalance = null;

  for (let i = 0; i < maxTurns; i++) {
    process.stdout.write("\n" + turn(i + 1) + "\n");

    // Stream the assistant's response. Print text deltas as they arrive,
    // along with tool-call announcements as soon as the model commits to
    // calling a particular tool (i.e. the `name` arrives in the stream).
    const announced = new Set();
    let lastWasText = false;

    let res;
    try {
      res = await agentTurnStream({
        messages,
        tools: TOOL_DEFINITIONS,
        onDelta: (text) => {
          if (!lastWasText) {
            process.stdout.write("  ");
            lastWasText = true;
          }
          process.stdout.write(text);
        },
        onToolCallDelta: (delta) => {
          // Print the tool header once we know the name (first chunk for that index)
          if (delta.name && !announced.has(delta.index)) {
            announced.add(delta.index);
            if (lastWasText) process.stdout.write("\n");
            lastWasText = false;
            process.stdout.write(c.cyan(c.bold(delta.name)) + c.gray("(...)") + c.gray(" preparing args\n"));
          }
        },
      });
    } catch (err) {
      if (err instanceof AetherError) {
        return { ok: false, error: err, totalCredits, totalIn, totalOut, balance: lastBalance, messages };
      }
      throw err;
    }

    // End-of-turn newline + cost meter
    if (lastWasText) process.stdout.write("\n");
    totalCredits += res.creditsCharged ?? 0;
    totalIn += res.usage?.prompt_tokens ?? 0;
    totalOut += res.usage?.completion_tokens ?? 0;
    if (typeof res.balanceAfter === "number") lastBalance = res.balanceAfter;
    onTokens({ totalCredits, totalIn, totalOut, balance: lastBalance });
    process.stdout.write(
      c.dim(`  ${res.creditsCharged ?? 0} cr · ${res.usage?.prompt_tokens ?? 0}→${res.usage?.completion_tokens ?? 0} tokens · finish: ${res.finish_reason}\n`),
    );

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
      console.log("");
      console.log(toolHeader(call.function.name, args));

      const result = await executeTool(call, { cwd, autoYes, unsafePaths });
      if (result.output) {
        const preview = result.output.length > 800 ? result.output.slice(0, 800) + "\n…(truncated)" : result.output;
        console.log(toolResult(preview, result.ok));
      }

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
