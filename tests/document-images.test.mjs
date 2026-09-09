import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function moduleAt(path, imports = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", compiled)(name => {
    if (!(name in imports)) throw new Error(`Unexpected import: ${name}`);
    return imports[name];
  }, loaded, loaded.exports);
  return loaded.exports;
}
const helpers = await moduleAt("../lib/document-images.ts");
const imageHelpers = await moduleAt("../lib/project-images.ts", { "cloudflare:workers": { env: {} }, "@/lib/slack-daily": {} });
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function fixture({ owner = "workspace", viewer = false, unauthorized = false, accessible = true, missingStorage = false, afterUpload = false } = {}) {
  const objects = new Map();
  const queries = [];
  const deleted = [];
  let uploaded = false;
  const runtime = {
    DB: { prepare: sql => ({ bind: (...values) => ({ first: async () => {
      queries.push({ sql, values });
      assert.match(sql, /owner_id = \? AND id = \?/);
      if (!accessible || (uploaded && afterUpload) || values[0] !== "workspace") return null;
      if (sql.includes("routines")) { assert.match(sql, /system_key IS NULL/); return values[1] === "routine-1" ? { id: "routine-1" } : null; }
      assert.match(sql, /kind = \? AND archived_at IS NULL/);
      return values[1] === `${values[2]}-1` ? { id: values[1] } : null;
    } }) }) },
    WORKSPACE_AVATARS: missingStorage ? undefined : {
      put: async (key, bytes, metadata) => { uploaded = true; objects.set(key, { bytes, ...metadata }); },
      get: async key => { const stored = objects.get(key); return stored ? { ...stored, size: stored.bytes.length, arrayBuffer: async () => stored.bytes.buffer } : null; },
      delete: async key => { deleted.push(key); objects.delete(key); },
    },
  };
  const routes = await moduleAt("../app/api/document-images/route.ts", {
    "cloudflare:workers": { env: runtime },
    "@/lib/document-images": helpers,
    "@/lib/project-images": imageHelpers,
    "@/lib/pace-data": { authorizeRequest: async request => unauthorized ? new Response(null, { status: 401 }) : viewer && request.method !== "GET" ? new Response(null, { status: 403 }) : { ownerId: owner, userId: "user" } },
  });
  return { ...routes, objects, queries, deleted };
}
function upload(kind = "project", body = png, headers = { "Content-Type": "image/png" }, id = `${kind}-1`) {
  return new Request(`https://okri.test/api/document-images?targetKind=${kind}&targetId=${id}&name=한글%20image.png`, { method: "POST", headers, body });
}

test("only scoped Project, Task and custom Routine targets are accepted", () => {
  for (const kind of ["project", "task", "routine"]) assert.deepEqual(helpers.readDocumentImageTarget(new URLSearchParams({ targetKind: kind, targetId: `${kind}-1` })), { targetKind: kind, targetId: `${kind}-1` });
  for (const id of ["../other", "", "a/b", "x".repeat(129)]) assert.equal(helpers.readDocumentImageTarget(new URLSearchParams({ targetKind: "project", targetId: id })), null);
  assert.equal(helpers.readDocumentImageTarget(new URLSearchParams({ targetKind: "template", targetId: "id" })), null);
});
test("image uploads and authenticated reads work for all three document types", async () => {
  for (const kind of ["project", "task", "routine"]) {
    const f = await fixture();
    const response = await f.POST(upload(kind));
    assert.equal(response.status, 201);
    const { url } = await response.json();
    assert.match(url, /^\/api\/document-images\?/);
    const image = await f.GET(new Request(`https://okri.test${url}`));
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("cache-control"), "private, no-store");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);
  }
});
test("unauthenticated, viewer and cross-workspace writes cannot store images", async () => {
  for (const [options, status] of [[{ unauthorized: true }, 401], [{ viewer: true }, 403], [{ owner: "other" }, 404], [{ accessible: false }, 404]]) {
    const f = await fixture(options);
    assert.equal((await f.POST(upload())).status, status);
    assert.equal(f.objects.size, 0);
  }
});
test("wrong kind, General and archived targets never touch storage", async () => {
  const f = await fixture();
  assert.equal((await f.POST(upload("task", png, { "Content-Type": "image/png" }, "project-1"))).status, 404);
  assert.equal((await f.POST(upload("routine", png, { "Content-Type": "image/png" }, "general"))).status, 404);
  assert.equal(f.objects.size, 0);
});
test("SVG, HTML, empty and mismatched files are rejected", async () => {
  for (const [body, type] of [["<svg></svg>", "image/svg+xml"], ["<script>bad()</script>", "image/png"], [new Uint8Array(), "image/png"], [png, "image/jpeg"]]) {
    const f = await fixture();
    assert.equal((await f.POST(upload("project", body, { "Content-Type": type }))).status, 400);
    assert.equal(f.objects.size, 0);
  }
});
test("image size is bounded even when Content-Length is omitted", async () => {
  const f = await fixture();
  assert.equal((await f.POST(upload("project", new Uint8Array(helpers.DOCUMENT_IMAGE_MAX_BYTES + 1)))).status, 413);
  assert.equal((await f.POST(upload("project", png, { "Content-Type": "image/png", "Content-Length": String(helpers.DOCUMENT_IMAGE_MAX_BYTES + 1) }))).status, 413);
  assert.equal(f.objects.size, 0);
});
test("deleted-during-upload target cleans only the newly uploaded object", async () => {
  const f = await fixture({ afterUpload: true });
  assert.equal((await f.POST(upload())).status, 404);
  assert.equal(f.deleted.length, 1);
  assert.match(f.deleted[0], /^document-images\/v1\/workspace\/project\/project-1\//);
  assert.equal(f.objects.size, 0);
});
test("private image reads verify target and storage ownership", async () => {
  const f = await fixture();
  const { url } = await (await f.POST(upload())).json();
  assert.equal((await f.GET(new Request(`https://okri.test${url.replace("project-1", "project-2")}`))).status, 404);
  const stored = [...f.objects.values()][0];
  stored.customMetadata.ownerId = "other";
  assert.equal((await f.GET(new Request(`https://okri.test${url}`))).status, 404);
});
test("viewers may read an existing image but cannot upload one", async () => {
  const owner = await fixture();
  const { url } = await (await owner.POST(upload())).json();
  const viewer = await fixture({ viewer: true });
  for (const [key, value] of owner.objects) viewer.objects.set(key, value);
  assert.equal((await viewer.GET(new Request(`https://okri.test${url}`))).status, 200);
  assert.equal((await viewer.POST(upload())).status, 403);
});
test("storage failures are recoverable and filenames cannot inject headers", async () => {
  const f = await fixture({ missingStorage: true });
  assert.equal((await f.POST(upload())).status, 503);
  assert.equal(helpers.safeDocumentImageName("../a\r\nB\\c.png"), "..-aB-c.png");
});
