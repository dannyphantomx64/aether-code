// Tiny line-by-line diff for write_file confirmation prompts.
// Not a "real" diff — just a side-by-side highlight of what's changing.
// Good enough for confirmation prompts, deliberately not pretending to be `git diff`.

import { c } from "./render.js";

export function unifiedDiff(oldText, newText, filename) {
  const oldLines = (oldText || "").split("\n");
  const newLines = (newText || "").split("\n");
  const max = Math.max(oldLines.length, newLines.length);

  // Find common prefix and suffix to keep the diff focused
  let prefix = 0;
  while (prefix < max && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const changedOld = oldLines.slice(prefix, oldLines.length - suffix);
  const changedNew = newLines.slice(prefix, newLines.length - suffix);

  const lines = [];
  lines.push(c.bold(c.cyan(`@@ ${filename} @@`)));
  if (prefix > 0) lines.push(c.gray(`  …${prefix} unchanged line${prefix === 1 ? "" : "s"} above…`));
  for (const l of changedOld) lines.push(c.red(`- ${l}`));
  for (const l of changedNew) lines.push(c.green(`+ ${l}`));
  if (suffix > 0) lines.push(c.gray(`  …${suffix} unchanged line${suffix === 1 ? "" : "s"} below…`));

  // Cap output so massive writes don't flood the terminal
  if (lines.length > 60) {
    return [...lines.slice(0, 30), c.gray(`  …${lines.length - 60} more lines hidden…`), ...lines.slice(-30)].join(
      "\n",
    );
  }
  return lines.join("\n");
}

export function summarizeWrite(oldText, newText, filename) {
  const oldLines = (oldText || "").split("\n").length;
  const newLines = (newText || "").split("\n").length;
  const isCreate = oldText === null || oldText === undefined;
  const verb = isCreate ? "create" : "rewrite";
  return c.dim(`${verb} ${filename} (${oldLines} → ${newLines} lines, ${(newText || "").length} bytes)`);
}
