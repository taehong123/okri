import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Apple subscription draft starts at one editor and cannot enable unapproved sales", async () => {
  const catalog = JSON.parse(await readFile(new URL("../mobile/release/apple-subscriptions.json", import.meta.url), "utf8"));
  assert.equal(catalog.bundleId, "ai.okri.app");
  assert.equal(catalog.scope, "single-editor-workspace");
  assert.equal(catalog.maxBillableEditors, 1);
  assert.equal(catalog.familySharing, false);
  assert.equal(catalog.subscriptionPeriod, "ONE_MONTH");
  assert.equal(catalog.status, "draft-not-for-sale");
  assert.equal(catalog.purchaseEnabled, false);
  assert.equal(catalog.storeRegistrationConfirmed, false);
  assert.deepEqual(catalog.products.map(product => product.plan), ["team", "business"]);
  assert.equal(new Set(catalog.products.map(product => product.proposedProductId)).size, 2);
  for (const product of catalog.products) assert.equal(product.approvedPrice, null);
});
