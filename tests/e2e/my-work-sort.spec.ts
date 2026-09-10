import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { THEMES, THEME_STORAGE_KEY } from "../../lib/themes";

const now = "2026-09-02T09:00:00.000Z";
const longTitle = "아주 긴 업무 제목과 연결 정보가 있어도 기한과 우선순위는 끝까지 표시되어야 하는 업무";

function fixture(workspaceId = "sort-workspace", memberId = "sort-member") {
  const member = { id: memberId, email: "owner@example.com", displayName: "테스트 사용자", role: "owner", status: "active", isCurrent: true, createdAt: now };
  const item = (id: string, kind: string, dueDate: string | null, priority: string, overrides: Record<string, unknown> = {}) => ({
    id, kind, title: id, cycleId: "cycle-1", parentId: kind === "task" ? "Project later" : null, routineId: null,
    description: "", status: "todo", priority, cadence: "weekly", progress: 0, dueDate, source: "manual",
    archivedAt: null, archivedFromStatus: null, archiveRootId: null, sortOrder: 0, createdAt: now, updatedAt: now,
    assignments: [{ id: `${id}-assignment`, memberId, displayName: member.displayName, email: member.email, role: kind === "project" ? "project_dri" : "task_assignee" }], ...overrides,
  });
  return {
    user: { id: `user-${memberId}`, email: member.email, displayName: member.displayName, provider: "local" },
    workspaces: [{ id: workspaceId, name: "정렬 테스트", kind: "personal", personal: true, role: "owner", current: true, createdAt: now, deletionRequestedAt: null, scheduledDeletionAt: null }],
    team: { workspace: { id: workspaceId, name: "정렬 테스트", kind: "personal" }, currentRole: "owner", canManage: true, invitations: [], invitationEmailConfigured: false, members: [member] },
    rules: { workspaceId, captureInstruction: "", structureInstruction: "", routineInstruction: "", defaultPriority: "medium", defaultCadence: "weekly", reviewBeforeCreate: true, configured: true, updatedAt: now },
    cycles: [{ id: "cycle-1", name: "현재 주기", department: "", version: 1, startDate: "2026-07-01", endDate: "2026-12-31", status: "active", createdAt: now, updatedAt: now }],
    items: [
      item("Objective", "objective", null, "medium", { assignments: [] }),
      item("Project later", "project", "2026-09-10", "urgent"),
      item("Project earlier", "project", "2026-09-01", "low"),
      item("Task urgent", "task", null, "urgent"),
      item("Task later", "task", "2026-09-10", "high"),
      item("Task overdue", "task", "2026-09-01", "low"),
      item("Task today low", "task", "2026-09-02", "low"),
      item("Task today high", "task", "2026-09-02", "high"),
      item("Task stable A", "task", "2026-09-02", "medium"),
      item("Task stable B", "task", "2026-09-02", "medium"),
      item("Task long", "task", "2026-09-20", "low", { title: longTitle }),
      item("Task completed", "task", "2026-08-20", "urgent", { status: "done", progress: 100 }),
      item("Task archived", "task", "2026-08-01", "urgent", { archivedAt: now, status: "archived" }),
      item("Task unassigned", "task", "2026-08-01", "urgent", { assignments: [] }),
      item("Task other member", "task", "2026-08-01", "urgent", { assignments: [{ memberId: "someone-else", role: "task_assignee" }] }),
    ],
    properties: [], propertyValues: {}, hiddenByProject: {}, archivedProjects: [],
    routines: [{ id: "routine-1", title: "Daily routine", description: "", cadence: "daily", triggerPoint: "", actionPlace: "", actionSteps: "", systemKey: null, assigneeMemberId: memberId, active: true, completed: false, createdAt: now, updatedAt: now }],
  };
}

async function setup(page: Page) {
  let data = fixture();
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("okri.intro-language", "ko"));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(`${route.request().method()} ${path}`);
    const body = path === "/api/bootstrap" ? data
      : path === "/api/items" ? { items: data.items }
      : path === "/api/routines" ? { routines: data.routines }
      : path === "/api/team" ? data.team
      : path === "/api/checklists" ? { items: [{ id: "check-1", taskId: "Task today high", title: "Existing checklist", completed: true }] }
      : path === "/api/data-connections" ? { connections: [] }
      : path === "/api/project-templates" ? { templates: [] }
      : path === "/api/project-documents" ? { document: { id: "document-1", projectId: "Project earlier", content: JSON.stringify([{ type: "paragraph", content: "Existing project document" }]), plainText: "Existing project document", version: 1, updatedAt: now } }
      : path === "/api/account/marketing-consent" ? { consent: { marketingDataConsent: true, advertisingEmailConsent: true, needsReaffirmation: false, marketingEligible: true } }
      : {};
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return { requests, errors, setScope: (workspaceId: string, memberId: string) => { data = fixture(workspaceId, memberId); } };
}

const rows = (page: Page, kind: string) => page.locator(".my-work-section").filter({ has: page.locator("header b", { hasText: new RegExp(`^${kind}$`) }) }).locator(".my-work-item b");

test("sort controls and priority labels remain readable in every theme", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await setup(page);
  await page.goto("/?view=my_work");
  for (const theme of THEMES) {
    await page.evaluate(({ key, mode }) => localStorage.setItem(key, mode), { key: THEME_STORAGE_KEY, mode: theme.mode });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.mode);
    await page.getByRole("button", { name: "우선순위순", exact: true }).click();
    await expect(rows(page, "Task").first()).toHaveText("Task urgent");
    const workflowColors = await page.locator(".my-work-priority.priority-medium").first().evaluate((node) => {
      const probe = document.createElement("span");
      document.body.appendChild(probe);
      probe.style.color = "var(--accent-fg)";
      const accent = getComputedStyle(probe).color;
      probe.style.color = "var(--info-fg)";
      const info = getComputedStyle(probe).color;
      probe.remove();
      return { rendered: getComputedStyle(node).color, accent, info };
    });
    expect(workflowColors.rendered).toBe(workflowColors.accent);
    if (theme.mode === "gray") expect(workflowColors.rendered).not.toBe(workflowColors.info);
    const contrast = await new AxeBuilder({ page: page as never }).include(".my-work-view").withRules(["color-contrast"]).analyze();
    expect(contrast.violations, theme.mode).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), theme.mode).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`my-work-${theme.mode}.png`), fullPage: true });
  }
});

test("my work sorts instantly within Task and Project while preserving filters and details", async ({ page }) => {
  const { requests, errors } = await setup(page);
  await page.goto("/?view=my_work");
  const due = page.getByRole("button", { name: "기한순", exact: true });
  const priority = page.getByRole("button", { name: "우선순위순", exact: true });
  await expect(due).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page, "Task")).toHaveText(["Task overdue", "Task today high", "Task stable A", "Task stable B", "Task today low", "Task later", longTitle, "Task urgent"]);
  await expect(rows(page, "Project")).toHaveText(["Project earlier", "Project later"]);
  const before = requests.length;
  await priority.click();
  await expect(rows(page, "Task")).toHaveText(["Task urgent", "Task today high", "Task later", "Task stable A", "Task stable B", "Task overdue", "Task today low", longTitle]);
  await expect(rows(page, "Project")).toHaveText(["Project later", "Project earlier"]);
  expect(requests.length).toBe(before);
  await expect(page.locator(".my-work-routine b")).toHaveText(["Daily routine"]);
  await expect(page.locator(".my-work-priority").first()).toHaveText("긴급");
  await page.getByRole("checkbox", { name: "완료 포함" }).check();
  await expect(rows(page, "Task").first()).toHaveText("Task completed");
  await expect(page.locator(".my-work-item").filter({ hasText: /Task archived|Task unassigned|Task other member/ })).toHaveCount(0);
  await page.locator(".my-work-item").filter({ has: page.getByText("Task today high", { exact: true }) }).click();
  await expect(page).toHaveURL(/task=Task(?:%20|\+)today(?:%20|\+)high/);
  await expect(page.locator(".task-title-input")).toHaveValue("Task today high");
  await expect(page.locator(".checklist-row")).toContainText("Existing checklist");
  expect(errors).toEqual([]);
  await page.goto("/?view=my_work");
  await expect(priority).toHaveAttribute("aria-pressed", "true");
  await page.locator(".my-work-item").filter({ has: page.getByText("Project earlier", { exact: true }) }).click();
  await expect(page).toHaveURL(/project=Project(?:%20|\+)earlier/);
  await expect(page.locator(".project-title-input")).toHaveValue("Project earlier");
  await expect(page.locator(".project-document-section .bn-editor")).toContainText("Existing project document");
  expect(errors).toEqual([]);
});

test("sort preference survives navigation and reload and stays scoped to workspace and member", async ({ page }) => {
  const { setScope } = await setup(page);
  await page.goto("/?view=my_work");
  await page.getByRole("button", { name: "우선순위순", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "우선순위순", exact: true })).toHaveAttribute("aria-pressed", "true");
  setScope("different-workspace", "sort-member");
  await page.reload();
  await expect(page.getByRole("button", { name: "기한순", exact: true })).toHaveAttribute("aria-pressed", "true");
  setScope("sort-workspace", "different-member");
  await page.reload();
  await expect(page.getByRole("button", { name: "기한순", exact: true })).toHaveAttribute("aria-pressed", "true");
  setScope("sort-workspace", "sort-member");
  await page.reload();
  await expect(page.getByRole("button", { name: "우선순위순", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("storage failure does not prevent sorting and narrow screens retain date and priority", async ({ page }, testInfo) => {
  await setup(page);
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) { if (key.startsWith("okri.my-work-sort:")) throw new Error("Blocked"); return get.call(this, key); };
    Storage.prototype.setItem = function (key, value) { if (key.startsWith("okri.my-work-sort:")) throw new Error("Blocked"); return set.call(this, key, value); };
  });
  await page.goto("/?view=my_work");
  await page.getByRole("button", { name: "우선순위순", exact: true }).click();
  await expect(rows(page, "Task").first()).toHaveText("Task urgent");
  const row = page.locator(".my-work-item").filter({ hasText: longTitle });
  for (const selector of [".my-work-priority", ".my-work-due"]) {
    const element = row.locator(selector);
    await expect(element).toBeVisible();
    expect(await element.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    const outer = await row.boundingBox();
    const inner = await element.boundingBox();
    expect(inner!.x + inner!.width).toBeLessThanOrEqual(outer!.x + outer!.width);
  }
  const sortBox = await page.locator(".my-work-sort").boundingBox();
  const completedBox = await page.locator(".my-work-toolbar-actions label").boundingBox();
  expect(sortBox!.x + sortBox!.width <= completedBox!.x || sortBox!.y + sortBox!.height <= completedBox!.y).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("my-work.png"), fullPage: true });
});
