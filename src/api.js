// API client.

import { getConfig } from "./config.js";

/**
 * Free balance + plan check via /api/v1/me. Doesn't charge credits.
 */
export async function fetchBalance() {
  const { apiKey, baseUrl } = getConfig();
  if (!apiKey) {
    throw new AetherError(
      "No API key. Set AETHER_API_KEY or run `aether config set <key>`.",
      "NO_API_KEY",
      0,
    );
  }
  let res;
  try {
    res = await fetch(`${baseUrl}/api/v1/me`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "aether-code/0.2.0",
      },
    });
  } catch (e) {
    throw new AetherError(`Network error: ${e.message}`, "NETWORK", 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const code = data?.code || `HTTP_${res.status}`;
    const msg = data?.error || `${res.status} ${res.statusText}`;
    throw new AetherError(msg, code, res.status, data);
  }
  return data; // { plan, role, planCredits, topupCredits, balance, isSuspended, rate }
}

export class AetherError extends Error {
  constructor(message, code, status, data) {
    super(message);
    this.name = "AetherError";
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

/**
 * Streaming agent turn. Calls /api/v1/agent/stream and invokes the supplied
 * callbacks as events arrive. Returns the assembled assistant message + final
 * usage/credit info once the stream ends.
 *
 * Event handlers (all optional):
 *   onDelta(text)            — text fragment from the model
 *   onToolCallDelta(part)    — partial tool call: { index, id?, name?, args_delta? }
 *   onFinish(reason)         — per-choice finish reason ("stop" | "tool_calls" | "length")
 *
 * Returns:
 *   { message: { role:"assistant", content, tool_calls }, finish_reason,
 *     creditsCharged, balanceAfter, usage }
 */
export async function agentTurnStream({
  messages,
  tools,
  maxTokens,
  temperature,
  onDelta,
  onToolCallDelta,
  onFinish,
}) {
  const { apiKey, baseUrl } = getConfig();
  if (!apiKey) {
    throw new AetherError(
      "No API key. Set AETHER_API_KEY or run `aether config set <key>`.",
      "NO_API_KEY",
      0,
    );
  }

  let res;
  try {
    res = await fetch(`${baseUrl}/api/v1/agent/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "aether-code/0.1.0",
      },
      body: JSON.stringify({
        messages,
        tools,
        max_tokens: maxTokens,
        temperature,
      }),
    });
  } catch (e) {
    throw new AetherError(`Network error: ${e.message}`, "NETWORK", 0);
  }

  // Non-streaming JSON error response (auth, credit, validation failures)
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    const code = data?.code || `HTTP_${res.status}`;
    const msg = data?.error || `${res.status} ${res.statusText}`;
    throw new AetherError(msg, code, res.status, data);
  }
  if (!res.body) throw new AetherError("Response has no body", "NO_BODY", res.status);

  // Accumulate streaming state
  let textBuf = "";
  const toolBuf = new Map(); // index -> { id, name, args }
  let finishReason = "stop";
  let creditsCharged = 0;
  let balanceAfter = null;
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  let streamError = null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      let evt;
      try { evt = JSON.parse(json); } catch { continue; }
      if (evt.kind === "delta") {
        textBuf += evt.content;
        if (onDelta) onDelta(evt.content);
      } else if (evt.kind === "tool_call_delta") {
        const slot = toolBuf.get(evt.index) || { id: undefined, name: undefined, args: "" };
        if (evt.id) slot.id = evt.id;
        if (evt.name) slot.name = evt.name;
        if (evt.args_delta) slot.args += evt.args_delta;
        toolBuf.set(evt.index, slot);
        if (onToolCallDelta) onToolCallDelta(evt);
      } else if (evt.kind === "finish") {
        finishReason = evt.reason;
        if (onFinish) onFinish(evt.reason);
      } else if (evt.kind === "done") {
        creditsCharged = evt.creditsCharged ?? 0;
        balanceAfter = evt.balanceAfter ?? null;
        usage = evt.usage ?? usage;
      } else if (evt.kind === "error") {
        streamError = evt.error;
      }
    }
  }

  if (streamError) {
    throw new AetherError(streamError, "STREAM_ERROR", 0);
  }

  // Assemble final tool_calls in stable index order
  const tool_calls = [...toolBuf.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, slot]) => ({
      id: slot.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      type: "function",
      function: { name: slot.name || "", arguments: slot.args || "" },
    }));

  return {
    message: {
      role: "assistant",
      content: textBuf || null,
      tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
    },
    finish_reason: finishReason,
    creditsCharged,
    balanceAfter,
    usage,
  };
}

/**
 * Non-streaming variant — kept as a fallback for environments where SSE is
 * problematic (corporate proxies, weird client setups). The CLI defaults to
 * streaming.
 */
export async function agentTurn({ messages, tools, maxTokens, temperature }) {
  const { apiKey, baseUrl } = getConfig();
  if (!apiKey) {
    throw new AetherError(
      "No API key. Set AETHER_API_KEY env var or run `aether-cli config set <key>`.",
      "NO_API_KEY",
      0,
    );
  }

  let res;
  try {
    res = await fetch(`${baseUrl}/api/v1/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "aether-code/0.1.0",
      },
      body: JSON.stringify({
        messages,
        tools,
        max_tokens: maxTokens,
        temperature,
      }),
    });
  } catch (e) {
    throw new AetherError(`Network error: ${e.message}`, "NETWORK", 0);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }

  if (!res.ok) {
    const code = (data && data.code) || `HTTP_${res.status}`;
    const msg = (data && data.error) || `${res.status} ${res.statusText}`;
    throw new AetherError(msg, code, res.status, data);
  }
  return data;
}
