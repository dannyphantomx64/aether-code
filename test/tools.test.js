// Zero-dep tests via Node's built-in test runner. Run with `npm test`.
//
// We cover the pure / deterministic bits of tools.js — the network-hitting
// paths (web_fetch's actual fetch, web_search's HTTP call) are integration
// concerns we exercise via live smoke after deploy. The HTML stripper, URL
// validation, and arg parsing are all pure and worth a tight test suite.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_DEFINITIONS,
  htmlToText,
  executeTool,
} from "../src/tools.js";

describe("TOOL_DEFINITIONS contract", () => {
  test("every tool has the required shape", () => {
    for (const t of TOOL_DEFINITIONS) {
      assert.equal(t.type, "function", `tool ${t.function?.name ?? "?"} type`);
      assert.equal(typeof t.function.name, "string");
      assert.ok(t.function.name.length > 0);
      assert.equal(typeof t.function.description, "string");
      assert.ok(t.function.description.length > 10, `${t.function.name} description too short`);
      assert.equal(t.function.parameters.type, "object");
    }
  });

  test("web_search and web_fetch are registered", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.function.name);
    assert.ok(names.includes("web_search"), "web_search missing");
    assert.ok(names.includes("web_fetch"), "web_fetch missing");
  });

  test("no duplicate tool names", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.function.name);
    assert.equal(new Set(names).size, names.length);
  });
});

describe("htmlToText", () => {
  test("strips simple tags", () => {
    assert.equal(htmlToText("<p>hello</p>"), "hello");
    assert.equal(htmlToText("<strong>bold</strong> text"), "bold text");
  });

  test("drops script blocks entirely (including content)", () => {
    const out = htmlToText("<p>before</p><script>alert(1);var x=2;</script><p>after</p>");
    assert.equal(out.includes("alert"), false);
    assert.equal(out.includes("var x"), false);
    assert.ok(out.includes("before"));
    assert.ok(out.includes("after"));
  });

  test("drops style blocks entirely", () => {
    const out = htmlToText("<p>x</p><style>body { color: red; }</style><p>y</p>");
    assert.equal(out.includes("color: red"), false);
  });

  test("drops noscript blocks", () => {
    const out = htmlToText("<p>x</p><noscript>fallback</noscript><p>y</p>");
    assert.equal(out.includes("fallback"), false);
  });

  test("decodes common HTML entities", () => {
    assert.equal(htmlToText("Tom &amp; Jerry"), "Tom & Jerry");
    assert.equal(htmlToText("&lt;div&gt;"), "<div>");
    assert.equal(htmlToText("&quot;hi&quot;"), '"hi"');
    assert.equal(htmlToText("&nbsp;"), "");
    assert.equal(htmlToText("&mdash;"), "—");
  });

  test("decodes numeric entities (decimal + hex)", () => {
    assert.equal(htmlToText("&#65;"), "A"); // decimal A
    assert.equal(htmlToText("&#x41;"), "A"); // hex A
    assert.equal(htmlToText("&#8211;"), "–"); // en-dash
  });

  test("preserves paragraph breaks", () => {
    const out = htmlToText("<p>line one</p><p>line two</p>");
    assert.ok(out.includes("line one"));
    assert.ok(out.includes("line two"));
    // Some kind of break between them
    assert.ok(/line one[\s]+line two/.test(out));
  });

  test("collapses runs of whitespace", () => {
    assert.equal(htmlToText("<p>a    b\t\tc</p>"), "a b c");
  });

  test("handles empty / nearly-empty input", () => {
    assert.equal(htmlToText(""), "");
    assert.equal(htmlToText("<p></p>"), "");
    assert.equal(htmlToText("<p>   </p>"), "");
  });

  test("realistic docs page snippet", () => {
    const html = `
      <html><head><title>Docs</title>
        <style>body{color:#000}</style>
        <script>console.log('analytics')</script>
      </head><body>
        <h1>useTransition</h1>
        <p>useTransition lets you update the state without blocking the UI.</p>
        <pre><code>const [isPending, startTransition] = useTransition();</code></pre>
      </body></html>
    `;
    const out = htmlToText(html);
    assert.ok(out.includes("useTransition"));
    assert.ok(out.includes("update the state"));
    assert.ok(out.includes("startTransition"));
    assert.equal(out.includes("console.log"), false);
    assert.equal(out.includes("color:#000"), false);
  });
});

describe("executeTool — input validation", () => {
  const opts = { cwd: process.cwd(), autoYes: false, unsafePaths: false };

  test("returns error on invalid JSON args", async () => {
    const r = await executeTool(
      { function: { name: "read_file", arguments: "{not json" } },
      opts,
    );
    assert.equal(r.ok, false);
    assert.match(r.output, /Invalid JSON/);
  });

  test("returns error on unknown tool name", async () => {
    const r = await executeTool(
      { function: { name: "nuclear_launch", arguments: "{}" } },
      opts,
    );
    assert.equal(r.ok, false);
    assert.match(r.output, /Unknown tool/);
  });

  test("web_fetch rejects non-http(s) URLs", async () => {
    for (const bad of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>",
      "ftp://old.example.com/file",
      "//no-scheme.com",
      "",
    ]) {
      const r = await executeTool(
        { function: { name: "web_fetch", arguments: JSON.stringify({ url: bad }) } },
        opts,
      );
      assert.equal(r.ok, false, `expected reject for ${JSON.stringify(bad)}`);
      assert.match(r.output, /required|Only http/);
    }
  });

  test("web_fetch rejects missing url arg", async () => {
    const r = await executeTool(
      { function: { name: "web_fetch", arguments: "{}" } },
      opts,
    );
    assert.equal(r.ok, false);
    assert.match(r.output, /required/);
  });

  test("web_search rejects missing query arg", async () => {
    const r = await executeTool(
      { function: { name: "web_search", arguments: "{}" } },
      opts,
    );
    assert.equal(r.ok, false);
    assert.match(r.output, /required/);
  });
});
