// Tool implementations + JSON-schema definitions.
//
// Safety model:
//   - read_file, list_dir, search_files: auto-execute (read-only)
//   - write_file, edit_file: show diff, require y/n confirmation (or --yes flag)
//   - run_shell: show command, require y/n confirmation (or --yes flag)
//
// Path safety: every path is resolved against `cwd` and rejected if it
// escapes `cwd` — unless the user explicitly passes --unsafe-paths.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { c } from "./render.js";
import { unifiedDiff, summarizeWrite } from "./diff.js";
import { getConfig } from "./config.js";

/* ─────────────────────── Tool definitions (sent to model) ─────────────────────── */

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the contents of a file as UTF-8 text. Returns the file contents or an error if the file doesn't exist.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the working directory, or absolute." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description:
        "List the entries in a directory. Returns an array of {name, type: 'file'|'dir', size?: number}. Hidden files (starting with .) are excluded by default.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path." },
          include_hidden: { type: "boolean", description: "Include dotfiles. Default: false." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Recursively search for a regex pattern across files in a directory. Returns matching file paths and the matching line. Limited to 50 results.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to search." },
          pattern: { type: "string", description: "JavaScript-style regex (without slashes)." },
          glob: { type: "string", description: "Optional file-name glob filter, e.g. '*.ts'." },
        },
        required: ["path", "pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob_files",
      description:
        "Find files by path pattern (no content search). Returns matching file paths sorted by most-recently-modified. Use this to locate files by name/extension/location, e.g. '**/*.ts', 'src/**/*.test.js', 'package.json'. Faster and clearer than search_files when you only need to find files, not grep their contents.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern. Supports ** (any depth), * (within a path segment), ?. e.g. 'src/**/*.js'." },
          path: { type: "string", description: "Directory to search from. Default: the working directory." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or completely overwrite a file with the given content. The user will be shown a diff and may decline. If the parent directory doesn't exist, it will be created.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path." },
          content: { type: "string", description: "Full file content to write." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace occurrences of `find` with `replace` in an existing file. Use this for targeted edits instead of rewriting whole files. By default replaces exactly one occurrence and fails if `find` is missing or appears more than once. Set `replace_all: true` to replace every occurrence.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path." },
          find: { type: "string", description: "Exact text to replace. Must be unique unless replace_all is true." },
          replace: { type: "string", description: "Text to substitute in." },
          replace_all: { type: "boolean", description: "Replace ALL occurrences instead of requiring a unique match. Default: false." },
        },
        required: ["path", "find", "replace"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "Run a shell command and return its stdout, stderr, and exit code. The user will be shown the command and may decline. Used for builds, tests, package installs, git operations, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run." },
          cwd: { type: "string", description: "Optional working directory (relative or absolute)." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the live web for a query and return a JSON array of {title, url, snippet} results. Use this to find current docs, recent libraries, API references, or anything that may have changed since training. ALWAYS prefer this over guessing at library APIs. Cost: ~3–8 credits per call.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Plain-language search query." },
          max_results: { type: "number", description: "How many results to return (1–10, default 5)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch a URL and return its content as plain text (HTML scripts/styles stripped, tags removed, entities decoded). Use this after web_search to read the actual docs page. NEVER pass a URL you didn't get from a real source — only http:// or https:// is allowed. Caps response at 50 KB of text.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full http(s) URL to fetch." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_write",
      description:
        "Replace the current todo list with a new state. Use this at the start of any task with 3+ steps to plan upfront, then call again to mark items 'in_progress' as you start them and 'completed' as you finish. Visible progress for the user; structural discipline for you. Status must be one of: 'pending', 'in_progress', 'completed'. Max 30 items per list.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "Full replacement list (latest-wins semantics).",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "Short imperative phrase, e.g. 'wire endpoint into UI'." },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                  description: "Task status.",
                },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
];

/* ─────────────────────── Argument validation ─────────────────────── */

const TOOL_SCHEMAS = Object.fromEntries(
  TOOL_DEFINITIONS.map((t) => [t.function.name, t.function.parameters]),
);

function typeMatches(val, t) {
  switch (t) {
    case "string": return typeof val === "string";
    case "number": return typeof val === "number";
    case "integer": return typeof val === "number" && Number.isInteger(val);
    case "boolean": return typeof val === "boolean";
    case "object": return typeof val === "object" && val !== null && !Array.isArray(val);
    case "array": return Array.isArray(val);
    default: return true;
  }
}

/**
 * Validate parsed tool arguments against the tool's JSON schema BEFORE the
 * handler runs. Returns an error string the model can act on, or null if valid.
 * Catches malformed/partial args from the model that would otherwise surface as
 * cryptic downstream errors.
 */
export function validateToolArgs(name, args) {
  const schema = TOOL_SCHEMAS[name];
  if (!schema) return `Unknown tool: ${name}`;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return `Arguments for ${name} must be a JSON object.`;
  }
  for (const req of schema.required ?? []) {
    if (args[req] === undefined || args[req] === null) {
      return `Missing required argument "${req}" for ${name}.`;
    }
  }
  for (const [key, val] of Object.entries(args)) {
    const prop = schema.properties?.[key];
    if (!prop || val === undefined || val === null) continue;
    if (prop.type && !typeMatches(val, prop.type)) {
      return `Argument "${key}" for ${name} must be of type ${prop.type}.`;
    }
  }
  return null;
}

/* ─────────────────────── Glob + ignore helpers ─────────────────────── */

const ALWAYS_SKIP = new Set([".git", "node_modules", "dist"]);
const MAX_SEARCH_MATCHES = 200;
const MAX_GLOB_RESULTS = 300;

// Convert a glob ('**', '*', '?') to an anchored regex over a POSIX-style
// relative path. ** spans directory separators; * does not.
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // collapse '**/' so it can also match zero dirs
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if ("\\^$+.()|{}[]".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp("^" + re + "$");
}

// Parse a .gitignore at `root` into a matcher. Pragmatic subset of gitignore
// semantics: blank/comment lines ignored; trailing '/' = directory-only;
// leading '/' = root-anchored; '*'/'?' globs supported.
function loadIgnore(root) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(root, ".gitignore"), "utf8").split("\n"); } catch { /* none */ }
  const rules = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let pat = line;
    const dirOnly = pat.endsWith("/");
    if (dirOnly) pat = pat.slice(0, -1);
    const anchored = pat.startsWith("/");
    if (anchored) pat = pat.slice(1);
    rules.push({ re: globToRegExp(pat), anchored, dirOnly, base: !pat.includes("/") });
  }
  return (relPath, isDir) => {
    const norm = relPath.split(path.sep).join("/");
    const baseName = norm.split("/").pop();
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.base) { if (r.re.test(baseName)) return true; }
      else if (r.anchored) { if (r.re.test(norm)) return true; }
      else if (r.re.test(norm) || r.re.test(baseName)) return true;
    }
    return false;
  };
}

/* ─────────────────────── Helpers ─────────────────────── */

function resolveSafe(rel, opts) {
  const abs = path.isAbsolute(rel) ? path.normalize(rel) : path.resolve(opts.cwd, rel);
  if (!opts.unsafePaths) {
    const cwd = path.resolve(opts.cwd);
    if (!abs.startsWith(cwd + path.sep) && abs !== cwd) {
      throw new Error(
        `Refusing to touch path outside cwd: ${abs}\n  Run with --unsafe-paths if you really mean this.`,
      );
    }
  }
  return abs;
}

function ask(question) {
  if (!process.stdin.isTTY) {
    return Promise.resolve("n"); // can't prompt in non-TTY; default no
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function confirm(question, autoYes) {
  if (autoYes) return true;
  const ans = await ask(`${question} ${c.dim("[y/N]: ")}`);
  return ans === "y" || ans === "yes";
}

/* ─────────────────────── Implementations ─────────────────────── */

export async function executeTool(call, opts) {
  let args;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch (e) {
    return { ok: false, output: `Invalid JSON arguments: ${e.message}` };
  }

  const name = call.function.name;
  const validationError = validateToolArgs(name, args);
  if (validationError) {
    return { ok: false, output: validationError };
  }
  const handlers = {
    read_file: () => readFile(args, opts),
    list_dir: () => listDir(args, opts),
    search_files: () => searchFiles(args, opts),
    glob_files: () => globFiles(args, opts),
    write_file: () => writeFile(args, opts),
    edit_file: () => editFile(args, opts),
    run_shell: () => runShell(args, opts),
    web_search: () => webSearch(args, opts),
    web_fetch: () => webFetch(args, opts),
    todo_write: () => todoWrite(args, opts),
  };
  const fn = handlers[name];
  if (!fn) {
    return { ok: false, output: `Unknown tool: ${name}` };
  }
  try {
    return await fn();
  } catch (e) {
    return { ok: false, output: `${name} failed: ${e.message}` };
  }
}

function readFile(args, opts) {
  if (typeof args.path !== "string") return { ok: false, output: "path is required" };
  const abs = resolveSafe(args.path, opts);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) return { ok: false, output: `${args.path} is a directory, not a file` };
  if (stat.size > 1_000_000) {
    return { ok: false, output: `File too large (${stat.size} bytes). Aether refuses to read >1MB at once.` };
  }
  const text = fs.readFileSync(abs, "utf8");
  return { ok: true, output: text };
}

function listDir(args, opts) {
  if (typeof args.path !== "string") return { ok: false, output: "path is required" };
  const abs = resolveSafe(args.path, opts);
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const results = [];
  for (const e of entries) {
    if (!args.include_hidden && e.name.startsWith(".")) continue;
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
    let size = undefined;
    if (e.isFile()) {
      try { size = fs.statSync(path.join(abs, e.name)).size; } catch { /* skip */ }
    }
    results.push({
      name: e.name,
      type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other",
      size,
    });
  }
  results.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { ok: true, output: JSON.stringify(results, null, 2) };
}

function searchFiles(args, opts) {
  if (typeof args.path !== "string" || typeof args.pattern !== "string") {
    return { ok: false, output: "path and pattern are required" };
  }
  let regex;
  try { regex = new RegExp(args.pattern); } catch (e) {
    return { ok: false, output: `Invalid regex: ${e.message}` };
  }
  const root = resolveSafe(args.path, opts);
  const isIgnored = loadIgnore(path.resolve(opts.cwd));
  const matches = [];
  const globRe = args.glob ? globToRegExp(args.glob) : null;
  let truncated = false;

  function walk(dir) {
    if (matches.length >= MAX_SEARCH_MATCHES) { truncated = true; return; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (matches.length >= MAX_SEARCH_MATCHES) { truncated = true; return; }
      if (e.name.startsWith(".") || ALWAYS_SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(opts.cwd, full);
      if (isIgnored(rel, e.isDirectory())) continue;
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        if (globRe && !globRe.test(e.name)) continue;
        let content;
        try {
          const stat = fs.statSync(full);
          if (stat.size > 500_000) continue;
          content = fs.readFileSync(full, "utf8");
        } catch { continue; }
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matches.push({ file: rel, line: i + 1, text: lines[i].slice(0, 300) });
            if (matches.length >= MAX_SEARCH_MATCHES) { truncated = true; return; }
          }
        }
      }
    }
  }
  walk(root);
  const payload = { matches };
  if (truncated) {
    payload.truncated = true;
    payload.note = `Showing the first ${MAX_SEARCH_MATCHES} matches — refine the pattern or pass a 'glob' filter to narrow.`;
  }
  return { ok: true, output: JSON.stringify(payload, null, 2) };
}

function globFiles(args, opts) {
  if (typeof args.pattern !== "string") return { ok: false, output: "pattern is required" };
  const root = resolveSafe(typeof args.path === "string" ? args.path : ".", opts);
  const re = globToRegExp(args.pattern);
  const isIgnored = loadIgnore(path.resolve(opts.cwd));
  const found = [];
  let truncated = false;

  function walk(dir) {
    if (found.length >= MAX_GLOB_RESULTS) { truncated = true; return; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found.length >= MAX_GLOB_RESULTS) { truncated = true; return; }
      if (e.name.startsWith(".") || ALWAYS_SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(opts.cwd, full);
      if (isIgnored(rel, e.isDirectory())) continue;
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        const relToRoot = path.relative(root, full).split(path.sep).join("/");
        if (re.test(relToRoot)) {
          let mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
          found.push({ path: rel, mtime });
        }
      }
    }
  }
  walk(root);
  found.sort((a, b) => b.mtime - a.mtime); // most-recently-modified first
  const payload = { files: found.map((f) => f.path) };
  if (truncated) {
    payload.truncated = true;
    payload.note = `Showing the first ${MAX_GLOB_RESULTS} files — narrow the pattern.`;
  }
  return { ok: true, output: JSON.stringify(payload, null, 2) };
}

async function writeFile(args, opts) {
  if (typeof args.path !== "string" || typeof args.content !== "string") {
    return { ok: false, output: "path and content are required" };
  }
  const abs = resolveSafe(args.path, opts);
  const exists = fs.existsSync(abs);
  const oldContent = exists ? fs.readFileSync(abs, "utf8") : null;
  if (exists && oldContent === args.content) {
    return { ok: true, output: `(no change — file already matches)` };
  }
  // Show diff + confirm
  console.log("");
  console.log(summarizeWrite(oldContent, args.content, path.relative(opts.cwd, abs)));
  console.log(unifiedDiff(oldContent ?? "", args.content, path.relative(opts.cwd, abs)));
  const approved = await confirm(c.yellow("Apply this write?"), opts.autoYes);
  if (!approved) {
    return { ok: false, output: "User declined the write." };
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, args.content, "utf8");
  return { ok: true, output: `Wrote ${args.content.length} bytes to ${path.relative(opts.cwd, abs)}` };
}

async function editFile(args, opts) {
  if (typeof args.path !== "string" || typeof args.find !== "string" || typeof args.replace !== "string") {
    return { ok: false, output: "path, find, replace are required" };
  }
  const abs = resolveSafe(args.path, opts);
  if (!fs.existsSync(abs)) return { ok: false, output: `File not found: ${args.path}` };
  const oldContent = fs.readFileSync(abs, "utf8");
  const occurrences = oldContent.split(args.find).length - 1;
  if (occurrences === 0) {
    return { ok: false, output: `\`find\` text not found in ${args.path}. Tip: read the file first to copy exact characters.` };
  }
  if (!args.replace_all && occurrences > 1) {
    return {
      ok: false,
      output: `\`find\` text appears ${occurrences} times — must be unique. Add more context to disambiguate, or set replace_all: true to replace all ${occurrences}.`,
    };
  }
  // split/join replaces every occurrence without regex-escaping pitfalls; for
  // the default single-edit path occurrences === 1 so it's equivalent.
  const newContent = args.replace_all
    ? oldContent.split(args.find).join(args.replace)
    : oldContent.replace(args.find, args.replace);
  const rel = path.relative(opts.cwd, abs);
  console.log("");
  console.log(c.dim(`edit ${rel}${args.replace_all ? ` (${occurrences} occurrences)` : ""}`));
  console.log(unifiedDiff(oldContent, newContent, rel));
  const approved = await confirm(c.yellow("Apply this edit?"), opts.autoYes);
  if (!approved) return { ok: false, output: "User declined the edit." };
  fs.writeFileSync(abs, newContent, "utf8");
  return { ok: true, output: `Edited ${rel}${args.replace_all && occurrences > 1 ? ` (${occurrences} replacements)` : ""}` };
}

/* ─────────────────────── Web tools ─────────────────────── */

async function webSearch(args, opts) {
  void opts;
  if (typeof args.query !== "string") return { ok: false, output: "query is required" };
  const { apiKey, baseUrl } = getConfig();
  if (!apiKey) {
    return { ok: false, output: "Web search requires AETHER_API_KEY. Set it and try again." };
  }
  const max = Number.isInteger(args.max_results) ? Math.min(10, Math.max(1, args.max_results)) : 5;
  let res;
  try {
    res = await fetch(`${baseUrl}/api/v1/web-search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "aether-code/web-search",
      },
      body: JSON.stringify({ query: args.query, max_results: max }),
    });
  } catch (e) {
    return { ok: false, output: `web_search network error: ${e.message}` };
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    return { ok: false, output: data?.error || `web_search HTTP ${res.status}` };
  }
  // Hand the model just the array — that's all it needs to decide which URL to fetch.
  return { ok: true, output: JSON.stringify(data.results ?? [], null, 2) };
}

// Bounded fetch with a fixed timeout + size cap. Strips scripts/styles, removes
// tags, decodes common HTML entities. Not a full HTML parser; good enough for
// reading docs pages, GitHub READMEs, MDN, Stack Overflow answers, etc.
async function webFetch(args, opts) {
  void opts;
  if (typeof args.url !== "string") return { ok: false, output: "url is required" };
  if (!/^https?:\/\//i.test(args.url)) {
    return { ok: false, output: "Only http:// and https:// URLs are allowed." };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let res;
  try {
    res = await fetch(args.url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        // Looking like a normal browser dodges many anti-bot pages.
        "User-Agent":
          "Mozilla/5.0 (compatible; aether-code/0.7) Gecko/20100101 Firefox/130.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (e) {
    clearTimeout(timeout);
    return { ok: false, output: `web_fetch error: ${e.name === "AbortError" ? "timed out after 15s" : e.message}` };
  }
  clearTimeout(timeout);
  if (!res.ok) {
    return { ok: false, output: `web_fetch HTTP ${res.status} ${res.statusText}` };
  }
  // Cap at 2 MB of raw HTML before stripping — page might be huge.
  const reader = res.body?.getReader();
  if (!reader) return { ok: false, output: "Response had no body." };
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > 2_000_000) {
      reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const html = new TextDecoder("utf-8", { fatal: false }).decode(
    Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))),
  );
  const text = htmlToText(html);
  // Final cap on what we hand to the model so a single fetch doesn't blow the context.
  const capped = text.length > 50_000 ? text.slice(0, 50_000) + "\n…(truncated; page was longer)" : text;
  return { ok: true, output: capped };
}

export function htmlToText(html) {
  let s = html;
  // Drop script/style blocks entirely.
  s = s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ");
  s = s.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");
  s = s.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, " ");
  // Preserve paragraph + heading breaks.
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|br)\s*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // Strip remaining tags.
  s = s.replace(/<[^>]+>/g, "");
  // Decode common HTML entities (covers ~95% of real-world cases).
  const entities = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
    "&apos;": "'", "&nbsp;": " ", "&mdash;": "—", "&ndash;": "–",
    "&hellip;": "…", "&copy;": "©", "&reg;": "®", "&trade;": "™",
  };
  for (const [ent, ch] of Object.entries(entities)) {
    s = s.split(ent).join(ch);
  }
  s = s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  // Collapse whitespace.
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n\s*\n\s*\n+/g, "\n\n");
  return s.trim();
}

async function runShell(args, opts) {
  if (typeof args.command !== "string") return { ok: false, output: "command is required" };
  const cwd = args.cwd ? resolveSafe(args.cwd, opts) : opts.cwd;
  console.log("");
  console.log(c.yellow("$ ") + c.bold(args.command) + (args.cwd ? c.dim(`  (cwd: ${args.cwd})`) : ""));
  const approved = await confirm(c.yellow("Run this command?"), opts.autoYes);
  if (!approved) return { ok: false, output: "User declined the command." };

  return new Promise((resolve) => {
    const child = spawn(args.command, [], { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timeout = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, 120_000); // 2-minute hard cap per command

    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      if (stdout.length < 80_000) process.stdout.write(c.dim(s));
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      if (stderr.length < 80_000) process.stderr.write(c.dim(s));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      // Truncate huge outputs before sending back to the model
      const truncate = (t) => (t.length > 20_000 ? t.slice(0, 20_000) + "\n…(truncated)" : t);
      const out = JSON.stringify(
        {
          exit_code: code,
          killed,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
        },
        null,
        2,
      );
      resolve({ ok: code === 0 && !killed, output: out });
    });
  });
}

/* ─────────────────────── todo_write ─────────────────────── */

// Module-level singleton holding the current todo list for this CLI session.
// Latest-wins: each todo_write call replaces the entire list. The model
// passes the full new state every time, mirroring what Claude Code's
// TodoWrite does. Simpler than incremental ops; gives the model full
// control over ordering and renames.
const VALID_TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);
const MAX_TODOS = 30;
let todoState = [];

// Test-only escape hatches — exported so the test suite can reset state
// between cases. Production code never touches these.
export function __resetTodoState() {
  todoState = [];
}
export function __getTodoState() {
  return todoState.map((t) => ({ ...t }));
}

function todoWrite(args, opts) {
  void opts;
  if (!Array.isArray(args.todos)) {
    return { ok: false, output: "todos must be an array" };
  }
  if (args.todos.length > MAX_TODOS) {
    return {
      ok: false,
      output: `too many todos (${args.todos.length}) — max ${MAX_TODOS}. Keep the plan focused.`,
    };
  }
  // Validate every item BEFORE mutating state — we don't want a partial write.
  for (let i = 0; i < args.todos.length; i++) {
    const t = args.todos[i];
    if (!t || typeof t !== "object") {
      return { ok: false, output: `todo[${i}] must be an object` };
    }
    if (typeof t.content !== "string" || t.content.trim().length === 0) {
      return { ok: false, output: `todo[${i}] needs a non-empty content string` };
    }
    if (!VALID_TODO_STATUSES.has(t.status)) {
      return {
        ok: false,
        output: `todo[${i}] invalid status: "${t.status}" — must be pending, in_progress, or completed`,
      };
    }
  }
  todoState = args.todos.map((t) => ({
    content: t.content.trim(),
    status: t.status,
  }));
  renderTodos(todoState);
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  for (const t of todoState) counts[t.status]++;
  return {
    ok: true,
    output: `Todos updated: ${counts.pending} pending, ${counts.in_progress} in_progress, ${counts.completed} completed.`,
  };
}

function renderTodos(todos) {
  if (!process.stdout.isTTY) return; // skip render in non-TTY (CI, piped, tests)
  console.log("");
  console.log(c.dim("─── Plan ───"));
  for (const t of todos) {
    const icon =
      t.status === "completed"
        ? c.green("●")
        : t.status === "in_progress"
          ? c.yellow("→")
          : c.dim("·");
    const text =
      t.status === "completed"
        ? c.dim(t.content)
        : t.status === "in_progress"
          ? c.bold(t.content)
          : t.content;
    console.log(`  ${icon} ${text}`);
  }
  console.log("");
}
