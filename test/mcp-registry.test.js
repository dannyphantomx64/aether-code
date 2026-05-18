// Tests for the curated MCP registry (src/mcp-registry.js).
// Pure functions only — no spawning, no fs.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MCP_REGISTRY,
  findRegistryEntry,
  resolveEntry,
  searchRegistry,
  suggestSimilar,
} from "../src/mcp-registry.js";

describe("MCP_REGISTRY contract — every entry well-formed", () => {
  test("registry is non-empty", () => {
    assert.ok(MCP_REGISTRY.length > 0);
  });

  test("every entry has an id, command, args, description, tags, source", () => {
    for (const e of MCP_REGISTRY) {
      assert.equal(typeof e.id, "string", `entry missing id: ${JSON.stringify(e)}`);
      assert.equal(typeof e.command, "string", `entry "${e.id}" missing command`);
      assert.ok(Array.isArray(e.args), `entry "${e.id}".args must be an array`);
      assert.equal(typeof e.description, "string", `entry "${e.id}" missing description`);
      assert.ok(Array.isArray(e.tags), `entry "${e.id}".tags must be an array`);
      assert.ok(["official", "community"].includes(e.source), `entry "${e.id}" bad source: ${e.source}`);
    }
  });

  test("ids match the mcp.js name validator regex", () => {
    const idRe = /^[a-z0-9_-]{1,40}$/i;
    for (const e of MCP_REGISTRY) {
      assert.match(e.id, idRe, `id "${e.id}" violates mcp.js naming rules`);
    }
  });

  test("no duplicate ids", () => {
    const ids = MCP_REGISTRY.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate id in registry");
  });

  test("every required placeholder is referenced somewhere in args or env", () => {
    for (const e of MCP_REGISTRY) {
      const referenced = new Set();
      const collect = (s) => {
        for (const m of String(s).matchAll(/\{([a-zA-Z0-9_]+)\}/g)) referenced.add(m[1]);
      };
      (e.args ?? []).forEach(collect);
      Object.values(e.env ?? {}).forEach(collect);
      for (const req of e.requires ?? []) {
        assert.ok(referenced.has(req), `entry "${e.id}": "${req}" in requires but never used in args/env`);
      }
      for (const req of e.requiresEnv ?? []) {
        assert.ok(referenced.has(req), `entry "${e.id}": "${req}" in requiresEnv but never used`);
      }
    }
  });

  test("every entry that prompts users has a prompt message for every required placeholder", () => {
    for (const e of MCP_REGISTRY) {
      const allReq = [...(e.requires ?? []), ...(e.requiresEnv ?? [])];
      for (const k of allReq) {
        assert.ok(
          e.prompts && typeof e.prompts[k] === "string",
          `entry "${e.id}": missing prompt for "${k}"`,
        );
      }
    }
  });

  test("expected first-party servers are present", () => {
    const expected = ["filesystem", "github", "postgres", "playwright", "puppeteer"];
    const ids = new Set(MCP_REGISTRY.map((e) => e.id));
    for (const id of expected) {
      assert.ok(ids.has(id), `expected registry entry "${id}" missing`);
    }
  });
});

describe("findRegistryEntry", () => {
  test("returns the matching entry by id", () => {
    const e = findRegistryEntry("filesystem");
    assert.ok(e);
    assert.equal(e.id, "filesystem");
  });

  test("returns null for unknown id", () => {
    assert.equal(findRegistryEntry("definitely-not-real"), null);
  });
});

describe("resolveEntry — placeholder substitution", () => {
  test("substitutes a placeholder into args", () => {
    const e = findRegistryEntry("filesystem");
    const r = resolveEntry(e, { path: "/tmp/data" });
    assert.equal(r.command, "npx");
    assert.ok(r.args.includes("/tmp/data"));
    assert.ok(!r.args.some((a) => a.includes("{path}")));
  });

  test("substitutes a placeholder into env", () => {
    const e = findRegistryEntry("github");
    const r = resolveEntry(e, { token: "ghp_abc123" });
    assert.equal(r.env.GITHUB_PERSONAL_ACCESS_TOKEN, "ghp_abc123");
  });

  test("throws when a required placeholder is missing", () => {
    const e = findRegistryEntry("filesystem");
    assert.throws(() => resolveEntry(e, {}), /Missing required value for \{path\}/);
  });

  test("throws when required placeholder is empty string", () => {
    const e = findRegistryEntry("filesystem");
    assert.throws(() => resolveEntry(e, { path: "" }), /Missing required value/);
  });

  test("no-placeholder entries resolve cleanly with empty values", () => {
    const e = findRegistryEntry("puppeteer");
    const r = resolveEntry(e, {});
    assert.equal(r.command, "npx");
    assert.equal(r.args.length > 0, true);
    assert.deepEqual(r.env, {});
  });

  test("entries with multiple env placeholders all substitute", () => {
    const e = findRegistryEntry("slack");
    const r = resolveEntry(e, { bot_token: "xoxb-test", team_id: "T123" });
    assert.equal(r.env.SLACK_BOT_TOKEN, "xoxb-test");
    assert.equal(r.env.SLACK_TEAM_ID, "T123");
  });

  test("throws if entry is null/undefined (defensive)", () => {
    assert.throws(() => resolveEntry(null, {}), /entry is required/);
  });
});

describe("searchRegistry", () => {
  test("empty query returns the whole registry", () => {
    const out = searchRegistry("");
    assert.equal(out.length, MCP_REGISTRY.length);
  });

  test("id match ranks first", () => {
    const out = searchRegistry("filesystem");
    assert.equal(out[0].id, "filesystem");
  });

  test("tag match catches related servers", () => {
    const out = searchRegistry("browser");
    // Both playwright + puppeteer have "browser" tag
    const ids = out.map((e) => e.id);
    assert.ok(ids.includes("playwright"));
    assert.ok(ids.includes("puppeteer"));
  });

  test("description match works as fallback", () => {
    const out = searchRegistry("knowledge-graph");
    // memory's description mentions knowledge graph
    assert.ok(out.some((e) => e.id === "memory"));
  });

  test("case-insensitive", () => {
    const a = searchRegistry("POSTGRES");
    const b = searchRegistry("postgres");
    assert.deepEqual(a.map((e) => e.id), b.map((e) => e.id));
  });

  test("no match returns empty array", () => {
    const out = searchRegistry("zzzzzzzzz-nope");
    assert.deepEqual(out, []);
  });
});

describe("suggestSimilar — typo recovery", () => {
  test("catches single-character typo", () => {
    const suggestions = suggestSimilar("playright"); // missing 'w'
    assert.ok(suggestions.includes("playwright"));
  });

  test("catches transposition", () => {
    const suggestions = suggestSimilar("postgers"); // transposed e/r
    assert.ok(suggestions.includes("postgres"));
  });

  test("returns empty for total nonsense", () => {
    const suggestions = suggestSimilar("zxqwopq");
    assert.deepEqual(suggestions, []);
  });

  test("caps at 3 suggestions", () => {
    const suggestions = suggestSimilar("a"); // very short → would over-match
    assert.ok(suggestions.length <= 3);
  });
});
