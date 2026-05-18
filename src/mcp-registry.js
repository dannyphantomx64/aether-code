// Curated registry of well-known MCP servers users can install with
// `aether mcp install <name>` instead of typing the full npx command.
//
// Conservative inclusion criteria:
//   1. Published to npm under a known scope (@modelcontextprotocol/*,
//      @playwright/*, etc.) OR widely-cited community packages
//   2. stdio transport (which is all MCPManager supports today)
//   3. Installable via npx -y with no separate global install step
//
// We DON'T include servers that need a local binary (IDA Pro, Ghidra,
// Wireshark) because the install path is environment-specific — those
// users need to read each project's README anyway, so `mcp install` won't
// save them work. The README shows their `mcp add` commands instead.
//
// Adding a new entry: confirm the package exists on npm, confirm the
// stdio entrypoint runs cleanly with `npx -y <pkg>`, then drop in here.

/**
 * Each entry has:
 *   id           — kebab-case name used as the MCP server name in config
 *                 (must satisfy /^[a-z0-9_-]{1,40}$/i per mcp.js validator)
 *   command      — base spawn command (typically "npx")
 *   args         — array of args; entries wrapped in `{placeholder}` get
 *                 substituted from user-provided inputs
 *   requires     — array of placeholder names the user must supply
 *   prompts      — { placeholder: "interactive prompt text shown to user" }
 *   description  — one-line summary shown by `mcp list`/`mcp search`
 *   tags         — keywords for `mcp search` matching
 *   source       — "official" (anthropic / first-party orgs), "community"
 */
export const MCP_REGISTRY = [
  {
    id: "filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "{path}"],
    requires: ["path"],
    prompts: { path: "Allowed filesystem path (the server will be sandboxed here)" },
    description: "Read/write/list files under a whitelisted directory",
    tags: ["files", "fs", "disk", "filesystem", "local"],
    source: "official",
  },
  {
    id: "github",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    requires: [],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{token}" },
    requiresEnv: ["token"],
    prompts: { token: "GitHub personal access token (https://github.com/settings/tokens — repo scope)" },
    description: "Browse + edit GitHub repos, issues, PRs",
    tags: ["github", "git", "repo", "issues", "pull request", "pr"],
    source: "official",
  },
  {
    id: "gitlab",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-gitlab"],
    requires: [],
    env: { GITLAB_PERSONAL_ACCESS_TOKEN: "{token}", GITLAB_API_URL: "{url}" },
    requiresEnv: ["token", "url"],
    prompts: {
      token: "GitLab personal access token (api scope)",
      url: "GitLab API URL (default: https://gitlab.com/api/v4)",
    },
    description: "Browse + edit GitLab projects, issues, MRs",
    tags: ["gitlab", "git", "repo", "issues", "merge request", "mr"],
    source: "official",
  },
  {
    id: "postgres",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", "{connection}"],
    requires: ["connection"],
    prompts: { connection: "Postgres connection string (postgresql://user:pass@host:port/db)" },
    description: "Query Postgres databases (read-only by default)",
    tags: ["postgres", "postgresql", "database", "db", "sql"],
    source: "official",
  },
  {
    id: "sqlite",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sqlite", "{db_path}"],
    requires: ["db_path"],
    prompts: { db_path: "Path to the SQLite database file" },
    description: "Query SQLite databases",
    tags: ["sqlite", "database", "db", "sql"],
    source: "official",
  },
  {
    id: "puppeteer",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    requires: [],
    description: "Drive a headless browser via Puppeteer (navigate, screenshot, fill forms, scrape)",
    tags: ["browser", "headless", "scrape", "puppeteer", "automation", "chrome"],
    source: "official",
  },
  {
    id: "playwright",
    command: "npx",
    args: ["-y", "@playwright/mcp"],
    requires: [],
    description: "Drive Chrome/Firefox/WebKit via Playwright (more capable than puppeteer)",
    tags: ["browser", "playwright", "scrape", "automation", "chromium", "firefox", "webkit"],
    source: "official",
  },
  {
    id: "slack",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    requires: [],
    env: { SLACK_BOT_TOKEN: "{bot_token}", SLACK_TEAM_ID: "{team_id}" },
    requiresEnv: ["bot_token", "team_id"],
    prompts: {
      bot_token: "Slack bot token (xoxb-…)",
      team_id: "Slack team/workspace ID (T…)",
    },
    description: "Read + post in Slack channels, list users, fetch threads",
    tags: ["slack", "chat", "messaging", "workspace"],
    source: "official",
  },
  {
    id: "google-drive",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-gdrive"],
    requires: [],
    description: "List + read Google Drive files (requires OAuth setup, see docs)",
    tags: ["google", "drive", "gdrive", "files", "cloud"],
    source: "official",
  },
  {
    id: "memory",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    requires: [],
    description: "Persistent knowledge-graph memory across agent sessions",
    tags: ["memory", "kg", "knowledge graph", "persistence", "notes"],
    source: "official",
  },
  {
    id: "fetch",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
    requires: [],
    description: "Fetch web pages + convert to markdown (alternative to built-in web_fetch)",
    tags: ["http", "fetch", "web", "url", "markdown"],
    source: "official",
  },
  {
    id: "everart",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everart"],
    requires: [],
    env: { EVERART_API_KEY: "{key}" },
    requiresEnv: ["key"],
    prompts: { key: "EverArt API key (https://everart.ai)" },
    description: "Generate images via EverArt",
    tags: ["image", "generate", "art", "everart"],
    source: "official",
  },
];

const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;

/**
 * Look up a registry entry by id. Returns null for unknown names.
 */
export function findRegistryEntry(id) {
  return MCP_REGISTRY.find((e) => e.id === id) ?? null;
}

/**
 * Apply user-provided placeholder values to an entry's args + env.
 * Returns { command, args, env } ready to pass to addServer(), or
 * throws if a required placeholder wasn't supplied.
 *
 *   resolveEntry(filesystemEntry, { path: "/tmp" })
 *   → { command: "npx", args: ["-y", "...", "/tmp"], env: {} }
 */
export function resolveEntry(entry, values) {
  if (!entry) throw new Error("resolveEntry: entry is required");
  const seen = new Set();
  const substitute = (s) =>
    s.replace(PLACEHOLDER_RE, (_, key) => {
      seen.add(key);
      const v = values?.[key];
      if (v === undefined || v === null || v === "") {
        throw new Error(`Missing required value for {${key}}`);
      }
      return String(v);
    });
  const args = (entry.args ?? []).map(substitute);
  const env = {};
  for (const [k, raw] of Object.entries(entry.env ?? {})) {
    env[k] = substitute(raw);
  }
  // Sanity-check that we got every required placeholder.
  for (const k of entry.requires ?? []) {
    if (!seen.has(k)) {
      // Required but never referenced in args — flag in case the registry
      // entry is malformed. Defense in depth.
      throw new Error(`Registry entry "${entry.id}": "${k}" listed in requires but never used`);
    }
  }
  for (const k of entry.requiresEnv ?? []) {
    if (!seen.has(k)) {
      throw new Error(`Registry entry "${entry.id}": env placeholder "${k}" listed but never used`);
    }
  }
  return { command: entry.command, args, env };
}

/**
 * Search registry by free-text query. Matches id, description, and tags.
 * Case-insensitive substring match. Returns entries ordered by relevance
 * (id matches first, then tag matches, then description matches).
 */
export function searchRegistry(query) {
  const q = (query || "").toLowerCase().trim();
  if (!q) return [...MCP_REGISTRY];
  const idHits = [];
  const tagHits = [];
  const descHits = [];
  for (const e of MCP_REGISTRY) {
    if (e.id.includes(q)) {
      idHits.push(e);
    } else if ((e.tags ?? []).some((t) => t.toLowerCase().includes(q))) {
      tagHits.push(e);
    } else if ((e.description ?? "").toLowerCase().includes(q)) {
      descHits.push(e);
    }
  }
  return [...idHits, ...tagHits, ...descHits];
}

/**
 * For "unknown id" errors: return the closest registry ids to a typo,
 * up to 3 suggestions. Simple edit-distance-style proximity using the
 * length-diff + character-overlap heuristic — good enough to suggest
 * "playwright" when the user types "playright".
 */
export function suggestSimilar(id) {
  const target = id.toLowerCase();
  const scored = MCP_REGISTRY.map((e) => ({
    id: e.id,
    score: similarity(target, e.id.toLowerCase()),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0.4).slice(0, 3).map((s) => s.id);
}

function similarity(a, b) {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  // Crude bigram-overlap. Good enough to catch one-character typos.
  const bigrams = (s) => {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let shared = 0;
  for (const x of A) if (B.has(x)) shared++;
  return (2 * shared) / (A.size + B.size);
}
