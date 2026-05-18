// Tests for the skills system (src/skills.js).
// Pure-function tests against fixtures we construct inline — no fs setup
// for parse logic, only for the directory-loader.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseSkill,
  globToRegex,
  selectSkills,
  renderSkillsBlock,
  loadSkillsFromDir,
} from "../src/skills.js";

describe("parseSkill — frontmatter + body extraction", () => {
  test("parses a minimal valid skill", () => {
    const raw = `---
name: re
description: Reverse-engineering helper
triggers:
  promptKeywords: ["reverse", "decompile"]
  pathPatterns: ["*.exe"]
---
# Body
Here are the instructions.
`;
    const s = parseSkill(raw, "test.md");
    assert.equal(s.name, "re");
    assert.equal(s.description, "Reverse-engineering helper");
    assert.deepEqual(s.triggers.promptKeywords, ["reverse", "decompile"]);
    assert.deepEqual(s.triggers.pathPatterns, ["*.exe"]);
    assert.match(s.body, /Here are the instructions/);
  });

  test("rejects missing frontmatter delimiter", () => {
    assert.throws(() => parseSkill("just markdown, no frontmatter", "x.md"), /frontmatter/);
  });

  test("rejects unterminated frontmatter", () => {
    assert.throws(() => parseSkill("---\nname: x\nno closing dashes\n", "x.md"), /unterminated/);
  });

  test("rejects missing name field", () => {
    const raw = `---
description: no name though
---
body
`;
    assert.throws(() => parseSkill(raw, "x.md"), /name/);
  });

  test("rejects invalid name characters", () => {
    const raw = `---
name: has spaces and!
description: x
---
body
`;
    assert.throws(() => parseSkill(raw, "x.md"), /name/);
  });

  test("rejects empty body", () => {
    const raw = `---
name: empty-body
description: x
---
`;
    assert.throws(() => parseSkill(raw, "x.md"), /empty body/);
  });

  test("rejects malformed triggers (not an inline array)", () => {
    const raw = `---
name: bad
description: x
triggers:
  promptKeywords: just, comma, separated
---
body
`;
    assert.throws(() => parseSkill(raw, "x.md"), /inline array/);
  });

  test("handles single and double quoted strings", () => {
    const raw = `---
name: 'quoted-name'
description: "double quoted"
triggers:
  promptKeywords: ['a', "b"]
---
body
`;
    const s = parseSkill(raw, "x.md");
    assert.equal(s.name, "quoted-name");
    assert.equal(s.description, "double quoted");
    assert.deepEqual(s.triggers.promptKeywords, ["a", "b"]);
  });

  test("triggers field is optional (both subkeys default to [])", () => {
    const raw = `---
name: notrig
description: no triggers
---
body content
`;
    const s = parseSkill(raw, "x.md");
    assert.deepEqual(s.triggers.promptKeywords, []);
    assert.deepEqual(s.triggers.pathPatterns, []);
  });
});

describe("globToRegex", () => {
  test("matches with `*` wildcard", () => {
    const re = globToRegex("*.exe");
    assert.ok(re.test("foo.exe"));
    assert.ok(re.test("foo.bar.exe"));
    assert.ok(!re.test("foo.dll"));
  });

  test("matches with `?` single char", () => {
    const re = globToRegex("file?.txt");
    assert.ok(re.test("file1.txt"));
    assert.ok(re.test("fileA.txt"));
    assert.ok(!re.test("file12.txt"));
  });

  test("case-insensitive", () => {
    const re = globToRegex("*.EXE");
    assert.ok(re.test("foo.exe"));
    assert.ok(re.test("FOO.EXE"));
  });

  test("anchored — no partial match", () => {
    const re = globToRegex("*.bin");
    assert.ok(!re.test("foo.bin.bak"));
  });
});

describe("selectSkills — trigger matching", () => {
  const skills = [
    parseSkill(`---
name: re
description: RE skill
triggers:
  promptKeywords: ["reverse engineer", "decompile"]
  pathPatterns: ["*.exe", "*.dll"]
---
re body
`, "re.md"),
    parseSkill(`---
name: debug
description: Debug skill
triggers:
  promptKeywords: ["fix the bug", "failing test"]
  pathPatterns: []
---
debug body
`, "debug.md"),
  ];

  test("matches by prompt keyword (case-insensitive)", () => {
    const out = selectSkills({ skills, prompt: "Please REVERSE ENGINEER this binary" });
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "re");
  });

  test("matches by path pattern when no keyword matches", () => {
    const out = selectSkills({
      skills,
      prompt: "look at this file",
      referencedPaths: ["/tmp/foo.exe"],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "re");
  });

  test("matches multiple skills on one turn", () => {
    const out = selectSkills({
      skills,
      prompt: "reverse engineer this and fix the bug in the loader",
    });
    assert.equal(out.length, 2);
  });

  test("no match returns []", () => {
    const out = selectSkills({ skills, prompt: "hi how are you" });
    assert.deepEqual(out, []);
  });

  test("empty prompt + no paths returns []", () => {
    const out = selectSkills({ skills });
    assert.deepEqual(out, []);
  });
});

describe("renderSkillsBlock", () => {
  test("empty list returns empty string", () => {
    assert.equal(renderSkillsBlock([]), "");
  });

  test("non-empty list produces a labeled block with the skill bodies", () => {
    const skill = parseSkill(
      `---
name: x
description: y
---
hello body
`,
      "x.md",
    );
    const out = renderSkillsBlock([skill]);
    assert.match(out, /LOADED SKILLS/);
    assert.match(out, /Skill: x/);
    assert.match(out, /hello body/);
  });

  test("multiple skills are separated", () => {
    const a = parseSkill(`---\nname: a\ndescription: x\n---\nA body\n`, "a.md");
    const b = parseSkill(`---\nname: b\ndescription: x\n---\nB body\n`, "b.md");
    const out = renderSkillsBlock([a, b]);
    assert.match(out, /A body/);
    assert.match(out, /B body/);
    assert.match(out, /---/);
  });
});

describe("loadSkillsFromDir", () => {
  test("returns [] for nonexistent directory (the no-skills case)", () => {
    const fakeDir = path.join(os.tmpdir(), `aether-skills-missing-${Date.now()}`);
    assert.deepEqual(loadSkillsFromDir(fakeDir), []);
  });

  test("loads only .md files from a real directory", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-skills-test-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "good.md"),
        `---
name: good
description: ok
---
body
`,
      );
      fs.writeFileSync(path.join(tmpDir, "ignored.txt"), "not a skill");
      fs.writeFileSync(path.join(tmpDir, "also-ignored.json"), "{}");
      const skills = loadSkillsFromDir(tmpDir);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, "good");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("throws on a malformed skill file (loud failure)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-skills-bad-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "bad.md"), "no frontmatter at all");
      assert.throws(() => loadSkillsFromDir(tmpDir), /frontmatter/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("first-party skills bundled with aether-code parse cleanly", () => {
    // Sanity check that the bundled fixtures we ship actually load.
    const bundledDir = path.join(
      path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Z]:)/, ""),
      "..",
      "skills",
    );
    if (!fs.existsSync(bundledDir)) return; // no bundled dir on this build
    const skills = loadSkillsFromDir(bundledDir);
    assert.ok(skills.length >= 1, "expected at least one bundled skill");
    for (const s of skills) {
      assert.ok(s.name);
      assert.ok(s.body.length > 50, `bundled skill ${s.name} body too short`);
    }
  });
});
