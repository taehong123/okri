import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compileLanguageModule } from "./helpers/language-fixture.mjs";
import { validateEvidence } from "../mobile/scripts/release-lib.mjs";
const read = p => readFile(new URL("../" + p, import.meta.url), "utf8");
const policy = compileLanguageModule(await read("lib/mobile/release-policy.ts"));
const registry = () => ({ schemaVersion: 1, ios: { storeUrl: "https://apps.apple.com/app/id123456", releases: [], retirements: [] }, android: { storeUrl: "https://play.google.com/store/apps/details?id=ai.okri.app", releases: [], retirements: [] } });
test("unpublished/future store releases cannot prompt or retire an installed client", async () => {
  const actual = JSON.parse(await read("lib/mobile/releases.json")); policy.validateRegistry(actual);
  const r = registry();
  r.ios.releases.push({ version: "1.0.0", build: "1", fullyAvailableAt: "2027-01-01T00:00:00Z" });
  assert.equal(policy.publicPolicy(r, "ios", new Date("2026-09-08")).storeUrl, null);
  assert.equal(policy.publicPolicy(r, "android").latestVersion, null);
});
test("retirement requires 180 days after first successor, two available successors and 30-day notice", () => {
  const r = registry();
  r.ios.releases = ["1.0.0", "1.1.0", "1.2.0"].map((version, i) => ({ version, build: String(i + 1), fullyAvailableAt: ["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"][i] }));
  r.ios.retirements = [{ version: "1.0.0", announcedAt: "2026-08-01T00:00:00Z", endsAt: "2026-09-01T00:00:00Z" }];
  assert.doesNotThrow(() => policy.validateRegistry(r));
  const original = structuredClone(r);
  r.ios.retirements[0].endsAt = "2026-04-01T00:00:00Z"; assert.throws(() => policy.validateRegistry(r));
  r.ios = structuredClone(original.ios); r.ios.releases.pop(); assert.throws(() => policy.validateRegistry(r));
  r.ios = structuredClone(original.ios); r.ios.retirements[0].announcedAt = "2026-08-31T00:00:00Z"; assert.throws(() => policy.validateRegistry(r));
  assert.deepEqual(policy.publicPolicy(original, "android").retiredVersions, []);
});
test("numeric versions and malformed/offline policy fail open without attacker-controlled links", () => {
  assert.equal(policy.compareVersions("1.10.0", "1.9.9"), 1);
  for (const url of ["javascript:alert(1)", "https://apps.apple.com.evil.test/app/id123", "https://evil.test", "https://play.google.com/store/apps/details?id=other"]) assert.equal(policy.validStoreUrl("android", url), false);
  for (const value of [null, {}, { schemaVersion: 1, apiVersion: 1, platform: "ios", latestVersion: "invalid", storeUrl: "https://apps.apple.com/app/id123456", retiredVersions: [] }]) assert.equal(policy.updateOffer(value, "ios", "1.0.0"), null);
});
test("production app updates only through store binaries and never reloads active forms", async () => {
  const config = await read("mobile/app.config.ts");
  assert.match(config, /policy: "fingerprint"/); assert.match(config, /fallbackToCacheTimeout: 0/);
  assert.match(config, /useEmbeddedUpdate: true/); assert.match(config, /enabled: false/);
  assert.doesNotMatch(config, /EAS_PROJECT|u\.expo\.dev|owner:/);
  const release = await read("mobile/src/release-status.tsx");
  assert.doesNotMatch(release, /reloadAsync|reloadAppAsync/);
  const entry = await read("mobile/scripts/export-preview.mjs");
  assert.doesNotMatch(entry, /writeFile|package\.json/);
});
test("release evidence is source-bound, fresh, physical-device tested and platform-specific", () => {
  const now = Date.parse("2026-09-08T00:00:00Z"), digest = "d".repeat(64);
  const checks = Object.fromEntries(["googleLogin", "appleLogin", "dailySubmission", "workspaceIsolation", "accountDeletion", "systemText200Percent", "screenReader", "previousClientAgainstCurrentServer", "offlineStart", "rollback", "privacyDeclarationsReviewed", "dependencyAdvisoriesReviewed"].map(k => [k, true]));
  const e = { schemaVersion: 1, sourceCommit: "a".repeat(40), sourceDigest: digest, checkedAt: new Date(now).toISOString(), reviewedBy: "Release reviewer", ios: { buildNumber: "1", artifactSha256: "b".repeat(64), device: "Physical iPhone", osVersion: "actual installed OS", checks } };
  const opts = { platform: "ios", kind: "submit", digest, now };
  assert.doesNotThrow(() => validateEvidence(e, opts));
  assert.throws(() => validateEvidence(e, { ...opts, platform: "android" }));
  assert.throws(() => validateEvidence(e, { ...opts, digest: "changed" }));
  assert.throws(() => validateEvidence(e, { ...opts, now: now + 15 * 86400000 }));
  assert.throws(() => validateEvidence({ ...e, ios: { ...e.ios, buildNumber: "not-a-number" } }, opts));
});
