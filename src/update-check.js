// Startup update check — like Claude Code / npm itself nudging you when a newer
// version is published. Never throws, bounded by a short timeout so it can't
// slow or block startup; silent when offline or already current.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { c } from "./render.js";

export function currentVersion() {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(readFileSync(p, "utf8")).version || null;
  } catch {
    return null;
  }
}

// Compare two "x.y.z" strings. Returns >0 if a is newer than b.
export function cmpVersion(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Resolve a one-line "update available" nudge if the npm registry has a newer
 * version than the installed one — otherwise null. Bounded to ~2s; any failure
 * (offline, timeout, registry hiccup) resolves to null silently.
 */
export async function checkForUpdate({ fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  const current = currentVersion();
  if (!current) return null;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl("https://registry.npmjs.org/aether-code/latest", { signal: ac.signal });
    } finally {
      clearTimeout(t);
    }
    if (!res || !res.ok) return null;
    const latest = (await res.json())?.version;
    if (latest && cmpVersion(latest, current) > 0) {
      return (
        c.yellow("update available: ") +
        c.gray(current) + " -> " + c.bold(c.green(latest)) +
        c.gray("  ·  run ") + c.cyan("npm i -g aether-code@latest")
      );
    }
  } catch {
    /* offline / aborted / parse error — stay silent */
  }
  return null;
}
