# aether-code

> The uncensored Claude Code alternative for your terminal. Reads your codebase, writes code, runs commands, and — via MCP — drives IDA Pro, Roblox Studio, Wireshark, Blender, Postgres, and anything else with an MCP server. No refusal layer.

```bash
npm i -g aether-code
aether          # interactive REPL
aether "deobfuscate this binary and find the license check"
aether "build me a Roblox Lua mod that bypasses the anti-cheat check"
```

[![npm version](https://img.shields.io/npm/v/aether-code.svg)](https://www.npmjs.com/package/aether-code)
[![license](https://img.shields.io/npm/l/aether-code.svg)](LICENSE)
[![node](https://img.shields.io/node/v/aether-code.svg)](https://nodejs.org)

---

## Why aether-code

Claude Code and Cursor are excellent — but they refuse a lot:

- "Write me a stealer that bypasses Defender" → refused
- "Reverse engineer Denuvo and document the bypass" → refused
- "Build me a Roblox script that simulates clicks" → refused
- "Generate this adult interactive fiction project" → refused
- "Help me cheat at this multiplayer game" → refused

`aether-code` is the same agent loop architecture (read files → call tools → run commands → iterate) with **no refusal layer** and **no moralizing**. If your task is legal, the agent will do it. The whole product is built for the work other AI coding tools politely decline.

## Install

```bash
npm install -g aether-code        # global install
aether                            # launch interactive REPL
aether "your task"                # one-shot

# Or run without installing
npx aether-code "your task"
```

Requires Node 18+. Get an API key at [trynoguard.com/account](https://trynoguard.com/account).

```bash
aether login          # interactive setup (opens browser)
aether balance        # check credits
```

## What it can do

### Built-in tools

| Tool | What it does |
|---|---|
| `read_file` | Read any file as UTF-8 text |
| `list_dir` | List entries in a directory |
| `search_files` | Recursive regex search across the codebase |
| `write_file` | Create or overwrite a file (shows diff, y/N prompt) |
| `edit_file` | Replace exactly one occurrence (shows diff, y/N prompt) |
| `run_shell` | Run shell commands with stdout/stderr capture (y/N prompt) |
| **`web_search`** | Live web search — current docs, recent libraries, real APIs |
| **`web_fetch`** | Fetch + read a URL as text (HTML stripped, entities decoded) |
| **`todo_write`** | Plan multi-step tasks and track progress visibly |

### Plus any MCP server you connect

`aether-code` is an MCP **client**. Drop any MCP server in your config and its tools become available to the agent. The whole [MCP ecosystem](https://github.com/modelcontextprotocol) is yours:

| Domain | Example server | What the agent can now do |
|---|---|---|
| Reverse engineering | [`ida-pro-mcp`](https://github.com/mrexodia/ida-pro-mcp) | Disassemble, decompile, rename symbols, walk xrefs |
| Roblox modding | [`robloxstudio-mcp`](https://github.com/boshyxd/robloxstudio-mcp) | Read place files, write Lua mods, modify game state |
| Network analysis | wireshark-mcp / tshark-mcp | Open `.pcap`, filter, extract objects, follow streams |
| 3D / game | blender-mcp, unity-mcp, unreal-mcp | Procedurally generate scenes, scripts, materials |
| Web automation | [`@playwright/mcp`](https://www.npmjs.com/package/@playwright/mcp) | Drive browsers, scrape, fill forms, screenshot |
| Filesystem | [`@modelcontextprotocol/server-filesystem`](https://github.com/modelcontextprotocol/servers) | Whitelisted file ops outside your repo |
| Databases | Postgres MCP, SQLite MCP | Query schema, write migrations, run analytics |

Configure servers with one command — no JSON editing:

```bash
aether mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem /data
aether mcp add ida --env IDA_PATH=/opt/ida -- python -m ida_pro_mcp
aether mcp add playwright -- npx -y @playwright/mcp
aether mcp list
```

On the next `aether` launch you'll see:

```
MCP · 3/3 servers attached · 47 tools
```

The agent now has all those tools alongside the built-ins. Tool names are namespaced (`mcp__ida__decompile_function`) so they never collide with built-ins or each other.

## Examples that mainstream AI tools refuse

### Reverse-engineer a license check

```bash
cd ./binary-folder
aether
> deobfuscate ./protected.js, identify the license-check function, then write a patch that bypasses it
```

The agent: `read_file` the bundle → recognizes Obfuscator.io patterns → undoes the string-array decoder → traces the license-check flow → writes a JS patch with `edit_file` → runs the patched version to verify.

### Build a Roblox mod with the Studio MCP

```bash
aether mcp add roblox -- npx -y robloxstudio-mcp
aether "in the open .rbxl place, write a server script that gives any player who types !godmode invulnerability for 30 seconds"
```

The agent: lists scripts via the MCP → writes the Lua mod → places it in `ServerScriptService` → tests via the Studio play button (also via MCP).

### Analyze captured network traffic

```bash
aether mcp add tshark -- python -m wireshark_mcp
aether "open ./capture.pcap, find any HTTPS connection to a domain that isn't on the list in ./allowed.txt, and write a markdown report"
```

The agent: parses the pcap → cross-references the allowlist → writes a structured report. Done in one prompt.

### Build a working project from scratch

```bash
aether "build me a Discord bot that monitors a Twitter account for new posts and reposts to a channel. Full project with package.json, README, and a deploy script for Railway."
```

The agent: plans with `todo_write` → writes every file → runs `npm install` → runs `npm run build` → smoke-tests → reports back when it works end-to-end. **It doesn't stop at "main logic sketched."**

## Commands

```
aether                                  Launch interactive REPL
aether "<task>"                         Run agent once on a single task
aether login                            First-time setup (opens browser)
aether balance                          Show plan + credit balance
aether config show|set|set-base|path    Manage CLI config
aether mcp list                         Show configured MCP servers
aether mcp add <name> -- <command>      Add an MCP server (no JSON editing)
aether mcp remove <name>                Remove an MCP server
aether --help                           Full help
```

### Flags

| Flag | Effect |
|---|---|
| `--yes` | Auto-approve all writes + shell commands. Use only for trusted bounded tasks. |
| `--cwd <path>` | Clamp file operations to a specific directory (default: current dir). |
| `--max-turns <n>` | Max turns before stopping (default: 25). |
| `--unsafe-paths` | Allow file ops outside `--cwd`. Required for global-config edits. |

## Safety

By default the agent **will not act without your approval**. Each file write and each shell command shows you exactly what's about to happen and waits for `y/N`.

- **2-minute hard timeout** on every shell command
- **Output truncation** to 20 KB before being sent back to the model — runaway tests can't blow up your context
- **Path clamping** to `--cwd` by default; opt out with `--unsafe-paths`
- **No silent destructive ops** — `rm -rf`, force pushes, db drops all show the command verbatim before running

The agent's "uncensored" property is about what tasks it'll **attempt**, not about being reckless on your machine. It still asks before nuking your files.

## How it differs from Claude Code / Cursor

| | Aether Code | Claude Code | Cursor |
|---|---|---|---|
| Refusal layer | **None** | Yes (Anthropic policy) | Yes (OpenAI/Anthropic policy) |
| Cost model | Aether credits (pay-per-use, crypto OK) | Per Anthropic token, $200/mo Max plan | $20/mo subscription |
| MCP client | ✅ since v0.9.0 | ✅ | ❌ |
| Built-in web search | ✅ | ✅ | ❌ |
| Open source | ✅ MIT | ❌ | ❌ |
| Anonymous payment | ✅ crypto top-up | ❌ | ❌ |
| Works with: | Any MCP server | Anthropic MCP only | Their tools only |

## Privacy

- The agent endpoint at `trynoguard.com/api/v1/agent` is **stateless** — no Conversation rows, no Message persistence. The only thing persisted is credit accounting (which API key spent what).
- Source is plain ES modules under [src/](src/). Read it before you trust it.
- MCP server subprocesses run locally on your machine. Nothing about their data is sent to Aether servers unless the tool result feeds back into a model turn (same as built-in tools).

## Local development

```bash
git clone https://github.com/dannyphantomx64/aether-code
cd aether-code
npm install
npm test              # 78 tests via Node's built-in test runner
npm run lint
node bin/aether-code.js --help
```

## Related

- **[trynoguard.com](https://trynoguard.com)** — web chat + account dashboard + API keys
- **[aether-mcp](https://www.npmjs.com/package/aether-mcp)** — use Aether *inside* Claude Desktop / Cursor / Cline / Zed (the inverse direction)
- **[aether-cli](https://www.npmjs.com/package/aether-cli)** — non-agentic CLI for one-off prompts
- **[aether-devtools](https://github.com/dannyphantomx64/aether-devtools)** — browser DevTools extension

## License

MIT — see [LICENSE](LICENSE).
