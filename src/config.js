// Config — reads ~/.aetherrc (shared format with aether-cli) and env vars.
// Same precedence: env wins over file.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const FILE = path.join(os.homedir(), ".aetherrc");
const DEFAULT_BASE = "https://trynoguard.com";

export function readConfigFile() {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function writeConfigFile(patch) {
  const current = readConfigFile();
  const next = { ...current, ...patch };
  // 0600 — readable only by the user. Mirrors what ssh, gnupg, etc. enforce
  // on credential files. Treat the API key like an SSH key.
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* windows ignores */ }
}

export function getConfig() {
  const file = readConfigFile();
  return {
    apiKey: process.env.AETHER_API_KEY || file.apiKey || "",
    baseUrl: (process.env.AETHER_BASE_URL || file.baseUrl || DEFAULT_BASE).replace(/\/+$/, ""),
    configPath: FILE,
  };
}

export const CONFIG_PATH = FILE;
