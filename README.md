# aether-code

> Uncensored AI coding agent for your terminal. Aether reads your codebase, writes code, runs commands — like Claude Code, but with no refusal layer.

```bash
npx aether-code "build me a TypeScript todo CLI in this folder"
npx aether-code --yes "add JSDoc to every exported function in src/"
npx aether-code --cwd ./my-project "fix the failing tests"
```

Built on the same [Aether API](https://trynoguard.com) that powers [`aether-cli`](https://www.npmjs.com/package/aether-cli), [`aether-mcp`](https://www.npmjs.com/package/aether-mcp), and the browser DevTools extension. One API key, four surfaces.

## What it does

`aether-code` is a CLI that runs an AI coding agent locally. It uses tool calling under the hood — the model can read files, list directories, search across your codebase, write or edit files, and run shell commands. After each tool call, it sees the result and decides what to do next, looping until the task is complete or you hit the turn limit.

It's the same architecture as Claude Code or Cursor's agent mode, with two differences:
- **Uncensored** — no refusal layer when you ask it to write security tools, RE scripts, "edgy" content, etc.
- **Uses your existing Aether credits** — same balance pool as the chat / MCP / DevTools extension.

## Install

```bash
# One-off (recommended)
npx aether-code "your task"

# Or install globally
npm install -g aether-code
aether-code "your task"
```

Requires Node 18+. Zero runtime dependencies.

## Setup

If you've already used `aether-cli`, you're done — same `~/.aetherrc` config.

Otherwise:

```bash
# Generate a key at https://trynoguard.com/account, then:
export AETHER_API_KEY=ak_live_your_key_here
# OR — save to ~/.aetherrc (mode 0600):
npx aether-cli config set ak_live_your_key_here
```

## Tools the agent has access to

| Tool | What it does | Approval |
|---|---|---|
| `read_file` | Read any file as UTF-8 text | auto |
| `list_dir` | List entries in a directory | auto |
| `search_files` | Recursive regex search across the codebase | auto |
| `write_file` | Create or overwrite a file (shows diff) | y/N prompt |
| `edit_file` | Replace one occurrence of `find` with `replace` (shows diff) | y/N prompt |
| `run_shell` | Run a shell command, capture stdout/stderr (2-min timeout) | y/N prompt |

## Safety

By default the agent **will not act without your approval**. Each file write and each shell command shows you exactly what's about to happen and waits for `y/N`.

- **`--yes`** — auto-approve all writes and commands. Use only for trusted, scoped tasks.
- **`--cwd <path>`** — clamp all file operations to a specific directory.
- **`--unsafe-paths`** — opt out of the cwd-clamping. Required only if the agent legitimately needs to touch files outside the working dir (e.g. global config).
- **2-minute hard timeout** on each shell command (kills the process if it hangs).
- **20 KB output truncation** — long stdout/stderr is truncated before being sent back to the model so a runaway test suite can't blow up your context.

## Examples

### Build a small project from scratch

```bash
mkdir todo-cli && cd todo-cli
npx aether-code "build a TypeScript CLI that manages a todo list stored in todos.json. Use commander for arg parsing. Include npm scripts for build and test."
```

The agent will: list the empty dir → `npm init -y` → install deps → write `tsconfig.json`, `src/index.ts`, `package.json` updates → run `npm run build` to verify.

### Fix failing tests

```bash
cd existing-project
npx aether-code "run the tests, see what's failing, and fix them"
```

The agent will: `run_shell("npm test")` → read the failing files → make targeted edits → re-run tests → repeat until green.

### Refactor

```bash
npx aether-code --max-turns 40 "convert all CommonJS requires to ES module imports across src/, then update package.json"
```

### Add documentation across a codebase

```bash
npx aether-code --yes "add a one-line JSDoc to every exported function in src/ that doesn't have one"
```

`--yes` is reasonable here because the operation is bounded and read-mostly with small additive edits.

### Reverse engineering

```bash
npx aether-code "deobfuscate ./bundle.min.js, write the cleaned version to ./bundle.clean.js, then identify what the obfuscation was protecting"
```

## What it doesn't do (yet)

- **No streaming** — each turn waits for a full model response. Future work.
- **No interactive Ctrl+C handling** — kill with the OS-level signal.
- **No multi-step plan preview** — the agent just acts. (Manual `--max-turns 1` to inspect first move.)
- **No persistent session** — each invocation starts fresh. Workspaces feature on the roadmap.

## How it differs from Claude Code

| | Claude Code | aether-code |
|---|---|---|
| Refusal layer | Yes (Anthropic policy) | No |
| Cost model | Per Anthropic API token | Aether credits (pay-per-use, crypto top-up) |
| Streaming | Yes | Not yet |
| Plan mode | Yes | Not yet |
| MCP support | Yes (Anthropic's MCP) | Not yet (independent of `aether-mcp`) |
| Open source | No | Yes (MIT) |

## Privacy

- Your prompts, file reads, and shell outputs go to `trynoguard.com/api/v1/agent` only.
- Conversations are not stored server-side (no `Conversation` row, no `Message` rows). The agent endpoint is stateless beyond credit accounting.
- Source code is plain ES modules. Read it before you trust it.

## License

MIT — see [LICENSE](LICENSE).

## Related

- **[aether-cli](https://www.npmjs.com/package/aether-cli)** — non-agentic CLI for one-off prompts (`aether ask`, `deobf`, `explain`, etc.).
- **[aether-mcp](https://www.npmjs.com/package/aether-mcp)** — MCP server. Use Aether inside Claude Desktop / Cursor / Cline / Zed.
- **[aether-devtools](https://github.com/dannyphantomx64/aether-devtools)** — browser DevTools extension.
