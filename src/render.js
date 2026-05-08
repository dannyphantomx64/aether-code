// ANSI helpers — no chalk dependency.

const isTty = process.stdout.isTTY;
const noColor = !!process.env.NO_COLOR || !isTty;

function wrap(open, close) {
  return (s) => (noColor ? String(s) : `\x1b[${open}m${s}\x1b[${close}m`);
}

export const c = {
  bold:    wrap(1, 22),
  dim:     wrap(2, 22),
  red:     wrap(31, 39),
  green:   wrap(32, 39),
  yellow:  wrap(33, 39),
  blue:    wrap(34, 39),
  magenta: wrap(35, 39),
  cyan:    wrap(36, 39),
  gray:    wrap(90, 39),
};

export function divider() {
  const w = process.stdout.columns || 60;
  return c.gray("─".repeat(Math.min(60, w)));
}

export function turn(n) {
  return c.gray(`turn ${n}`);
}

export function toolHeader(name, args) {
  // Format args compactly. If any value is huge, truncate it.
  const compact = JSON.stringify(args);
  const trimmed = compact.length > 120 ? compact.slice(0, 117) + "..." : compact;
  return `${c.cyan(c.bold(name))}${c.gray("(")}${c.gray(trimmed)}${c.gray(")")}`;
}

export function toolResult(text, ok = true) {
  const prefix = ok ? c.green("  ✓ ") : c.red("  ✗ ");
  // First line bold-ish, then dim continuation
  const lines = text.split("\n");
  const head = lines[0].slice(0, 200);
  const rest = lines.slice(1, 6).join("\n").slice(0, 600);
  return `${prefix}${head}${rest ? "\n" + c.dim(rest) : ""}`;
}

export function assistant(text) {
  // Indent each line for visual separation from tool calls
  return text.split("\n").map((l) => `  ${l}`).join("\n");
}

export function errorLine(msg) {
  return `${c.red(c.bold("Error:"))} ${msg}`;
}

export function note(msg) {
  return c.dim(msg);
}
