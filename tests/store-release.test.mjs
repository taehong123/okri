import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL("../" + path, import.meta.url), "utf8");

test("store metadata is complete, localized and within first-release field limits", async () => {
  const copy = JSON.parse(await read("mobile/release/store-copy.json"));
  assert.equal(copy.accountDeletionUrl, "https://okri.ai/account-deletion?lang=en");
  assert.deepEqual(Object.keys(copy.localizations), ["ko-KR", "en-US", "ja", "zh-Hans", "es-ES"]);
  for (const [locale, value] of Object.entries(copy.localizations)) {
    assert.ok(value.title.length <= 30, locale + " title");
    assert.ok(value.subtitle.length <= 30, locale + " subtitle");
    assert.ok(value.shortDescription.length <= 80, locale + " short description");
    assert.ok(value.description.length <= 4000, locale + " description");
    assert.ok(Buffer.byteLength(value.keywords, "utf8") <= 100, locale + " keywords");
    assert.ok(value.releaseNotes.length > 20, locale + " release notes");
  }
});

test("review packet matches native permissions, commerce and deletion behavior", async () => {
  const packet = JSON.parse(await read("mobile/release/review-readiness.json"));
  const config = await read("mobile/app.config.ts"), app = await read("mobile/App.tsx"), settings = await read("mobile/src/screens/settings.tsx");
  const deletionPage = await read("app/account-deletion/page.tsx"), deletionRoute = await read("app/api/account/deletion/route.ts"), googleSession = await read("lib/google-session.ts");
  assert.equal(packet.identity.bundleId, "ai.okri.app"); assert.equal(packet.identity.accountDeletionUrl, "https://okri.ai/account-deletion?lang=en");
  assert.equal(packet.apple.supportsTablet, false); assert.match(config, /supportsTablet: false/); assert.match(config, /usesAppleSignIn: true/);
  assert.equal(packet.commerce.digitalPurchaseInApp, false); assert.doesNotMatch(app, /billing|paypal|purchase|subscription/i);
  assert.match(packet.googlePlay.appAccessInstructions, /App review access/); assert.equal(packet.access.demoCredentialCommitted, false);
  assert.match(settings, /계정 삭제/); assert.match(deletionPage, /ko:[\s\S]*en:[\s\S]*ja:[\s\S]*zh:[\s\S]*es:/);
  assert.match(deletionRoute, /RECENT_AUTH_SECONDS/); assert.match(deletionRoute, /deleteNativeUserAccount/); assert.match(googleSession, /issuedAt/);
});

test("feedback integrations are secret-backed and target only the resolved dev channel", async () => {
  const docs = await read("docs/store-release.md"), apple = await read("app/api/store-feedback/apple/route.ts"), google = await read("app/api/store-feedback/google-play/route.ts"), script = await read("scripts/google-play-review-alert.gs");
  assert.match(docs, /C0AQ7SQC9P0/); assert.match(docs, /U0ALQ0TAN6A/);
  assert.match(apple, /x-apple-signature/); assert.match(apple, /APPLE_STORE_WEBHOOK_SECRET/);
  assert.match(google, /x-okri-store-signature/); assert.match(google, /GOOGLE_PLAY_FEEDBACK_SECRET/);
  assert.match(script, /everyMinutes\(5\)/); assert.doesNotMatch(script, /taehong0613@gmail\.com/);
});
