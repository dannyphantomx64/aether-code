// Skills system: markdown files with YAML frontmatter that get loaded
// into the agent's system prompt on demand, based on what the user is
// asking about. Same idea Claude Code uses for its "superpowers" plugin —
// task-specific discipline injected just when it's relevant, instead of
// bloating every prompt with debugging-rules + TDD-rules + RE-rules + ...
//
// Skill file layout:
//
//   ---
//   name: re-analysis
//   description: Use when reverse-engineering binaries, deobfuscating code,
//                or analyzing protected executables
//   triggers:
//     pathPatterns: ["*.dll", "*.so", "*.exe", "*.bin", "*.elf"]
//     promptKeywords: ["reverse engineer", "decompile", "deobfuscate"]
//   ---
//   # Skill body — markdown
//   ...full instructions appended to the agent's system prompt...
//
// Skills live in:
//   1. ~/.aether/skills/*.md            (user-installed)
//   2. <bundled>/skills/*.md            (first-party, ships with aether-code)
//
// First-party skills cover the verticals Aether's audience cares about:
// debugging, RE, NSFW creative, security research, game modding.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILLS_DIR = path.join(HERE, "..", "skills");
const USER_SKILLS_DIR = path.join(os.homedir(), ".aether", "skills");

// Parse a markdown file with YAML-like frontmatter. Not a full YAML parser
// (would be a dep) — handles the small subset we use: name, description,
// triggers.pathPatterns, triggers.promptKeywords. Throws on malformed input
// so a bad skill is caught at load time, not at trigger time.
export function parseSkill(raw, sourcePath = "<inline>") {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`Skill ${sourcePath}: empty content`);
  }
  if (!raw.startsWith("---")) {
    throw new Error(`Skill ${sourcePath}: missing YAML frontmatter (must start with '---')`);
  }
  const endMatch = raw.match(/\n---\n/);
  if (!endMatch) {
    throw new Error(`Skill ${sourcePath}: unterminated frontmatter (need closing '---' on its own line)`);
  }
  const frontmatter = raw.slice(3, endMatch.index).trim();
  const body = raw.slice(endMatch.index + endMatch[0].length).trim();

  const skill = {
    sourcePath,
    name: null,
    description: "",
    triggers: { pathPatterns: [], promptKeywords: [] },
    body,
  };

  // Minimal YAML: top-level `key: value` lines, plus a nested `triggers:`
  // section with `pathPatterns:` and `promptKeywords:` arrays.
  let section = null; // "triggers" when inside that block
  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Two-space indent → inside the current section.
    const indented = /^\s{2,}\S/.test(line);
    if (!indented) {
      // top-level
      section = null;
      const [k, ...rest] = trimmed.split(":");
      const key = k.trim();
      const val = rest.join(":").trim();
      if (key === "name") skill.name = stripQuotes(val);
      else if (key === "description") skill.description = stripQuotes(val);
      else if (key === "triggers") section = "triggers";
    } else if (section === "triggers") {
      const [k, ...rest] = trimmed.split(":");
      const key = k.trim();
      const val = rest.join(":").trim();
      if (key === "pathPatterns" || key === "promptKeywords") {
        skill.triggers[key] = parseInlineArray(val, sourcePath, key);
      }
    }
  }

  if (!skill.name) {
    throw new Error(`Skill ${sourcePath}: missing required field "name"`);
  }
  if (!/^[a-z0-9_-]{1,60}$/i.test(skill.name)) {
    throw new Error(`Skill ${sourcePath}: name "${skill.name}" must be 1-60 chars of [A-Za-z0-9_-]`);
  }
  if (skill.body.length === 0) {
    throw new Error(`Skill ${sourcePath}: empty body — frontmatter must be followed by markdown content`);
  }
  return skill;
}

function stripQuotes(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseInlineArray(val, source, key) {
  // Accept `["a", "b"]` (inline JSON-ish array) since that's the common
  // pattern in skill files. Anything else is a hard error so we don't
  // silently miss a misformatted trigger list.
  const m = val.match(/^\[(.*)\]$/);
  if (!m) {
    throw new Error(`Skill ${source}: triggers.${key} must be an inline array like ["a", "b"]`);
  }
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(stripQuotes);
}

/**
 * Walk a directory of skill files and return parsed skills. Missing dir
 * returns []. Malformed files throw so the user sees the error early.
 */
export function loadSkillsFromDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const skills = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const filePath = path.join(dir, name);
    const raw = fs.readFileSync(filePath, "utf8");
    skills.push(parseSkill(raw, filePath));
  }
  return skills;
}

export function loadAllSkills() {
  return [...loadSkillsFromDir(BUNDLED_SKILLS_DIR), ...loadSkillsFromDir(USER_SKILLS_DIR)];
}

/**
 * Glob-to-regex converter for path patterns (supports `*` and `?`).
 * Anchored: matches the full string, not a substring.
 */
export function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp("^" + re + "$", "i");
}

/**
 * Decide which skills' bodies should be appended to the system prompt for
 * a given turn. A skill matches if ANY of its triggers fire:
 *   - a promptKeyword appears in the user's prompt (case-insensitive)
 *   - a pathPattern matches any file path in `referencedPaths`
 * Returns the matching skills in insertion order (bundled before user).
 */
export function selectSkills({ skills, prompt = "", referencedPaths = [] }) {
  const lowerPrompt = (prompt || "").toLowerCase();
  const out = [];
  for (const s of skills) {
    const kwHit = s.triggers.promptKeywords.some((kw) =>
      lowerPrompt.includes(kw.toLowerCase()),
    );
    const pathHit =
      !kwHit &&
      s.triggers.pathPatterns.some((g) => {
        const re = globToRegex(g);
        return referencedPaths.some((p) => re.test(path.basename(p)));
      });
    if (kwHit || pathHit) out.push(s);
  }
  return out;
}

/**
 * Build the text block to append to the system prompt when one or more
 * skills are active for this turn. Empty string when nothing matched.
 */
export function renderSkillsBlock(activeSkills) {
  if (activeSkills.length === 0) return "";
  const sections = activeSkills.map((s) => `### Skill: ${s.name}\n${s.body}`);
  return (
    "\n\n=== LOADED SKILLS (apply when relevant to this turn) ===\n\n" +
    sections.join("\n\n---\n\n")
  );
}
