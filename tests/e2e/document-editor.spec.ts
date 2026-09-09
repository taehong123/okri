import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { installApiMocks, json } from "./api-mocks";

const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const imageFile = { name: "한글 image 2026.png", mimeType: "image/png", buffer: imageBytes };
const imageId = "11111111-1111-4111-8111-111111111111";

async function fixture(page: Page, viewer = false) {
  await installApiMocks(page, { withRoutine: true, workspaceRole: viewer ? "viewer" : "owner" });
  const documents = new Map<string, { content: string; plainText: string; version: number }>();
  const uploads: { kind: string; targetId: string; size: number }[] = [];
  const controls = { failUpload: false, failSave: false, uploadGate: null as Promise<void> | null };
  await page.route("**/api/document-images?**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") return route.fulfill({ status: 200, contentType: "image/png", body: imageBytes });
    uploads.push({ kind: url.searchParams.get("targetKind")!, targetId: url.searchParams.get("targetId")!, size: request.postDataBuffer()?.length ?? 0 });
    if (controls.uploadGate) await controls.uploadGate;
    if (controls.failUpload) return json(route, { code: "upload_failed" }, 500);
    url.searchParams.delete("name");
    url.searchParams.set("imageId", imageId);
    return json(route, { url: url.pathname + url.search }, 201);
  });
  await page.route(/\/api\/(?:project-documents|work-documents)(?:\?|$)/, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const data = request.method() === "GET" ? null : request.postDataJSON();
    const kind = url.pathname.includes("project-documents") ? "project" : data?.targetKind ?? url.searchParams.get("targetKind");
    const id = data?.projectId ?? data?.targetId ?? url.searchParams.get("projectId") ?? url.searchParams.get("targetId");
    const key = `${kind}:${id}`;
    let document = documents.get(key) ?? { content: JSON.stringify([{ type: "paragraph", content: "문서 본문 Text 2026" }]), plainText: "문서 본문 Text 2026", version: 1 };
    if (request.method() === "PUT") {
      if (controls.failSave) return json(route, { error: "save failed" }, 500);
      expect(data.expectedVersion).toBe(document.version);
      document = { content: data.content, plainText: data.plainText, version: document.version + 1 };
    } else if (request.method() === "POST") {
      document = { content: JSON.stringify([{ type: "heading", props: { level: 2 }, content: "템플릿 제목" }, ...JSON.parse(document.content)]), plainText: `템플릿 제목\n${document.plainText}`, version: document.version + 1 };
    }
    documents.set(key, document);
    return json(route, { document: { ...document, id: `doc-${id}`, projectId: id, targetKind: kind, targetId: id, updatedAt: "2026-09-09T00:00:00.000Z" } });
  });
  await page.route("**/api/project-templates", route => json(route, { templates: [{ id: "template-1", name: "회의 기록 Meeting notes 2026", content: "[]", plainText: "", description: "", createdAt: "2026-09-09", updatedAt: "2026-09-09" }] }));
  return { documents, uploads, controls };
}
async function openDocument(page: Page, kind: string) {
  await page.goto(kind === "project" ? "/?view=work&project=project-1" : kind === "task" ? "/?view=inbox&task=task-1" : "/?view=routines");
  if (kind === "routine") await page.locator(".routine-expand").click();
  const section = page.locator(".project-document-section");
  await expect(section.locator(".bn-editor")).toBeVisible();
  return section;
}

test("all work documents upload, save and reload inline images without showing tools in read mode", async ({ page }, info) => {
  test.setTimeout(120_000);
  const state = await fixture(page);
  for (const kind of ["project", "task", "routine"]) {
    let section = await openDocument(page, kind);
    await expect(section.locator(".document-format-toolbar")).toHaveCount(0);
    await section.getByRole("button", { name: "변경", exact: true }).click();
    await expect(section.getByRole("group", { name: "문서 서식" })).toBeVisible();
    await section.locator('input[type="file"]').setInputFiles(imageFile);
    await expect(section.locator(".bn-editor img")).toBeVisible();
    expect(await section.evaluate(node => node.getBoundingClientRect().right)).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
    expect(await section.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    expect(await section.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await page.evaluate(() => document.documentElement.style.fontSize = "100%");
    await expect.poll(() => JSON.parse(state.documents.get(`${kind}:${kind}-1`)!.content).some((block: { type: string }) => block.type === "image")).toBe(true);
    expect(state.uploads.at(-1)).toEqual({ kind, targetId: `${kind}-1`, size: imageBytes.length });
    await section.getByRole("button", { name: "닫기", exact: true }).click({ timeout: 8_000 });
    await expect(section.locator(".document-format-toolbar")).toHaveCount(0);
    section = await openDocument(page, kind);
    await expect(section.locator(".bn-editor img")).toBeVisible();
    expect(await section.locator(".bn-editor img").evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath(`${kind}-image.png`) });
  }
});

test("template actions stay compact and typing retains focus, formatting and undo after autosave", async ({ page }, info) => {
  const state = await fixture(page);
  const section = await openDocument(page, "project");
  await section.getByRole("button", { name: "변경", exact: true }).click();
  const tools = section.locator(".document-template-tools");
  const changeSize = await section.locator(":scope > header > button").boundingBox();
  for (const element of await tools.locator("button, select").all()) {
    const size = await element.boundingBox();
    expect(Math.abs(size!.height - changeSize!.height)).toBeLessThanOrEqual(1);
  }
  const editor = section.locator('.bn-editor[contenteditable="true"]');
  await editor.fill("서식과 저장 확인 2026");
  await editor.press("ControlOrMeta+a");
  await section.getByRole("button", { name: "진하게", exact: true }).click();
  await expect(editor.locator("strong")).toContainText("서식과 저장 확인 2026");
  await expect.poll(() => state.documents.get("project:project-1")!.content.includes('"bold":true')).toBe(true);
  await expect(editor).toBeFocused();
  await editor.press("End");
  await editor.pressSequentially(" next");
  await expect.poll(() => state.documents.get("project:project-1")!.plainText.endsWith(" next")).toBe(true);
  await editor.press("ControlOrMeta+z");
  await expect(editor).not.toContainText(" next");
  await tools.getByRole("combobox").selectOption("template-1");
  await expect(tools.getByRole("button", { name: "불러오기", exact: true })).toBeEnabled();
  await tools.getByRole("button", { name: "불러오기", exact: true }).click();
  await expect(editor).toContainText("템플릿 제목");
  await expect(editor).toContainText("서식과 저장 확인 2026");
  await page.screenshot({ path: info.outputPath("editor-tools.png") });
});

test("failed and invalid uploads preserve text; pending image upload prevents closing", async ({ page }) => {
  const state = await fixture(page);
  const section = await openDocument(page, "task");
  await section.getByRole("button", { name: "변경", exact: true }).click();
  await section.locator('input[type="file"]').setInputFiles({ name: "bad.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
  await expect(section.getByRole("alert")).toContainText("5MB");
  expect(state.uploads).toHaveLength(0);
  state.controls.failUpload = true;
  await section.locator('input[type="file"]').setInputFiles(imageFile);
  await expect(section.getByRole("alert")).toContainText("이미지를 저장하지 못했습니다.");
  await expect(section.locator(".bn-editor")).toContainText("문서 본문 Text 2026");
  state.controls.failUpload = false;
  let release!: () => void;
  state.controls.uploadGate = new Promise<void>(resolve => { release = resolve; });
  await section.locator('input[type="file"]').setInputFiles(imageFile);
  await expect(section.getByRole("button", { name: "닫기", exact: true })).toBeDisabled();
  release();
  await expect(section.locator(".bn-editor img")).toBeVisible();
  await expect(section.getByRole("button", { name: "닫기", exact: true })).toBeEnabled();
});

test("closing immediately flushes text and failed document save has an explicit retry", async ({ page }) => {
  const state = await fixture(page);
  const section = await openDocument(page, "project");
  await section.getByRole("button", { name: "변경", exact: true }).click();
  state.controls.failSave = true;
  await section.locator('.bn-editor[contenteditable="true"]').fill("마지막 입력은 남아 있어야 합니다");
  await section.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(section.locator(".document-save-error")).toBeVisible();
  await expect(section.locator(".bn-editor")).toContainText("마지막 입력은 남아 있어야 합니다");
  state.controls.failSave = false;
  await section.getByRole("button", { name: "재시도", exact: true }).click();
  await expect.poll(() => state.documents.get("project:project-1")!.plainText).toBe("마지막 입력은 남아 있어야 합니다");
});

test("document editor tools fit narrow and zoomed views with all theme contrasts", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  test.setTimeout(120_000);
  await fixture(page);
  const section = await openDocument(page, "project");
  await section.getByRole("button", { name: "변경", exact: true }).click();
  for (const width of [320, 390, 768, 1440, 1920, 2560, 3840]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const size of ["100%", "200%"]) {
      await page.evaluate(size => document.documentElement.style.fontSize = size, size);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      for (const tools of [section.locator(".document-format-toolbar"), section.locator(".document-template-tools")]) {
        expect(await tools.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      }
    }
  }
  await page.evaluate(() => document.documentElement.style.fontSize = "100%");
  for (const theme of ["white", "beige", "gray", "dark", "neon", "cyberpunk"]) {
    await page.locator("html").evaluate((node, theme) => node.dataset.theme = theme, theme);
    expect((await new AxeBuilder({ page: page as never }).include(".project-document-section").withRules(["color-contrast"]).analyze()).violations, theme).toEqual([]);
  }
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  for (const selector of [".document-image-button", ".project-document-section .bn-inline-content"]) {
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.every(font => font.isCustomFont && /Pretendard/.test(font.familyName)), JSON.stringify({ selector, fonts })).toBe(true);
  }
  await cdp.detach();
});

test("viewers do not get document formatting or upload controls", async ({ page }) => {
  const state = await fixture(page, true);
  for (const kind of ["project", "task", "routine"]) {
    const section = await openDocument(page, kind);
    await expect(section.locator(".document-format-toolbar, input[type=file], [contenteditable=true]")).toHaveCount(0);
  }
  expect(state.uploads).toEqual([]);
});

test("keyboard formatting and pasted images use the same document flow", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  const state = await fixture(page);
  const section = await openDocument(page, "task");
  await section.getByRole("button", { name: "변경", exact: true }).click();
  const editor = section.locator('.bn-editor[contenteditable="true"]');
  await editor.fill("키보드 편집");
  await expect.poll(() => state.documents.get("task:task-1")!.plainText).toBe("키보드 편집");
  await editor.press("ControlOrMeta+a");
  await editor.press("ControlOrMeta+b");
  await expect(editor.locator("strong")).toContainText("키보드 편집");
  await editor.press("ArrowRight");
  await editor.evaluate((node, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" }));
    node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, [...imageBytes]);
  await expect(section.locator(".bn-editor img")).toBeVisible();
  await expect.poll(() => state.uploads.length).toBe(1);
  const toolbarButton = section.getByRole("button", { name: "이미지 첨부", exact: true });
  await toolbarButton.focus();
  await page.keyboard.press("Tab");
  await expect(editor).toBeFocused();
});
