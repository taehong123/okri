import type { Page, Route } from "@playwright/test";

const now = "2026-08-29T09:00:00.000Z";
const baseItem = {
  cycleId: "cycle-1",
  routineId: null,
  description: "",
  status: "in_progress",
  priority: "high",
  cadence: "weekly",
  progress: 40,
  dueDate: "2026-09-03",
  source: "manual",
  archivedAt: null,
  archivedFromStatus: null,
  archiveRootId: null,
  assignments: [],
  createdAt: now,
  updatedAt: now,
};

const generalRoutine = {
  id: "routine-general",
  title: "General",
  description: "",
  cadence: "daily",
  triggerPoint: "",
  actionPlace: "",
  actionSteps: "",
  systemKey: "general",
  assigneeMemberId: null,
  active: true,
  completed: false,
  createdAt: now,
  updatedAt: now,
};

const bootstrap = {
  user: { id: "user-1", email: "owner@example.com", displayName: "테스트 사용자", provider: "local" },
  workspaces: [{
    id: "workspace-1",
    name: "테스트 워크스페이스",
    createdAt: now,
    kind: "personal",
    personal: true,
    role: "owner",
    current: true,
    deletionRequestedAt: null,
    scheduledDeletionAt: null,
  }],
  rules: {
    workspaceId: "workspace-1",
    captureInstruction: "",
    structureInstruction: "",
    routineInstruction: "",
    defaultPriority: "medium",
    defaultCadence: "weekly",
    reviewBeforeCreate: true,
    configured: true,
    updatedAt: now,
  },
  cycles: [{
    id: "cycle-1",
    name: "2026 하반기",
    department: "",
    version: 1,
    startDate: "2026-07-01",
    endDate: "2026-12-31",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }],
  team: {
    workspace: { id: "workspace-1", name: "테스트 워크스페이스", kind: "personal" },
    currentRole: "owner",
    canManage: true,
    invitations: [],
    invitationEmailConfigured: false,
    members: [{
      id: "member-1",
      email: "owner@example.com",
      displayName: "테스트 사용자",
      role: "owner",
      status: "active",
      isCurrent: true,
      createdAt: now,
    }],
  },
  items: [
    { ...baseItem, id: "objective-1", parentId: null, kind: "objective", title: "고객 경험 개선", progress: 50 },
    { ...baseItem, id: "kr-1", parentId: "objective-1", kind: "key_result", title: "활성 사용자 20% 증가", progress: 45 },
    { ...baseItem, id: "initiative-1", parentId: "kr-1", kind: "initiative", title: "핵심 흐름 개편", progress: 40 },
    { ...baseItem, id: "project-1", parentId: "initiative-1", kind: "project", title: "모바일 사용성 개선", assignments: [{ id: "assignment-1", memberId: "member-1", displayName: "테스트 사용자", email: "owner@example.com", role: "project_dri" }] },
    { ...baseItem, id: "task-1", parentId: "project-1", kind: "task", title: "오버레이 동작 점검", status: "todo", progress: 0, assignments: [{ id: "assignment-2", memberId: "member-1", displayName: "테스트 사용자", email: "owner@example.com", role: "task_assignee" }] },
    { ...baseItem, id: "initiative-2", parentId: "kr-1", kind: "initiative", title: "후속 실행 방향", progress: 0 },
  ],
  properties: [],
  propertyValues: {},
  hiddenByProject: {},
  archivedProjects: [],
  routines: [generalRoutine],
};

export async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

export async function installApiMocks(page: Page, options: { failItemCreate?: boolean; withoutTaskContainers?: boolean; slowRoutineRefresh?: boolean; skippedTeam?: boolean; slackState?: "service_unavailable" | "workspace_disconnected" | "setup_required" | "connected" | "reauthorization_required"; slackSetupComplete?: boolean; workspaceRole?: "owner" | "member" | "viewer"; teamWorkspace?: boolean } = {}) {
  let krDataConnections: Array<Record<string, unknown>> = [];
  let slackSetupComplete = options.slackSetupComplete ?? true;
  let slackAutomations: Array<Record<string, unknown>> = [];
  let managementBotSettings = { enabled: false, weekdays: [1, 2, 3, 4, 5], reportTime: "09:00", timezone: "Asia/Seoul", channelId: "", channelName: "", signals: ["missing_due_date", "missing_owner", "overdue", "completed_yesterday", "due_today"], lastSentDate: null, lastSentAt: null, lastError: "", updatedAt: now };
  const assistantDrafts = new Map<string, unknown>();
  const baseBootstrapResponse = options.withoutTaskContainers
    ? { ...bootstrap, items: bootstrap.items.filter((entry) => entry.kind !== "project" && entry.kind !== "task") }
    : bootstrap;
  const workspaceRole = options.workspaceRole ?? "owner";
  const workspaceKind = options.teamWorkspace ? "team" : "personal";
  const bootstrapResponse = {
    ...baseBootstrapResponse,
    workspaces: baseBootstrapResponse.workspaces.map((workspace) => ({ ...workspace, kind: workspaceKind, personal: workspaceKind === "personal", role: workspaceRole })),
    team: { ...baseBootstrapResponse.team, workspace: { ...baseBootstrapResponse.team.workspace, kind: workspaceKind }, currentRole: workspaceRole, canManage: workspaceRole === "owner", members: baseBootstrapResponse.team.members.map((member) => ({ ...member, role: workspaceRole })) },
  };
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("okri.intro-language", "ko");
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/bootstrap") return json(route, bootstrapResponse);
    if (url.pathname === "/api/billing/status") return json(route, {
      plan: "free", planLabel: "Free", status: "free", nextPlan: null,
      trialEndsAt: null, currentPeriodEndsAt: null, nextBillingAt: null,
      cancelAtPeriodEnd: false, graceEndsAt: null,
      usage: {
        projects: { used: 4, limit: 10, remaining: 6, resetsAt: "2026-09-30T15:00:00.000Z" },
        editors: { used: 1, limit: 3, remaining: 2 },
        ai: { usedWon: 120, limitWon: 500, remainingWon: 380, resetsAt: "2026-09-30T15:00:00.000Z" },
      },
      editorMembers: [{ id: "member-1", displayName: "테스트 사용자", email: "owner@example.com", role: workspaceRole, selected: true, writeAllowed: true }],
      paymentMethod: null, transactions: [], canManage: workspaceRole === "owner",
      enforcementEnabled: false, checkoutAvailable: false,
    });
    if (url.pathname === "/api/assistant-drafts") {
      const key = url.searchParams.get("key") ?? "";
      if (request.method() === "GET") return json(route, { draft: assistantDrafts.has(key) ? { payload: assistantDrafts.get(key), updatedAt: now } : null });
      if (request.method() === "PUT") {
        assistantDrafts.set(key, (request.postDataJSON() as { payload: unknown }).payload);
        return json(route, { updatedAt: now });
      }
      assistantDrafts.delete(key);
      return json(route, { deleted: true });
    }
    if (url.pathname === "/api/okr-files/cycle-1" || url.pathname === "/api/okr-files" && request.method() === "POST") {
      const objective = bootstrapResponse.items.find((entry) => entry.id === "objective-1")!;
      const keyResult = bootstrapResponse.items.find((entry) => entry.id === "kr-1")!;
      const initiatives = bootstrapResponse.items.filter((entry) => entry.kind === "initiative");
      const project = bootstrapResponse.items.find((entry) => entry.id === "project-1")!;
      return json(route, { file: {
        cycle: url.pathname === "/api/okr-files" ? { ...bootstrapResponse.cycles[0], id: "cycle-new", name: "새 통합 OKR" } : bootstrapResponse.cycles[0],
        revision: request.method() === "GET" ? "test-revision" : "saved-revision",
        objectiveCount: 1,
        needsSplit: false,
        initiativeOptions: [],
        objective: {
          id: objective.id,
          clientId: objective.id,
          title: objective.title,
          status: objective.status,
          keyResults: [{
            id: keyResult.id,
            clientId: keyResult.id,
            title: keyResult.title,
            status: keyResult.status,
            progress: keyResult.progress,
            initiatives: initiatives.map((initiative) => ({
              id: initiative.id,
              clientId: initiative.id,
              title: initiative.title,
              status: initiative.status,
              linkedProjects: initiative.id === "initiative-1" ? [{
                id: project.id,
                title: project.title,
                parentId: initiative.id,
                cycleId: project.cycleId,
                taskCount: 1,
                canTrash: true,
                updatedAt: project.updatedAt,
              }] : [],
            })),
          }],
        },
      } });
    }
    if (url.pathname === "/api/invitations/preview") return json(route, { invitation: {
      workspace: { id: "workspace-invited", name: "초대받은 워크스페이스" },
      role: "member",
      inviterName: "관리자",
      emailHint: "ow***@example.com",
      status: "pending",
      expiresAt: "2026-09-30T00:00:00.000Z",
    } });
    if (url.pathname === "/api/invitations/accept") return json(route, { accepted: true, workspaceId: "workspace-invited", workspaceName: "초대받은 워크스페이스" });
    if (url.pathname === "/api/google/status") return json(route, { google: { configured: true, connected: false, email: null, displayName: null, scope: "", connectedAt: null, updatedAt: null } });
    if (url.pathname === "/api/slack/status") {
      const state = options.slackState ?? "workspace_disconnected";
      const connected = state === "setup_required" || state === "connected" || state === "reauthorization_required";
      return json(route, { slack: {
        connected, state,
        statusMessage: state === "service_unavailable" ? "Slack 연결을 잠시 사용할 수 없습니다. 서비스가 준비되면 이 화면에서 바로 연결할 수 있습니다." : state === "workspace_disconnected" ? "Owner 또는 Admin이 이 OKRI 워크스페이스에 사용할 Slack을 직접 선택하고 승인할 수 있습니다." : state === "reauthorization_required" ? "새 데일리 기능에 필요한 Slack 권한을 다시 승인해 주세요." : state === "setup_required" ? "고객 Slack A 연결을 마쳤습니다. 데일리 발송 설정을 완료해 주세요." : "고객 Slack A와 연결되어 데일리 알림을 설정할 수 있습니다.",
        missingScopes: state === "reauthorization_required" ? ["im:write"] : [], teamName: connected ? "테스트 Slack" : null, teamId: connected ? "T123" : null, botUserId: connected ? "U-BOT" : null, scope: connected ? "commands,chat:write,im:write,im:history,users:read,users:read.email,channels:read,groups:read,channels:history,groups:history,app_mentions:read,files:read" : "", connectedAt: connected ? now : null, updatedAt: connected ? now : null,
        connectionScope: "workspace", distributionMode: "direct_oauth", connectedTeam: connected ? { id: "T123", name: "고객 Slack A" } : null,
        redirectUrl: "https://okri.ai/api/slack/callback", commandUrl: "https://okri.ai/api/slack/commands", interactionUrl: "https://okri.ai/api/slack/interactions", eventsUrl: "https://okri.ai/api/slack/events",
      } });
    }
    if (url.pathname === "/api/slack/daily/preferences") return json(route, { linked: true, enabled: true, reminderTime: "09:00", timezone: "Asia/Seoul", usesWorkspaceTime: true, usesWorkspaceTimezone: true });
    const slackAdmin = () => ({
      connected: true, teamName: "테스트 Slack", needsReauthorization: false, setupComplete: slackSetupComplete,
      settings: { enabled: slackSetupComplete, weekdays: [1, 2, 3, 4, 5], reminderTime: "09:00", timezone: "Asia/Seoul", installStatus: "connected", onboardingCompletedAt: slackSetupComplete ? now : null, lastSyncedAt: now, lastError: "" },
      channels: slackSetupComplete ? [{ id: "C123", name: "daily", isPrivate: false, isMember: true }] : [],
      members: [{ memberId: "member-1", displayName: "테스트 사용자", email: "owner@example.com", linked: true, slackDisplayName: "test-owner", preference: { enabled: true, reminderTime: null, timezone: null }, reminder: slackSetupComplete ? { status: "scheduled", postAt: 1788120000, error: "" } : null }],
      failedPublications: [],
    });
    if (url.pathname === "/api/slack/onboarding") {
      slackSetupComplete = true;
      return json(route, { setupComplete: true, admin: slackAdmin(), tests: { dm: { status: "sent", memberId: "member-1" }, channels: [{ channelId: "C123", channelName: "daily", status: "sent" }] }, schedules: [{ memberId: "member-1", status: "scheduled", postAt: 1788120000 }] });
    }
    if (url.pathname === "/api/slack/daily/settings") return json(route, slackAdmin());
    if (url.pathname === "/api/slack/channels") return json(route, { channels: [{ id: "C123", name: "daily", isPrivate: false, isMember: false }] });
    if (url.pathname === "/api/slack/automations") {
      if (request.method() === "POST") {
        const payload = request.postDataJSON() as Record<string, unknown>;
        const automation = { id: `automation-${slackAutomations.length + 1}`, ...payload, lastTriggeredAt: null, lastDeliveryStatus: "never", lastError: "", createdAt: now, updatedAt: now };
        slackAutomations = [automation, ...slackAutomations];
        return json(route, { automation }, 201);
      }
      return json(route, { automations: slackAutomations, deliveries: [] });
    }
    if (url.pathname === "/api/groups" && request.method() === "GET") return json(route, { groups: [] });
    if (url.pathname === "/api/workspace-management-bot") {
      const snapshot = { date: "2026-09-01", totalCount: 8, groups: [
        { signal: "missing_due_date", count: 2, items: [], projects: [{ project: { id: "project-1", title: "모바일 사용성 개선", status: "in_progress", dueDate: null, isOverdue: false }, projectMatchesSignal: true, tasks: [] }] },
        { signal: "missing_owner", count: 1, items: [], projects: [{ project: { id: "project-1", title: "모바일 사용성 개선", status: "in_progress", dueDate: null, isOverdue: false }, projectMatchesSignal: false, tasks: [{ id: "task-1", kind: "task", title: "오버레이 동작 점검", status: "todo", dueDate: null, isOverdue: false, parentProject: null }] }] },
        { signal: "overdue", count: 2, items: [], projects: [{ project: { id: "project-overdue", title: "출시 준비", status: "in_progress", dueDate: "2026-08-30", isOverdue: true }, projectMatchesSignal: true, tasks: [{ id: "task-overdue", kind: "task", title: "지난 기한 Task", status: "in_progress", dueDate: "2026-08-31", isOverdue: true, parentProject: null }] }] },
        { signal: "completed_yesterday", count: 1, items: [], projects: [{ project: { id: "project-1", title: "모바일 사용성 개선", status: "in_progress", dueDate: null, isOverdue: false }, projectMatchesSignal: false, tasks: [{ id: "task-done", kind: "task", title: "어제 완료 Task", status: "done", dueDate: "2026-08-31", isOverdue: false, parentProject: null }] }] },
        { signal: "due_today", count: 2, items: [], projects: [{ project: { id: "project-1", title: "모바일 사용성 개선", status: "in_progress", dueDate: null, isOverdue: false }, projectMatchesSignal: false, tasks: [{ id: "task-today", kind: "task", title: "오늘 마감 Task", status: "todo", dueDate: "2026-09-01", isOverdue: false, parentProject: null }] }] },
      ] };
      if (request.method() === "GET") return json(route, { settings: managementBotSettings, snapshot, slackConnected: options.slackState === "connected", channels: [{ id: "C123", name: "daily", isPrivate: false, isMember: true }] });
      const payload = request.postDataJSON() as Record<string, unknown>;
      if (payload.action === "test") return json(route, { sent: true, snapshot });
      managementBotSettings = { ...managementBotSettings, ...payload, channelName: payload.channelId === "C123" ? "daily" : managementBotSettings.channelName, updatedAt: now } as typeof managementBotSettings;
      return json(route, { settings: managementBotSettings, snapshot, slackConnected: true, channels: [{ id: "C123", name: "daily", isPrivate: false, isMember: true }] });
    }
    if (url.pathname === "/api/data-connections/sync" && request.method() === "POST") {
      const payload = request.postDataJSON() as { id: string };
      const connection = krDataConnections.find((entry) => entry.id === payload.id);
      if (!connection) return json(route, { error: "not found" }, 400);
      const progress = connection.targetKind === "project" ? 35 : 60;
      const updated = { ...connection, lastValue: progress, lastSyncStatus: "success", lastSyncedAt: now, nextSyncAt: now };
      krDataConnections = krDataConnections.map((entry) => entry.id === payload.id ? updated : entry);
      return json(route, { connection: updated, progress, value: progress });
    }
    if (url.pathname === "/api/data-connections") {
      if (request.method() === "GET") {
        const itemId = url.searchParams.get("itemId");
        return json(route, { connections: itemId ? krDataConnections.filter((entry) => entry.itemId === itemId) : krDataConnections });
      }
      if (request.method() === "POST") {
        const payload = request.postDataJSON() as Record<string, unknown>;
        const connection = { id: `connection-${String(payload.itemId)}`, ...payload, lastValue: null, lastSyncStatus: "never", lastError: "", lastSyncedAt: null, nextSyncAt: now, createdAt: now, updatedAt: now };
        krDataConnections.push(connection);
        return json(route, { connection }, 201);
      }
      if (request.method() === "DELETE") {
        krDataConnections = krDataConnections.filter((entry) => entry.id !== url.searchParams.get("id"));
        return json(route, { deleted: true });
      }
    }
    if (url.pathname === "/api/okr-organize" && request.method() === "POST") {
      const requestPayload = request.postDataJSON() as { mode?: string };
      const projectMode = requestPayload.mode === "project";
      return json(route, {
        organized: {
          assistantMessage: projectMode ? "말씀하신 Project를 정리했습니다." : "말씀하신 Task를 정리했습니다.",
          questions: [],
          plan: {
            objectiveTitle: "",
            keyResults: [],
            targetInitiatives: [],
            unassignedInitiatives: [],
            project: projectMode ? "셀러 쇼핑몰 전체 오더 플로우 안정화 개발" : "",
            tasks: projectMode ? "" : "AI로 정리된 Task",
            taskParent: "",
            routineTitle: "",
            routineTrigger: "",
            routinePlace: "",
            routineSteps: "",
            routineCadence: "daily",
          },
        },
      });
    }
    if (url.pathname === "/api/items" && request.method() === "POST" && options.failItemCreate) {
      return json(route, { error: "서버 저장 실패" }, 500);
    }
    if (url.pathname === "/api/project-documents") {
      return json(route, { document: { id: "document-1", projectId: "project-1", content: "[]", plainText: "", version: 1, updatedAt: now } });
    }
    if (url.pathname === "/api/project-templates") return json(route, { templates: [] });
    if (url.pathname === "/api/checklists") return json(route, { items: [] });
    if (url.pathname === "/api/recommendations") return json(route, { recommendations: [] });
    if (url.pathname === "/api/daily-scrum" && request.method() === "GET") return json(route, {
      date: "2026-08-30",
      member: { id: "member-1", displayName: "테스트 사용자", email: "owner@example.com", role: "owner" },
      draft: { id: "draft-1", date: "2026-08-30", yesterdayNote: "", todayNote: "", blockersNote: "", noPlannedTasks: false, skipReason: null, skipNote: "", selectedTaskIds: [], source: "web", updatedAt: now },
      latestSubmission: null,
      candidates: { tasks: [{ id: "task-1", title: "오버레이 동작 점검", status: "todo", dueDate: "2026-09-03", parentKind: "project", parentId: "project-1", parentTitle: "모바일 사용성 개선" }], groups: [{ key: "project:project-1", kind: "project", id: "project-1", title: "모바일 사용성 개선", tasks: [{ id: "task-1", title: "오버레이 동작 점검", status: "todo", dueDate: "2026-09-03", parentKind: "project", parentId: "project-1", parentTitle: "모바일 사용성 개선" }] }] },
      createTargets: { projects: [{ id: "project-empty", title: "실행 항목 없는 Project", needsTask: true }], routines: [], allowGeneral: false },
      team: [
        { memberId: "member-1", displayName: "테스트 사용자", email: "owner@example.com", role: "owner", status: "missing", slackConnected: true, submission: null },
        options.skippedTeam
          ? { memberId: "member-2", displayName: "휴가 멤버", email: "leave@example.com", role: "member", status: "skipped", slackConnected: true, submission: { id: "submission-skip", memberId: "member-2", memberName: "휴가 멤버", memberEmail: "leave@example.com", date: "2026-08-30", version: 1, yesterdayNote: "", todayNote: "", blockersNote: "", noPlannedTasks: false, skipReason: "personal", skipNote: "병원 일정", source: "web", submittedAt: now, tasks: [] } }
          : { memberId: "member-2", displayName: "초안 멤버", email: "draft@example.com", role: "member", status: "writing", slackConnected: false, submission: null },
      ],
      legacyWorkspaceNote: { yesterdayNote: "", todayNote: "기존 공용 메모", blockersNote: "", updatedAt: now },
    });
    if (url.pathname === "/api/daily-scrum" && request.method() === "PUT") {
      const payload = request.postDataJSON() as Record<string, unknown>;
      return json(route, {
        date: payload.date,
        member: { id: "member-1", displayName: "테스트 사용자", email: "owner@example.com", role: "owner" },
        draft: { id: "draft-1", date: payload.date, yesterdayNote: payload.yesterdayNote, todayNote: payload.todayNote, blockersNote: payload.blockersNote, noPlannedTasks: payload.noPlannedTasks, skipReason: payload.skipReason, skipNote: payload.skipNote, selectedTaskIds: payload.selectedTaskIds, source: "web", updatedAt: now },
        latestSubmission: null, candidates: { tasks: [], groups: [] }, createTargets: { projects: [], routines: [], allowGeneral: true }, team: [], legacyWorkspaceNote: null,
      });
    }
    if (url.pathname === "/api/daily-scrum/submit") return json(route, { submission: { id: "submission-1" } }, 201);
    if (url.pathname === "/api/daily-scrum/tasks") return json(route, { task: { ...baseItem, id: "new-task", parentId: "project-empty", kind: "task", title: "새 실행 Task" } }, 201);
    if (url.pathname === "/api/routines" && request.method() === "GET") {
      if (options.slowRoutineRefresh) await new Promise((resolve) => setTimeout(resolve, 800));
      return json(route, { routines: bootstrapResponse.routines });
    }
    if (url.pathname === "/api/trash") return json(route, { items: [], cleanupRecords: [] });
    return json(route, {});
  });
}
