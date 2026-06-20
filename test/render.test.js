import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTokenStripper, stripModelTokens, toolLabel, toolSummary } from "../src/render.js";

test("stripModelTokens removes pipe control tokens, keeps real code", () => {
  assert.equal(stripModelTokens("a<|channel|>b<|tool_response|>c"), "abc");
  // No pipe → real code, untouched.
  assert.equal(stripModelTokens("use <div> and Vec<T> when a < b"), "use <div> and Vec<T> when a < b");
});

test("makeTokenStripper strips a token split across chunks", () => {
  const s = makeTokenStripper();
  let out = s.push("hello <chann");
  out += s.push("el|> world");
  out += s.flush();
  assert.equal(out, "hello  world");
});

test("makeTokenStripper leaves a real <tag> split across chunks intact", () => {
  const s = makeTokenStripper();
  let out = s.push("a <di");
  out += s.push("v> b");
  out += s.flush();
  assert.equal(out, "a <div> b");
});

test("makeTokenStripper passes plain text through", () => {
  const s = makeTokenStripper();
  assert.equal(s.push("plain text") + s.flush(), "plain text");
});

test("toolLabel is a clean verb + arg, not JSON", () => {
  assert.match(toolLabel("write_file", { path: "a.js", content: "x" }), /write/);
  assert.match(toolLabel("write_file", { path: "a.js" }), /a\.js/);
  assert.doesNotMatch(toolLabel("write_file", { path: "a.js", content: "secret" }), /secret/);
});

test("toolSummary summarizes results instead of dumping them", () => {
  assert.match(toolSummary("web_search", { ok: true, output: JSON.stringify([1, 2, 3]) }), /3 results/);
  assert.match(toolSummary("glob_files", { ok: true, output: JSON.stringify({ files: ["a"] }) }), /1 file/);
  assert.match(toolSummary("run_shell", { ok: true, output: JSON.stringify({ exit_code: 0 }) }), /exit 0/);
});
