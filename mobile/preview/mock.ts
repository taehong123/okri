import { today, plusDays } from "../src/model";
import type { Bootstrap, Daily, Item, Session } from "../src/types";
export const previewSession: Session = { accessToken: "okri_native_preview_only", expiresAt: "2099-01-01T00:00:00Z", user: { id: "preview-user", email: "alex@example.test", displayName: "Alex Kim" } };
const member = { id: "preview-member", userId: "preview-user", displayName: "Alex Kim", email: "alex@example.test", status: "active", role: "owner" };
const params = new URL(location.href).searchParams;
const lang = params.get("lang") || "en";
const words: Record<string, string[]> = {
  ko: ["고객이 제품의 가치를 빠르게 경험하게 한다", "첫 주 활성화율 60% 달성", "첫 사용 경험 개선", "가입 흐름 개선", "고객 인터뷰 정리", "가입 실패 원인 분류", "첫 화면 안내 문구 검토", "고객 피드백 확인", "운영 점검", "결제 오류 점검"],
  en: ["Help customers experience value sooner", "Reach 60% first-week activation", "Improve the first-use experience", "Improve the signup journey", "Synthesize customer interviews", "Categorize signup failures", "Review the welcome screen copy", "Review customer feedback", "Operations review", "Check payment errors"],
  ja: ["顧客が製品の価値をすぐに実感できるようにする", "初週の利用開始率60%を達成", "初回利用体験を改善", "登録フローを改善", "顧客インタビューを整理", "登録失敗の原因を分類", "初回画面の案内文を確認", "顧客のフィードバックを確認", "運用点検", "決済エラーを確認"],
  zh: ["帮助客户更快体验产品价值", "首周激活率达到60%", "改善首次使用体验", "优化注册流程", "整理客户访谈", "归类注册失败原因", "审核欢迎页面文案", "查看客户反馈", "运营检查", "检查支付错误"],
  es: ["Ayudar a los clientes a descubrir el valor antes", "Alcanzar un 60% de activación la primera semana", "Mejorar la primera experiencia", "Mejorar el proceso de registro", "Resumir las entrevistas con clientes", "Clasificar los fallos de registro", "Revisar los textos de bienvenida", "Revisar comentarios de clientes", "Revisión operativa", "Revisar errores de pago"],
};
const w = words[lang] || words.en;
const item = (id: string, kind: Item["kind"], title: string, parentId: string | null, dueDate = plusDays(today(), 3)): Item => ({ id, kind, title, parentId, dueDate, description: "", routineId: null, cycleId: "cycle", status: "todo", priority: "medium", progress: kind === "key_result" ? 42 : 25, archivedAt: null, createdByUserId: member.userId, assignments: [{ memberId: member.id, displayName: member.displayName, role: kind === "project" ? "project_dri" : "task_assignee" }] });
const bootstrap: Bootstrap = {
  user: previewSession.user, workspaces: [{ id: "preview-workspace", name: "OKRI Studio", role: "owner" }], team: { workspace: { id: "preview-workspace", name: "OKRI Studio" }, members: [member], currentRole: "owner", canManage: true }, cycles: [{ id: "cycle", name: "Q3", status: "active" }],
  items: [item("o", "objective", w[0], null), item("kr", "key_result", w[1], "o"), item("i", "initiative", w[2], "kr"), item("p1", "project", w[3], "i", plusDays(today(), -2)), item("p2", "project", w[4], "i"), item("t1", "task", w[5], "p1", plusDays(today(), -1)), item("t2", "task", w[6], "p1"), { ...item("t3", "task", w[9], null), routineId: "r1" }],
  routines: [{ id: "r1", title: w[8], description: "", cadence: "daily", active: true, completed: false, systemKey: null, assigneeMemberId: member.id }],
};
let draft: Daily["draft"] = { yesterdayNote: "", todayNote: "", blockersNote: "", selectedTaskIds: [], selectedWorkIds: [], selectedYesterdayWorkIds: [], noPlannedTasks: false, skipReason: null, skipNote: "" };
let submitted: Daily["latestSubmission"] = null;
function dashboard(): Daily {
  const work: Daily["candidates"]["work"] = bootstrap.items.filter(i => i.kind === "project" || i.kind === "task").map(i => ({ id: i.id, key: i.kind + ":" + i.id, kind: i.kind as "project" | "task", title: i.title, status: i.status, dueDate: i.dueDate, parentId: i.routineId || i.parentId, parentKind: i.routineId ? "routine" : "project", parentTitle: bootstrap.items.find(p => p.id === i.parentId)?.title || bootstrap.routines.find(r => r.id === i.routineId)?.title || "" }));
  work.push({ key: "routine:r1", id: "r1", kind: "routine", title: w[8], status: "todo", dueDate: null, parentTitle: "" });
  return { date: today(), member, draft, latestSubmission: submitted, candidates: { work, yesterdayWork: work.filter(i => i.kind === "task") }, createTargets: { projects: bootstrap.items.filter(i => i.kind === "project"), routines: bootstrap.routines, allowGeneral: false } };
}
export const controls = { writes: [] as { path: string; method: string; body: any }[], failure: 0, delay: 0 };
export function installPreview() {
  localStorage.setItem("okri.native.language", lang); localStorage.setItem("okri.native.theme", params.get("theme") || "white");
  const network = globalThis.fetch;
  (globalThis as any).__OKRI_PREVIEW__ = controls;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.origin === location.origin) return network(input, init);
    // This entry is never part of a store build. All remote requests fail closed.
    if (url.origin !== "https://okri.ai") throw new Error("Remote requests are disabled in preview");
    const method = init?.method || "GET", body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method !== "GET") controls.writes.push({ path: url.pathname, method, body });
    if (controls.delay) await new Promise(resolve => setTimeout(resolve, controls.delay));
    if (controls.failure) { const status = controls.failure; controls.failure = 0; return Response.json({ error: "Mock failure" }, { status }); }
    if (method === "GET" && url.pathname === "/api/mobile/v1/bootstrap") return Response.json(bootstrap);
    if (url.pathname === "/api/mobile/v1/daily-scrum") {
      if (method === "PUT") draft = body;
      return Response.json(dashboard());
    }
    if (url.pathname === "/api/mobile/v1/daily-scrum/submit") { submitted = { id: body.requestId, submittedAt: new Date().toISOString() }; return Response.json({ submitted: true }); }
    if (url.pathname === "/api/mobile/v1/daily-scrum/tasks") {
      const existing = bootstrap.items.find(i => i.id === body.requestId);
      const task = existing || { ...item(body.requestId, "task", body.title, body.parentKind === "project" ? body.parentId : null), routineId: body.parentKind === "routine" ? body.parentId : null };
      if (!existing) bootstrap.items.push(task);
      return Response.json({ task });
    }
    if (url.pathname === "/api/mobile/v1/items") {
      if (method === "PATCH") { const existing = bootstrap.items.find(i => i.id === body.id); if (existing) Object.assign(existing, body); return Response.json({ item: existing }); }
      const created = { ...item("new-" + bootstrap.items.length, body.kind, body.title, body.parentId), ...body };
      bootstrap.items.push(created); return Response.json({ item: created });
    }
    if (url.pathname === "/api/mobile/v1/routine-completions") { const routine = bootstrap.routines.find(r => r.id === body.routineId); if (routine) routine.completed = body.completed; return Response.json({ routine }); }
    if (url.pathname === "/api/native/apple") return Response.json({ enabled: false });
    if (url.pathname === "/api/mobile/v1/workspaces" || url.pathname === "/api/native/session") return Response.json({ ok: true });
    return Response.json({ error: "Unmocked preview request" }, { status: 501 });
  };
}
