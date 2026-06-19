// Ink-based boxed input for the REPL — the bordered live input box (Claude
// Code-style). Rendered fresh for each prompt, then unmounted so the agent's
// plain console.log streaming during a turn never fights Ink for the terminal.
//
// Uses a `single`-line border (broadly supported in cmd.exe Consolas) rather
// than rounded corners, which render as tofu on some Windows fonts.
//
// No JSX / no build step: components are built with React.createElement so the
// package ships as-is. `InputApp` is exported (pure UI + callbacks) so it can be
// unit-tested with ink-testing-library without a real TTY.

import React, { useState, useRef } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";

const h = React.createElement;

// Sentinel promptBoxed() resolves with on a double Ctrl+C, so the caller can
// distinguish "user wants to quit" from an empty submitted line. Plain ASCII so
// it can never be confused with a real keystroke or hide invisible chars.
export const EXIT_SIGNAL = "<<aether-exit>>";

/**
 * Pure input UI. Calls onSubmit(value) on Enter and onExit() on a double Ctrl+C.
 * Up/Down arrows walk `history` (newest last). No process/terminal side effects
 * of its own, so it's testable in isolation with ink-testing-library.
 */
export function InputApp({ onSubmit, onExit, statusLeft = "", statusRight = "", history = [] }) {
  const [value, setValue] = useState("");
  const lastCtrlC = useRef(0);
  const histIdx = useRef(history.length);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      const now = Date.now();
      if (now - lastCtrlC.current < 1500) onExit();
      else { lastCtrlC.current = now; setValue(""); }
      return;
    }
    if (key.upArrow) {
      if (histIdx.current > 0) { histIdx.current -= 1; setValue(history[histIdx.current] ?? ""); }
    } else if (key.downArrow) {
      if (histIdx.current < history.length - 1) { histIdx.current += 1; setValue(history[histIdx.current] ?? ""); }
      else { histIdx.current = history.length; setValue(""); }
    }
  });

  return h(
    Box,
    { flexDirection: "column", width: "100%" },
    h(
      Box,
      { borderStyle: "single", borderColor: "magenta", paddingX: 1 },
      h(Text, { color: "magenta", bold: true }, "> "),
      h(TextInput, { value, onChange: setValue, onSubmit, placeholder: "" }),
    ),
    h(
      Box,
      { paddingX: 1, width: "100%", justifyContent: "space-between" },
      h(Text, { dimColor: true }, statusLeft),
      h(Text, { dimColor: true }, statusRight),
    ),
  );
}

/**
 * Render a one-shot boxed input and resolve with the submitted line. Resolves
 * EXIT_SIGNAL on a double Ctrl+C; resolves "" if the app exits without a submit.
 */
export function promptBoxed(opts = {}) {
  return new Promise((resolve) => {
    let done = false;
    let appApi = null;
    const fin = (val) => {
      if (done) return;
      done = true;
      try { if (appApi) appApi.exit(); } catch { /* already exiting */ }
      resolve(val);
    };
    const Wrapper = () => {
      appApi = useApp();
      return h(InputApp, {
        ...opts,
        onSubmit: (v) => fin(v),
        onExit: () => fin(EXIT_SIGNAL),
      });
    };
    const instance = render(h(Wrapper), { exitOnCtrlC: false });
    instance.waitUntilExit().then(() => { if (!done) { done = true; resolve(""); } });
  });
}
