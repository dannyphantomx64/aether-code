import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { InputApp } from "../src/ink-input.js";

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test("InputApp renders a bordered box + status, captures input, submits on Enter", async () => {
  let submitted = null;
  const { stdin, lastFrame, unmount } = render(
    React.createElement(InputApp, {
      onSubmit: (v) => { submitted = v; },
      onExit: () => {},
      statusLeft: "LEFTBAR",
      statusRight: "RIGHTBAR",
    }),
  );
  await tick();
  // Box border is drawn and the status bar text is present.
  const frame = lastFrame();
  assert.match(frame, /[┌┐└┘│─]/, "expected a single-line border");
  assert.match(frame, /LEFTBAR/);
  assert.match(frame, /RIGHTBAR/);

  stdin.write("build me a cli");
  await tick();
  assert.match(lastFrame(), /build me a cli/, "typed text should appear in the box");

  stdin.write("\r"); // Enter
  await tick();
  assert.equal(submitted, "build me a cli");
  unmount();
});

test("InputApp double Ctrl+C triggers onExit; single does not", async () => {
  let exits = 0;
  const { stdin, unmount } = render(
    React.createElement(InputApp, { onSubmit: () => {}, onExit: () => { exits += 1; } }),
  );
  await tick();
  stdin.write("\x03"); // first Ctrl+C
  await tick();
  assert.equal(exits, 0, "single Ctrl+C must not exit");
  stdin.write("\x03"); // second, within 1.5s
  await tick();
  assert.equal(exits, 1, "double Ctrl+C should exit");
  unmount();
});
