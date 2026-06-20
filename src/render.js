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

const ellip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");

// Clean one-line label for a tool call — a verb + its key argument, instead of
// dumping raw JSON (which buried file contents / queries in noise).
export function toolLabel(name, args) {
  const a = args || {};
  const verb = (v) => c.cyan(c.bold(v));
  const arg = (s) => c.gray(ellip(String(s), 72));
  switch (name) {
    case "read_file":    return `${verb("read")}   ${arg(a.path)}`;
    case "write_file":   return `${verb("write")}  ${arg(a.path)}`;
    case "edit_file":    return `${verb("edit")}   ${arg(a.path)}`;
    case "list_dir":     return `${verb("list")}   ${arg(a.path)}`;
    case "glob_files":   return `${verb("glob")}   ${arg(a.pattern)}`;
    case "search_files": return `${verb("search")} ${arg(`/${a.pattern}/ in ${a.path ?? "."}`)}`;
    case "run_shell":    return `${verb("run")}    ${arg(a.command)}`;
    case "web_search":   return `${verb("search web")} ${arg(JSON.stringify(a.query ?? ""))}`;
    case "web_fetch":    return `${verb("fetch")}  ${arg(a.url)}`;
    case "todo_write":   return ""; // its Plan box is the label
    default:             return `${verb(name)} ${arg(JSON.stringify(a))}`;
  }
}

// Set the terminal window/tab title (so cmd.exe shows "Aether", not the node
// path). OSC 0 — supported by cmd.exe, Windows Terminal, and POSIX terminals.
export function setTerminalTitle(title) {
  if (process.stdout.isTTY) process.stdout.write(`\x1b]0;${title}\x07`);
}

// Terse one-line result summary instead of dumping raw JSON / file contents.
// Tools whose handlers already render rich output (diffs, the shell stream, the
// plan) just get a check — the detail was already printed.
export function toolSummary(name, result) {
  const ok = result.ok;
  const mark = ok ? c.green("✓") : c.red("✗");
  const out = result.output ?? "";
  const firstLine = out.split("\n").find((l) => l.trim()) ?? "";

  if (name === "run_shell") {
    let code = null;
    try { code = JSON.parse(out).exit_code; } catch { /* ignore */ }
    return `  ${mark} ${c.gray(code === null ? (ok ? "done" : "failed") : `exit ${code}`)}`;
  }
  if (name === "todo_write") return ""; // the Plan box is its own feedback
  if (name === "write_file" || name === "edit_file") {
    // Handler already printed the diff; echo its short status line.
    return `  ${mark} ${c.gray(ellip(firstLine, 100))}`;
  }
  let summary = "";
  try {
    const j = JSON.parse(out);
    if (Array.isArray(j)) summary = `${j.length} result${j.length === 1 ? "" : "s"}`;
    else if (Array.isArray(j.files)) summary = `${j.files.length} file${j.files.length === 1 ? "" : "s"}`;
    else if (Array.isArray(j.matches)) summary = `${j.matches.length} match${j.matches.length === 1 ? "" : "es"}`;
  } catch { /* not JSON */ }
  if (!summary) {
    summary = name === "read_file" ? `${out.split("\n").length} lines` : ellip(firstLine, 100);
  }
  return `  ${mark} ${c.gray(summary)}`;
}

// Strip model "harmony"/channel control tokens (<|channel|>, <|message|>,
// <|tool_response|>, <channel|>, …) that occasionally leak into the text
// stream. Belt-and-suspenders alongside the server-side scrub.
// Only strips tokens containing a PIPE — the harmony/channel control tokens
// (<|channel|>, <|tool_response|>, <channel|>) always have one. Real code like
// <div>, Vec<T>, a < b has no pipe and is left untouched.
const MODEL_TOKEN_RE = /<\|[a-z_]*\|?>|<[a-z_]+\|>/gi;

export function stripModelTokens(text) {
  return text.replace(MODEL_TOKEN_RE, "");
}

// Streaming-safe stripper: the leaked tokens (<|channel|>, <|tool_response|>, …)
// can be split across stream chunks ("<chann" then "el|>"), which a per-delta
// regex misses. This buffers any trailing "<…" that might be the start of a
// token and only emits it once it's confirmed not-a-token (or on flush).
export function makeTokenStripper() {
  let buf = "";
  return {
    push(text) {
      buf = (buf + text).replace(MODEL_TOKEN_RE, "");
      const partial = buf.match(/<[|a-z_/]*$/i); // possible token start at the tail
      if (partial) {
        const emit = buf.slice(0, partial.index);
        buf = buf.slice(partial.index);
        return emit;
      }
      const emit = buf;
      buf = "";
      return emit;
    },
    flush() {
      const out = buf.replace(MODEL_TOKEN_RE, "");
      buf = "";
      return out;
    },
  };
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
