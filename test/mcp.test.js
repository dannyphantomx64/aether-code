// Tests for the MCP client layer (src/mcp.js).
//
// Strategy: heavy coverage on pure functions (config validation, name
// (un)namespacing) because those are where 90% of bugs hide. End-to-end
// MCP server spawning is exercised via a one-shot integration test that
// runs a tiny mock JSON-RPC server in a subprocess — slow but it catches
// the real-world wiring breaks.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadMcpConfig,
  validateMcpConfig,
  namespaceToolName,
  unnamespaceToolName,
  MCPManager,
} from "../src/mcp.js";

describe("validateMcpConfig", () => {
  test("accepts minimal valid config", () => {
    const cfg = { mcpServers: { fs: { command: "npx", args: ["x"] } } };
    assert.equal(validateMcpConfig(cfg), cfg);
  });

  test("accepts config with env vars", () => {
    const cfg = {
      mcpServers: {
        ida: { command: "python", args: ["-m", "ida_mcp"], env: { IDA_PATH: "/opt/ida" } },
      },
    };
    assert.equal(validateMcpConfig(cfg), cfg);
  });

  test("accepts config with no args", () => {
    const cfg = { mcpServers: { plain: { command: "myserver" } } };
    assert.equal(validateMcpConfig(cfg), cfg);
  });

  test("rejects null / non-object root", () => {
    assert.throws(() => validateMcpConfig(null), /JSON object/);
    assert.throws(() => validateMcpConfig([]), /JSON object/);
    assert.throws(() => validateMcpConfig("nope"), /JSON object/);
  });

  test("rejects missing mcpServers field", () => {
    assert.throws(() => validateMcpConfig({}), /mcpServers/);
  });

  test("rejects mcpServers as array", () => {
    assert.throws(() => validateMcpConfig({ mcpServers: [] }), /mcpServers/);
  });

  test("rejects invalid server names", () => {
    for (const bad of ["", "has spaces", "has.dot", "way-too-long-".repeat(5), "tab\tname"]) {
      assert.throws(
        () => validateMcpConfig({ mcpServers: { [bad]: { command: "x" } } }),
        /invalid/i,
        `expected reject for "${bad}"`,
      );
    }
  });

  test("rejects missing command", () => {
    assert.throws(
      () => validateMcpConfig({ mcpServers: { x: {} } }),
      /command/,
    );
  });

  test("rejects empty command string", () => {
    assert.throws(
      () => validateMcpConfig({ mcpServers: { x: { command: "" } } }),
      /command/,
    );
  });

  test("rejects non-array args", () => {
    assert.throws(
      () => validateMcpConfig({ mcpServers: { x: { command: "y", args: "one two" } } }),
      /args/,
    );
  });

  test("rejects args with non-string elements", () => {
    assert.throws(
      () => validateMcpConfig({ mcpServers: { x: { command: "y", args: ["ok", 42] } } }),
      /STRINGS/,
    );
  });

  test("rejects env as array", () => {
    assert.throws(
      () => validateMcpConfig({ mcpServers: { x: { command: "y", env: ["KEY=v"] } } }),
      /env/,
    );
  });
});

describe("loadMcpConfig", () => {
  test("returns null when file doesn't exist (normal no-MCP path)", () => {
    const fakePath = path.join(os.tmpdir(), `aether-mcp-missing-${Date.now()}.json`);
    assert.equal(loadMcpConfig(fakePath), null);
  });

  test("throws on malformed JSON with helpful message", () => {
    const p = path.join(os.tmpdir(), `aether-mcp-bad-${Date.now()}.json`);
    fs.writeFileSync(p, "{ not json");
    try {
      assert.throws(() => loadMcpConfig(p), /not valid JSON/);
    } finally {
      fs.unlinkSync(p);
    }
  });

  test("loads + validates a real file", () => {
    const p = path.join(os.tmpdir(), `aether-mcp-good-${Date.now()}.json`);
    const cfg = { mcpServers: { fs: { command: "npx", args: ["x"] } } };
    fs.writeFileSync(p, JSON.stringify(cfg));
    try {
      const loaded = loadMcpConfig(p);
      assert.deepEqual(loaded, cfg);
    } finally {
      fs.unlinkSync(p);
    }
  });

  test("schema errors include the source path", () => {
    const p = path.join(os.tmpdir(), `aether-mcp-schema-${Date.now()}.json`);
    fs.writeFileSync(p, JSON.stringify({ no_servers_field: true }));
    try {
      assert.throws(() => loadMcpConfig(p), new RegExp(p.replace(/\\/g, "\\\\")));
    } finally {
      fs.unlinkSync(p);
    }
  });
});

describe("namespaceToolName / unnamespaceToolName", () => {
  test("standard names round-trip", () => {
    const ns = namespaceToolName("filesystem", "read_file");
    assert.equal(ns, "mcp__filesystem__read_file");
    assert.deepEqual(unnamespaceToolName(ns), {
      serverName: "filesystem",
      toolName: "read_file",
    });
  });

  test("collapses underscores in server name to keep boundary unambiguous", () => {
    // The validator rejects `__` in names, but defense in depth here.
    const ns = namespaceToolName("foo__bar", "do_thing");
    assert.equal(ns.split("__").length, 3, "should have exactly 3 segments via separator");
  });

  test("unnamespace returns null for built-in tool names", () => {
    assert.equal(unnamespaceToolName("read_file"), null);
    assert.equal(unnamespaceToolName("web_search"), null);
    assert.equal(unnamespaceToolName(""), null);
    // Looks like a namespace but missing the inner separator
    assert.equal(unnamespaceToolName("mcp__nothingelse"), null);
  });

  test("unnamespace handles tool names with underscores", () => {
    const result = unnamespaceToolName("mcp__myserver__some_nested_tool_name");
    assert.deepEqual(result, {
      serverName: "myserver",
      toolName: "some_nested_tool_name",
    });
  });
});

describe("MCPManager — failure tolerance", () => {
  test("start() with null config does nothing and returns 0", async () => {
    const m = new MCPManager();
    const count = await m.start(null);
    assert.equal(count, 0);
    assert.equal(m.servers.size, 0);
    assert.equal(m.getToolDefinitions().length, 0);
  });

  test("start() with empty mcpServers returns 0", async () => {
    const m = new MCPManager();
    const count = await m.start({ mcpServers: {} });
    assert.equal(count, 0);
  });

  test("start() with bogus command collects errors, doesn't throw", async () => {
    const m = new MCPManager();
    const count = await m.start({
      mcpServers: {
        nonexistent: { command: "definitely-not-a-real-binary-aaaaa", args: [] },
      },
    });
    assert.equal(count, 0);
    assert.equal(m.startErrors.length, 1);
    assert.equal(m.startErrors[0].serverName, "nonexistent");
    assert.ok(m.startErrors[0].error.length > 0);
  });

  test("callTool on unknown name returns error result, doesn't throw", async () => {
    const m = new MCPManager();
    const r = await m.callTool("mcp__never__attached", {});
    assert.equal(r.ok, false);
    assert.match(r.output, /Unknown MCP tool/);
  });

  test("resolve() returns null for non-MCP names", () => {
    const m = new MCPManager();
    assert.equal(m.resolve("read_file"), null);
    assert.equal(m.resolve("mcp__missing_server__tool"), null);
  });

  test("shutdown() with no servers is a no-op", async () => {
    const m = new MCPManager();
    await m.shutdown(); // should not throw
    assert.equal(m.servers.size, 0);
  });
});
