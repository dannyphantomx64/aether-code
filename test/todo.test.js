// Tests for the todo_write tool — TDD style, written BEFORE the
// implementation. These exercise the pure logic (validation, state
// transitions, rendering) without touching any UI.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_DEFINITIONS,
  executeTool,
  __resetTodoState, // test-only export for clean state between tests
  __getTodoState, // test-only export for inspecting state
} from "../src/tools.js";

const opts = { cwd: process.cwd(), autoYes: true, unsafePaths: false };

describe("todo_write — tool definition", () => {
  test("is registered in TOOL_DEFINITIONS", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.function.name);
    assert.ok(names.includes("todo_write"), "todo_write missing from tool definitions");
  });

  test("has a meaningful description", () => {
    const def = TOOL_DEFINITIONS.find((t) => t.function.name === "todo_write");
    assert.ok(def.function.description.length > 40);
    // Should mention what status values are valid so the model knows
    assert.match(def.function.description, /pending|in_progress|completed/);
  });
});

describe("todo_write — input validation", () => {
  test("rejects missing todos field", async () => {
    __resetTodoState();
    const r = await executeTool(
      { function: { name: "todo_write", arguments: "{}" } },
      opts,
    );
    assert.equal(r.ok, false);
    assert.match(r.output, /todos/);
  });

  test("rejects todos that is not an array", async () => {
    __resetTodoState();
    const r = await executeTool(
      {
        function: {
          name: "todo_write",
          arguments: JSON.stringify({ todos: "string instead of array" }),
        },
      },
      opts,
    );
    assert.equal(r.ok, false);
  });

  test("rejects entries with invalid status", async () => {
    __resetTodoState();
    const r = await executeTool(
      {
        function: {
          name: "todo_write",
          arguments: JSON.stringify({
            todos: [{ content: "do thing", status: "purple" }],
          }),
        },
      },
      opts,
    );
    assert.equal(r.ok, false);
    assert.match(r.output, /status/);
  });

  test("rejects entries missing content", async () => {
    __resetTodoState();
    const r = await executeTool(
      {
        function: {
          name: "todo_write",
          arguments: JSON.stringify({ todos: [{ status: "pending" }] }),
        },
      },
      opts,
    );
    assert.equal(r.ok, false);
    assert.match(r.output, /content/);
  });

  test("rejects empty content strings", async () => {
    __resetTodoState();
    const r = await executeTool(
      {
        function: {
          name: "todo_write",
          arguments: JSON.stringify({ todos: [{ content: "", status: "pending" }] }),
        },
      },
      opts,
    );
    assert.equal(r.ok, false);
  });

  test("caps the number of todos to keep model output sane", async () => {
    __resetTodoState();
    const many = Array.from({ length: 100 }, (_, i) => ({
      content: `task ${i}`,
      status: "pending",
    }));
    const r = await executeTool(
      { function: { name: "todo_write", arguments: JSON.stringify({ todos: many }) } },
      opts,
    );
    assert.equal(r.ok, false);
    assert.match(r.output, /too many|max/i);
  });
});

describe("todo_write — state management", () => {
  test("replaces the full list on each call (latest-wins semantics)", async () => {
    __resetTodoState();
    await executeTool(
      {
        function: {
          name: "todo_write",
          arguments: JSON.stringify({
            todos: [
              { content: "a", status: "pending" },
              { content: "b", status: "pending" },
            ],
          }),
        },
      },
      opts,
    );
    await executeTool(
      {
        function: {
          name: "todo_write",
          arguments: JSON.stringify({
            todos: [{ content: "c", status: "in_progress" }],
          }),
        },
      },
      opts,
    );
    const state = __getTodoState();
    assert.equal(state.length, 1);
    assert.equal(state[0].content, "c");
    assert.equal(state[0].status, "in_progress");
  });

  test("ok-result includes a render-friendly summary", async () => {
    __resetTodoState();
    const r = await executeTool(
      {
        function: {
          name: "todo_write",
          arguments: JSON.stringify({
            todos: [
              { content: "ship feature", status: "in_progress" },
              { content: "write tests", status: "pending" },
              { content: "deploy", status: "pending" },
            ],
          }),
        },
      },
      opts,
    );
    assert.equal(r.ok, true);
    // Output should mention counts so the model can self-track
    assert.match(r.output, /1.*in.progress|in.progress.*1/i);
    assert.match(r.output, /2.*pending|pending.*2/i);
  });

  test("accepts all three valid status values", async () => {
    __resetTodoState();
    const r = await executeTool(
      {
        function: {
          name: "todo_write",
          arguments: JSON.stringify({
            todos: [
              { content: "x", status: "pending" },
              { content: "y", status: "in_progress" },
              { content: "z", status: "completed" },
            ],
          }),
        },
      },
      opts,
    );
    assert.equal(r.ok, true);
    const state = __getTodoState();
    assert.equal(state.length, 3);
  });

  test("__resetTodoState clears between calls (test hygiene check)", () => {
    __resetTodoState();
    assert.equal(__getTodoState().length, 0);
  });
});
