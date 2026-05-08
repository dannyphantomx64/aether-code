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
        "Replace exactly one occurrence of `find` with `replace` in an existing file. Use this for targeted edits instead of rewriting whole files. Fails if `find` is not found or appears more than once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path." },
          find: { type: "string", description: "Exact text to replace (must appear exactly once)." },
          replace: { type: "string", description: "Text to substitute in." },
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
];

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
  const handlers = {
    read_file: () => readFile(args, opts),
    list_dir: () => listDir(args, opts),
    search_files: () => searchFiles(args, opts),
    write_file: () => writeFile(args, opts),
    edit_file: () => editFile(args, opts),
    run_shell: () => runShell(args, opts),
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
  const matches = [];
  const globRe = args.glob ? new RegExp("^" + args.glob.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$") : null;

  function walk(dir) {
    if (matches.length >= 50) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (matches.length >= 50) return;
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist") continue;
      const full = path.join(dir, e.name);
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
            matches.push({ file: path.relative(opts.cwd, full), line: i + 1, text: lines[i].slice(0, 300) });
            if (matches.length >= 50) return;
          }
        }
      }
    }
  }
  walk(root);
  return { ok: true, output: JSON.stringify(matches, null, 2) };
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
  if (occurrences > 1) {
    return {
      ok: false,
      output: `\`find\` text appears ${occurrences} times — must be unique. Add more context to disambiguate.`,
    };
  }
  const newContent = oldContent.replace(args.find, args.replace);
  console.log("");
  console.log(c.dim(`edit ${path.relative(opts.cwd, abs)}`));
  console.log(unifiedDiff(oldContent, newContent, path.relative(opts.cwd, abs)));
  const approved = await confirm(c.yellow("Apply this edit?"), opts.autoYes);
  if (!approved) return { ok: false, output: "User declined the edit." };
  fs.writeFileSync(abs, newContent, "utf8");
  return { ok: true, output: `Edited ${path.relative(opts.cwd, abs)}` };
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
