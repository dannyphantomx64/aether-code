// End-to-end MCP integration test against a mock server that lives in
// test/fixtures/mock-mcp-server.js. Proves the real subprocess + JSON-RPC
// wiring works — unit tests alone wouldn't catch a busted handshake or
// a stdio-buffering bug.
//
// Slow (spawns a node subprocess) but tightly bounded: skips if anything
// hangs longer than the harness timeout.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MCPManager } from "../src/mcp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = path.join(HERE, "fixtures", "mock-mcp-server.js");

describe("MCPManager — integration against mock server", () => {
  let manager;

  before(async () => {
    manager = new MCPManager();
    await manager.start({
      mcpServers: {
        mock: { command: process.execPath, args: [MOCK_SERVER] },
      },
    });
  });

  after(async () => {
    if (manager) await manager.shutdown();
  });

  test("attached without errors", () => {
    assert.equal(manager.servers.size, 1);
    assert.deepEqual(manager.startErrors, []);
  });

  test("discovered the mock server's `echo` tool with namespaced name", () => {
    const defs = manager.getToolDefinitions();
    assert.equal(defs.length, 1);
    assert.equal(defs[0].function.name, "mcp__mock__echo");
    assert.match(defs[0].function.description, /Echo back/);
    assert.equal(defs[0].function.parameters.type, "object");
  });

  test("callTool routes to the right server and returns text content", async () => {
    const r = await manager.callTool("mcp__mock__echo", { text: "hello world" });
    assert.equal(r.ok, true);
    assert.equal(r.output, "echo: hello world");
  });

  test("callTool on a tool the server doesn't have returns an error result", async () => {
    const r = await manager.callTool("mcp__mock__nonexistent", {});
    // Server returns JSON-RPC error → SDK turns into thrown error → manager returns failed result
    assert.equal(r.ok, false);
    assert.match(r.output, /failed|unknown/i);
  });
});
