// API client.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config.js";

// Resolve our own version once for the User-Agent header — read from
// package.json so it can't drift (the file previously sent three different
// hardcoded versions across three calls).
function readVersion() {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version || "0";
  } catch {
    return "0";
  }
}
const USER_AGENT = `aether-code/${readVersion()}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch() with bounded exponential-backoff retries. Retries on thrown network
 * errors (DNS/reset/offline blip) and transient 5xx; never retries 4xx
 * (auth/credit/validation — a retry won't help). Body is always a small JSON
 * string, so resending is safe. For the streaming endpoint only the initial
 * connection is retried.
 */
export async function fetchWithRetry(url, options, { retries = 2, baseDelay = 500, onRetry } = {}) {
  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(url, options);
      if (res.status >= 500 && attempt < retries) {
        // Release the connection back to the pool before retrying — an
        // unconsumed body keeps the socket open (undici won't reuse it).
        res.body?.cancel().catch(() => {});
        attempt++;
        if (onRetry) onRetry(attempt, `HTTP ${res.status}`);
        await sleep(baseDelay * 2 ** (attempt - 1));
        continue;
      }
      return res;
    } catch (e) {
      if (attempt < retries) {
        attempt++;
        if (onRetry) onRetry(attempt, e.message);
        await sleep(baseDelay * 2 ** (attempt - 1));
        continue;
      }
      throw e;
    }
  }
}

function defaultOnRetry(attempt, why) {
  process.stderr.write(`  ⟳ connection issue (${why}) — retry ${attempt}…\n`);
}

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
    res = await fetchWithRetry(`${baseUrl}/api/v1/me`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": USER_AGENT,
      },
    }, { onRetry: defaultOnRetry });
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
  model,
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
    res = await fetchWithRetry(`${baseUrl}/api/v1/agent/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        messages,
        tools,
        max_tokens: maxTokens,
        temperature,
        ...(model ? { model } : {}),
      }),
    }, { onRetry: defaultOnRetry });
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

  // Dispatch a single parsed SSE "data:" line.
  const handleLine = (line) => {
    if (!line.startsWith("data:")) return;
    const json = line.slice(5).trim(); // .trim() also drops a CRLF trailing \r
    if (!json) return;
    let evt;
    try { evt = JSON.parse(json); } catch { return; }
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
  };

  // Watchdog: if the open stream stalls (no bytes) for too long, abort instead
  // of hanging the CLI forever.
  const READ_TIMEOUT_MS = 120_000;
  const readOnce = () => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new AetherError("Stream stalled — no data for 120s", "STREAM_TIMEOUT", 0)),
        READ_TIMEOUT_MS,
      );
    });
    return Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
  };

  try {
    while (true) {
      const { value, done } = await readOnce();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    }
    // Flush any multibyte bytes the decoder is holding, then process a final
    // line that arrived without a trailing newline (else the "done" event with
    // credits/usage is silently dropped).
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer);
  } catch (e) {
    reader.cancel().catch(() => {});
    throw e;
  } finally {
    try { reader.releaseLock(); } catch { /* already released / pending — ignore */ }
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
export async function agentTurn({ messages, tools, maxTokens, temperature, model }) {
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
    res = await fetchWithRetry(`${baseUrl}/api/v1/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        messages,
        tools,
        max_tokens: maxTokens,
        temperature,
        ...(model ? { model } : {}),
      }),
    }, { onRetry: defaultOnRetry });
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
