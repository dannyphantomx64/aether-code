// Tests for the API client: retry/backoff behavior + the streaming SSE parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry, agentTurnStream } from "../src/api.js";

function withFetch(fake, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = fake;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = orig; });
}

function sseResponse(lines, status = 200) {
  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

test("fetchWithRetry retries a 503 then succeeds", async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return calls < 2 ? new Response("", { status: 503 }) : new Response("ok", { status: 200 });
  }, async () => {
    const res = await fetchWithRetry("http://x", {}, { retries: 2, baseDelay: 1 });
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
  });
});

test("fetchWithRetry does NOT retry a 4xx", async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return new Response("", { status: 401 }); }, async () => {
    const res = await fetchWithRetry("http://x", {}, { retries: 2, baseDelay: 1 });
    assert.equal(res.status, 401);
    assert.equal(calls, 1);
  });
});

test("fetchWithRetry retries a thrown network error then gives up", async () => {
  let calls = 0;
  await withFetch(async () => { calls++; throw new TypeError("fetch failed"); }, async () => {
    await assert.rejects(() => fetchWithRetry("http://x", {}, { retries: 2, baseDelay: 1 }));
    assert.equal(calls, 3);
  });
});

test("agentTurnStream assembles text + tool calls + usage from an SSE stream", async () => {
  process.env.AETHER_API_KEY = "ak_live_test";
  await withFetch(async () => sseResponse([
    `data: ${JSON.stringify({ kind: "delta", content: "Hello " })}\n`,
    `data: ${JSON.stringify({ kind: "delta", content: "world" })}\n`,
    `data: ${JSON.stringify({ kind: "tool_call_delta", index: 0, id: "c1", name: "read_file", args_delta: '{"path":' })}\n`,
    `data: ${JSON.stringify({ kind: "tool_call_delta", index: 0, args_delta: '"a.txt"}' })}\n`,
    `data: ${JSON.stringify({ kind: "finish", reason: "tool_calls" })}\n`,
    `data: ${JSON.stringify({ kind: "done", creditsCharged: 2, balanceAfter: 100, usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n`,
  ]), async () => {
    const r = await agentTurnStream({ messages: [], tools: [] });
    assert.equal(r.message.content, "Hello world");
    assert.equal(r.finish_reason, "tool_calls");
    assert.equal(r.message.tool_calls.length, 1);
    assert.equal(r.message.tool_calls[0].function.name, "read_file");
    assert.equal(r.message.tool_calls[0].function.arguments, '{"path":"a.txt"}');
    assert.equal(r.creditsCharged, 2);
    assert.equal(r.usage.completion_tokens, 7);
  });
});

test("agentTurnStream surfaces a stream-level error event as AetherError", async () => {
  process.env.AETHER_API_KEY = "ak_live_test";
  await withFetch(async () => sseResponse([
    `data: ${JSON.stringify({ kind: "error", error: "model exploded" })}\n`,
  ]), async () => {
    await assert.rejects(() => agentTurnStream({ messages: [], tools: [] }), /model exploded/);
  });
});
