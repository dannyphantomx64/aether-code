// Bordered single-line text input — raw-mode, cmd.exe-safe.
//
// Like the ask_user menu, this is NOT Ink (which ghosts in the legacy Windows
// console). It draws a 3-line box + hint, and on every keystroke moves the
// cursor back up (ESC[nA), clears (ESC[J), and reprints. The caret is a FAKE
// cursor (inverse-video cell) and the real terminal cursor is hidden, so there
// is no cursor-column math to get wrong. Long input scrolls horizontally under
// a fixed right border.
//
// Returns the typed string, or EXIT_SIGNAL on Ctrl+C / Ctrl+D.

import readline from "node:readline";
import { c } from "./render.js";

export const EXIT_SIGNAL = "<<aether-exit>>";

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const INV = (s) => `\x1b[7m${s}\x1b[27m`;

export function promptBox({ history = [], placeholder = "type a message…  /help for commands" } = {}) {
  return new Promise((resolve) => {
    // Non-interactive (piped / tests): plain readline, no box.
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(c.magenta("› "), (a) => { rl.close(); resolve(a); });
      return;
    }

    let buf = "";
    let pos = 0;                 // caret index within buf
    const hist = history.slice();
    let histIdx = hist.length;   // points one past the end (current draft)
    let draft = "";
    let drawn = 0;
    let lastSigint = 0;

    const innerW = () => Math.max(24, Math.min(process.stdout.columns || 80, 100) - 6);

    const draw = (first) => {
      const W = innerW();
      if (!first) process.stdout.write(`\x1b[${drawn}A`);
      process.stdout.write("\x1b[J");

      // Horizontal scroll: keep the caret within the visible window.
      const maxVisible = W - 1;
      const start = pos > maxVisible ? pos - maxVisible : 0;
      const view = buf.slice(start, start + W);
      const rel = pos - start;

      let content;
      if (buf.length === 0) {
        const ph = placeholder.slice(0, W - 1);
        content = INV(" ") + c.dim(ph) + " ".repeat(Math.max(0, W - 1 - ph.length));
      } else {
        let s = "";
        for (let i = 0; i < W; i++) {
          const ch = view[i] ?? " ";
          s += i === rel ? INV(ch) : ch;
        }
        content = s;
      }

      const top = c.magenta("╭" + "─".repeat(W + 4) + "╮");
      const mid = c.magenta("│") + " " + c.magenta("›") + " " + content + " " + c.magenta("│");
      const bot = c.magenta("╰" + "─".repeat(W + 4) + "╯");
      const hint = c.dim("  Enter send · ↑↓ history · /help · /exit");

      process.stdout.write(top + "\n" + mid + "\n" + bot + "\n" + hint + "\n");
      drawn = 4;
    };

    const finish = (result) => {
      process.stdin.removeListener("keypress", onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(`\x1b[${drawn}A\x1b[J` + SHOW);
      // Echo the submitted line so it persists in scrollback.
      if (result && result !== EXIT_SIGNAL && result.trim()) {
        process.stdout.write(c.magenta("› ") + result + "\n");
      }
      resolve(result);
    };

    const onKey = (str, key) => {
      if (!key) return;
      const k = key.name;

      if (k === "return" || k === "enter") return finish(buf);
      if (key.ctrl && k === "c") {
        const now = Date.now();
        if (now - lastSigint < 1500 || buf.length === 0) return finish(EXIT_SIGNAL);
        lastSigint = now;
        buf = ""; pos = 0; draw(false);
        return;
      }
      if (key.ctrl && k === "d") return finish(buf.length === 0 ? EXIT_SIGNAL : buf);

      if (k === "backspace") { if (pos > 0) { buf = buf.slice(0, pos - 1) + buf.slice(pos); pos--; } }
      else if (k === "delete") { buf = buf.slice(0, pos) + buf.slice(pos + 1); }
      else if (k === "left") { if (pos > 0) pos--; }
      else if (k === "right") { if (pos < buf.length) pos++; }
      else if (k === "home" || (key.ctrl && k === "a")) pos = 0;
      else if (k === "end" || (key.ctrl && k === "e")) pos = buf.length;
      else if (key.ctrl && k === "u") { buf = ""; pos = 0; }
      else if (k === "up") {
        if (histIdx === hist.length) draft = buf;
        if (histIdx > 0) { histIdx--; buf = hist[histIdx] ?? ""; pos = buf.length; }
      }
      else if (k === "down") {
        if (histIdx < hist.length) {
          histIdx++;
          buf = histIdx === hist.length ? draft : (hist[histIdx] ?? "");
          pos = buf.length;
        }
      }
      else if (str && !key.ctrl && !key.meta && str >= " " && str !== "\x7f") {
        buf = buf.slice(0, pos) + str + buf.slice(pos);
        pos += str.length;
      }
      else return; // ignore unhandled keys without a redraw
      draw(false);
    };

    process.stdout.write(HIDE);
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKey);
    draw(true);
  });
}
