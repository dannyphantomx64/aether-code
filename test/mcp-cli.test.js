// Tests for the `aether mcp` subcommand machinery (src/mcp-cli.js).
// Operates on a temp config path per test so we never touch the user's
// real ~/.aether/mcp.json.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addServer,
  removeServer,
  listServers,
  readConfig,
} from "../src/mcp-cli.js";

let tmpDir;
let tmpPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-mcp-test-"));
  tmpPath = path.join(tmpDir, "mcp.json");
});

afterEach(() => {
  // Best-effort cleanup. Tests are isolated by directory.
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* nothing to clean */ }
});

describe("addServer", () => {
  test("creates the config file when missing", () => {
    addServer({ configPath: tmpPath, name: "fs", command: "npx", args: ["-y", "server"] });
    assert.ok(fs.existsSync(tmpPath), "config file should exist after add");
    const cfg = JSON.parse(fs.readFileSync(tmpPath, "utf8"));
    assert.equal(cfg.mcpServers.fs.command, "npx");
    assert.deepEqual(cfg.mcpServers.fs.args, ["-y", "server"]);
  });

  test("creates parent directory if missing", () => {
    const deeper = path.join(tmpDir, "nested", "deeper", "mcp.json");
    addServer({ configPath: deeper, name: "x", command: "y" });
    assert.ok(fs.existsSync(deeper));
  });

  test("appends to an existing file without clobbering other servers", () => {
    addServer({ configPath: tmpPath, name: "fs", command: "a" });
    addServer({ configPath: tmpPath, name: "ida", command: "b" });
    const cfg = readConfig({ configPath: tmpPath });
    assert.equal(Object.keys(cfg.mcpServers).length, 2);
    assert.ok(cfg.mcpServers.fs);
    assert.ok(cfg.mcpServers.ida);
  });

  test("omits args field when no args provided", () => {
    addServer({ configPath: tmpPath, name: "plain", command: "myserver" });
    const cfg = JSON.parse(fs.readFileSync(tmpPath, "utf8"));
    assert.equal(cfg.mcpServers.plain.command, "myserver");
    assert.equal(cfg.mcpServers.plain.args, undefined);
  });

  test("omits env field when no env vars provided", () => {
    addServer({ configPath: tmpPath, name: "p", command: "c" });
    const cfg = JSON.parse(fs.readFileSync(tmpPath, "utf8"));
    assert.equal(cfg.mcpServers.p.env, undefined);
  });

  test("includes env field when provided", () => {
    addServer({
      configPath: tmpPath,
      name: "ida",
      command: "python",
      args: ["-m", "ida_pro_mcp"],
      env: { IDA_PATH: "/opt/ida" },
    });
    const cfg = JSON.parse(fs.readFileSync(tmpPath, "utf8"));
    assert.deepEqual(cfg.mcpServers.ida.env, { IDA_PATH: "/opt/ida" });
  });

  test("rejects duplicate name (helpful error)", () => {
    addServer({ configPath: tmpPath, name: "fs", command: "a" });
    assert.throws(
      () => addServer({ configPath: tmpPath, name: "fs", command: "b" }),
      /already exists|already configured/,
    );
  });

  test("rejects invalid server name", () => {
    assert.throws(
      () => addServer({ configPath: tmpPath, name: "has spaces", command: "x" }),
      /invalid/i,
    );
  });

  test("rejects empty command", () => {
    assert.throws(
      () => addServer({ configPath: tmpPath, name: "x", command: "" }),
      /command/,
    );
  });

  test("writes file as readable, indented JSON (not minified)", () => {
    addServer({ configPath: tmpPath, name: "x", command: "y", args: ["a"] });
    const raw = fs.readFileSync(tmpPath, "utf8");
    assert.match(raw, /\n  "mcpServers"/, "should be 2-space indented");
    assert.ok(raw.endsWith("\n"), "should end with trailing newline");
  });
});

describe("removeServer", () => {
  test("deletes an existing server", () => {
    addServer({ configPath: tmpPath, name: "a", command: "x" });
    addServer({ configPath: tmpPath, name: "b", command: "y" });
    removeServer({ configPath: tmpPath, name: "a" });
    const cfg = readConfig({ configPath: tmpPath });
    assert.equal(cfg.mcpServers.a, undefined);
    assert.ok(cfg.mcpServers.b);
  });

  test("errors when removing a server that doesn't exist", () => {
    addServer({ configPath: tmpPath, name: "a", command: "x" });
    assert.throws(
      () => removeServer({ configPath: tmpPath, name: "ghost" }),
      /not configured|not found/,
    );
  });

  test("errors when no config file exists", () => {
    assert.throws(
      () => removeServer({ configPath: tmpPath, name: "anything" }),
      /not configured|not found/,
    );
  });
});

describe("listServers", () => {
  test("returns [] when no config file", () => {
    assert.deepEqual(listServers({ configPath: tmpPath }), []);
  });

  test("returns empty array when mcpServers is empty", () => {
    fs.writeFileSync(tmpPath, JSON.stringify({ mcpServers: {} }));
    assert.deepEqual(listServers({ configPath: tmpPath }), []);
  });

  test("returns [name, config] tuples", () => {
    addServer({ configPath: tmpPath, name: "a", command: "x" });
    addServer({ configPath: tmpPath, name: "b", command: "y", args: ["z"] });
    const out = listServers({ configPath: tmpPath });
    assert.equal(out.length, 2);
    const map = Object.fromEntries(out);
    assert.equal(map.a.command, "x");
    assert.deepEqual(map.b.args, ["z"]);
  });
});

describe("readConfig (round-trip after writes)", () => {
  test("returns empty {mcpServers: {}} when file missing", () => {
    const cfg = readConfig({ configPath: tmpPath });
    assert.deepEqual(cfg, { mcpServers: {} });
  });

  test("throws on malformed JSON (don't silently destroy user state)", () => {
    fs.writeFileSync(tmpPath, "{ not valid json");
    assert.throws(() => readConfig({ configPath: tmpPath }), /JSON/);
  });
});
