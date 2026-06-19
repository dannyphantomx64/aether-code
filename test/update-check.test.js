import { test } from "node:test";
import assert from "node:assert/strict";
import { cmpVersion, checkForUpdate, currentVersion } from "../src/update-check.js";

const ok = (version) => async () => ({ ok: true, json: async () => ({ version }) });

test("cmpVersion orders semver correctly", () => {
  assert.ok(cmpVersion("0.15.0", "0.14.0") > 0);
  assert.ok(cmpVersion("0.2.0", "0.14.0") < 0);
  assert.equal(cmpVersion("1.2.3", "1.2.3"), 0);
  assert.ok(cmpVersion("1.0.0", "0.99.99") > 0);
});

test("checkForUpdate returns a nudge when the registry is newer", async () => {
  const cur = currentVersion();
  const [maj, min, pat] = cur.split(".").map(Number);
  const newer = `${maj}.${min}.${pat + 1}`;
  const nudge = await checkForUpdate({ fetchImpl: ok(newer) });
  assert.ok(nudge && /update available/.test(nudge));
  assert.ok(nudge.includes("npm i -g aether-code@latest"));
});

test("checkForUpdate is silent when already current", async () => {
  const nudge = await checkForUpdate({ fetchImpl: ok(currentVersion()) });
  assert.equal(nudge, null);
});

test("checkForUpdate is silent on network failure", async () => {
  const nudge = await checkForUpdate({ fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(nudge, null);
});

test("checkForUpdate is silent on a non-200", async () => {
  const nudge = await checkForUpdate({ fetchImpl: async () => ({ ok: false }) });
  assert.equal(nudge, null);
});
