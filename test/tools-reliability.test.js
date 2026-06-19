// Tests for the reliability/parity additions: arg validation, glob_files,
// edit_file replace_all, gitignore-aware search.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TOOL_DEFINITIONS, validateToolArgs, executeTool, globToRegExp } from "../src/tools.js";

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aethertest-"));
const ro = (dir) => ({ cwd: dir, autoYes: true, unsafePaths: false });
const callTool = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });

test("glob_files is registered", () => {
  assert.ok(TOOL_DEFINITIONS.some((t) => t.function.name === "glob_files"));
});

test("validateToolArgs: missing required / wrong type / valid / unknown / extras", () => {
  assert.match(validateToolArgs("read_file", {}), /Missing required argument "path"/);
  assert.match(validateToolArgs("read_file", { path: 123 }), /must be of type string/);
  assert.equal(validateToolArgs("read_file", { path: "a.txt" }), null);
  assert.match(validateToolArgs("nope", {}), /Unknown tool/);
  assert.equal(validateToolArgs("read_file", { path: "a.txt", extra: 1 }), null);
});

test("globToRegExp: ** spans directories, * does not", () => {
  assert.ok(globToRegExp("**/*.ts").test("a/b/c.ts"));
  assert.ok(globToRegExp("**/*.ts").test("c.ts"));
  assert.ok(globToRegExp("*.ts").test("c.ts"));
  assert.equal(globToRegExp("*.ts").test("a/c.ts"), false);
  assert.ok(globToRegExp("src/**/*.js").test("src/a/b.js"));
  assert.ok(globToRegExp("src/**/*.js").test("src/b.js"));
  assert.equal(globToRegExp("src/**/*.js").test("lib/b.js"), false);
});

test("glob_files finds matching files, respects ignores", async () => {
  const dir = mkTmp();
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.writeFileSync(path.join(dir, "src", "a.js"), "x");
  fs.writeFileSync(path.join(dir, "c.js"), "x");
  fs.writeFileSync(path.join(dir, "b.ts"), "x");
  fs.writeFileSync(path.join(dir, "node_modules", "dep.js"), "x");
  const r = await executeTool(callTool("glob_files", { pattern: "**/*.js" }), ro(dir));
  assert.equal(r.ok, true);
  const files = JSON.parse(r.output).files.map((f) => f.split(path.sep).join("/"));
  assert.ok(files.includes("src/a.js"));
  assert.ok(files.includes("c.js"));
  assert.equal(files.includes("b.ts"), false);
  assert.equal(files.some((f) => f.includes("node_modules")), false);
});

test("edit_file replace_all replaces every occurrence", async () => {
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, "f.txt"), "a a a");
  const r = await executeTool(callTool("edit_file", { path: "f.txt", find: "a", replace: "b", replace_all: true }), ro(dir));
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "f.txt"), "utf8"), "b b b");
  assert.match(r.output, /3 replacements/);
});

test("edit_file without replace_all rejects ambiguous matches", async () => {
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, "f.txt"), "a a a");
  const r = await executeTool(callTool("edit_file", { path: "f.txt", find: "a", replace: "b" }), ro(dir));
  assert.equal(r.ok, false);
  assert.match(r.output, /appears 3 times/);
});

test("search_files honors .gitignore", async () => {
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, ".gitignore"), "skip/\n");
  fs.mkdirSync(path.join(dir, "skip"));
  fs.writeFileSync(path.join(dir, "skip", "x.txt"), "NEEDLE here");
  fs.writeFileSync(path.join(dir, "keep.txt"), "NEEDLE here");
  const r = await executeTool(callTool("search_files", { path: ".", pattern: "NEEDLE" }), ro(dir));
  assert.equal(r.ok, true);
  const files = JSON.parse(r.output).matches.map((m) => m.file.split(path.sep).join("/"));
  assert.ok(files.includes("keep.txt"));
  assert.equal(files.some((f) => f.startsWith("skip/")), false);
});

test("read_file reads a real file inside cwd", async () => {
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, "hi.txt"), "hello world");
  const r = await executeTool(callTool("read_file", { path: "hi.txt" }), ro(dir));
  assert.equal(r.ok, true);
  assert.equal(r.output, "hello world");
});
