// Interactive multiple-choice menu — arrow/number selectable, cmd.exe-safe.
//
// Deliberately NOT Ink (which ghosts in the legacy Windows console). Uses a
// simple manual redraw: print the list, and on each keypress move the cursor
// back up to the top of the menu (ESC[nA) and clear-to-end (ESC[J), then
// reprint. That's the same VT layer that already renders our ANSI colours, so
// it works in cmd.exe, Windows Terminal, and POSIX terminals alike.
//
// Returns the chosen option object ({label, description}), or null if cancelled.

import readline from "node:readline";
import { c } from "./render.js";

const ellip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");

export function promptChoice({ question, options }) {
  const opts = (options || [])
    .map((o) => (typeof o === "string" ? { label: o } : o))
    .filter((o) => o && o.label);

  return new Promise((resolve) => {
    // Non-interactive (piped / CI): pick the first option so automation never
    // hangs waiting on a keypress that can't come. Print a note so it's visible.
    if (!process.stdin.isTTY || opts.length === 0) {
      const pick = opts[0] ?? null;
      if (pick) process.stdout.write(c.cyan("● ") + c.bold(question) + c.gray(`  → ${pick.label} (auto)\n`));
      resolve(pick);
      return;
    }

    let sel = 0;
    const total = opts.length + 3; // question line + options + blank + hint line

    const draw = (first) => {
      if (!first) process.stdout.write(`\x1b[${total}A`); // cursor up to menu top
      process.stdout.write("\x1b[J"); // clear from cursor to end of screen
      process.stdout.write(c.cyan("● ") + c.bold(question) + "\n");
      opts.forEach((o, i) => {
        const active = i === sel;
        const pointer = active ? c.cyan("→") : " ";
        const num = active ? c.cyan(c.bold(`${i + 1}.`)) : c.gray(`${i + 1}.`);
        const label = active ? c.bold(o.label) : o.label;
        const desc = o.description ? c.gray("  " + ellip(o.description, 60)) : "";
        process.stdout.write(`  ${pointer} ${num} ${label}${desc}\n`);
      });
      process.stdout.write("\n" + c.gray("  ↑/↓ move · 1-9 pick · Enter select · Esc cancel") + "\n");
    };

    const cleanup = () => {
      process.stdin.removeListener("keypress", onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    const finish = (result) => {
      cleanup();
      // Collapse the menu to a compact answer line so the transcript stays clean.
      process.stdout.write(`\x1b[${total}A\x1b[J`);
      process.stdout.write(c.cyan("● ") + c.bold(question) + "\n");
      if (result) process.stdout.write("  " + c.cyan("→") + " " + c.green(result.label) + "\n\n");
      else process.stdout.write("  " + c.gray("(cancelled — proceeding with best judgment)") + "\n\n");
      resolve(result);
    };

    const onKey = (str, key) => {
      if (!key) return;
      if (key.name === "up" || key.name === "k") { sel = (sel - 1 + opts.length) % opts.length; draw(false); }
      else if (key.name === "down" || key.name === "j" || key.name === "tab") { sel = (sel + 1) % opts.length; draw(false); }
      else if (str && /^[1-9]$/.test(str)) {
        const i = parseInt(str, 10) - 1;
        if (i < opts.length) finish(opts[i]);
      }
      else if (key.name === "return") finish(opts[sel]);
      else if (key.name === "escape" || (key.ctrl && key.name === "c")) finish(null);
    };

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKey);
    draw(true);
  });
}
