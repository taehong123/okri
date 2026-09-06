import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const projectRoot = new URL("../", import.meta.url);

test("project quota stays in billing without badges on work and creation surfaces", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const billing = await readFile(new URL("../app/billing-view.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.doesNotMatch(page, /ProjectQuotaBadge/);
  assert.doesNotMatch(billing, /ProjectQuotaBadge|이번 달 Project|현재 미적용/);
  assert.doesNotMatch(styles, /project-quota-badge/);
  assert.match(billing, /<Usage label=\{t\("Project 생성"\)\} used=\{billing\.usage\.projects\.used\}/);
});

test("brands connection completion as OKRI while preserving workspace names", async () => {
  const [promptRoute, slackStatus, page] = await Promise.all([
    readFile(new URL("../app/api/integration-tokens/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/slack/status/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(promptRoute, /연결 서비스: OKRI/);
  assert.match(promptRoute, /실제 연결 확인에 성공한 경우 완료 안내는 'OKRI 연결이 완료되었습니다\.'/);
  assert.match(promptRoute, /연결된 워크스페이스: …/);
  assert.match(promptRoute, /확인에 실패하면 완료로 안내하지 않습니다/);
  assert.match(promptRoute, /워크스페이스: \$\{workspaceName\}/);
  assert.match(slackStatus, /OKRI 연결이 완료되었습니다\./);
  assert.doesNotMatch(slackStatus, /\$\{connection\?\.teamName[^\n]*연결/);
  assert.match(slackStatus, /connectedTeam: connection \? \{ id: connection\.teamId, name: connection\.teamName \}/);
  assert.match(page, /<b>\{t\("OKRI 연결 완료"\)\}<\/b>/);
  assert.match(page, /\{t\("연결된 Slack 워크스페이스:"\)\}\{teamName\}/);
  assert.doesNotMatch(page, /\{teamName\} 연결 완료/);
});

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

async function renderAsset(path) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("asset-test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`),
    {
      ASSETS: {
        fetch: async () => new Response("asset", { status: 200, headers: { "Content-Type": "text/javascript" } }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("public guide renders its complete native example without authentication", async () => {
  const response = await render("/guide");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /id="guide-goal"/);
  assert.match(html, /id="guide-title-task-7"/);
  assert.match(html, /class="guide-roles"/);
  assert.match(html, /https:\/\/okri.ai\/guide/);
  assert.match(html, /data-ready="false"/);
  assert.doesNotMatch(html, /landing-login-button|guide-screenshot/);
});

test("server-renders the OKRI application loading shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.equal(response.headers.get("cache-control"), "no-cache, must-revalidate");
  assert.equal(response.headers.get("cloudflare-cdn-cache-control"), "no-cache, must-revalidate");

  const html = await response.text();
  assert.match(html, /<title>OKRI - 목표를 오늘의 실행으로<\/title>/);
  assert.match(html, /OKRI/);
  assert.match(html, /app-loading-shell/);
  assert.match(html, /목표와 실행을 준비하고 있습니다/);
  assert.match(html, /워크스페이스와 오늘의 할 일을 불러오는 중입니다/);
  assert.doesNotMatch(html, /워크스페이스 로그인|세션 확인 중/);
  assert.doesNotMatch(html, /셀프 서브 도입|신규 사용자의 첫 주 활성화율|온보딩 체크리스트/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/i);
});

test("serves ChatGPT OAuth discovery metadata from well-known URLs", async () => {
  const protectedResourceResponse = await render("/.well-known/oauth-protected-resource");
  assert.equal(protectedResourceResponse.status, 200);
  assert.match(protectedResourceResponse.headers.get("content-type") ?? "", /^application\/json\b/i);
  assert.deepEqual(await protectedResourceResponse.json(), {
    resource: "http://localhost/api/mcp",
    authorization_servers: ["http://localhost"],
    scopes_supported: ["okri:read", "okri:write"],
    bearer_methods_supported: ["header"],
    resource_documentation: "http://localhost/#integrations",
  });

  const authorizationServerResponse = await render("/.well-known/oauth-authorization-server");
  assert.equal(authorizationServerResponse.status, 200);
  const authorizationServer = await authorizationServerResponse.json();
  assert.equal(authorizationServer.issuer, "http://localhost");
  assert.equal(authorizationServer.registration_endpoint, "http://localhost/oauth/register");
  assert.deepEqual(authorizationServer.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(authorizationServer.token_endpoint_auth_methods_supported, ["none"]);
});

test("Google OAuth keeps callback cookies on both official domains", async () => {
  const source = await readFile(new URL("../lib/google-oauth.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const oauthModule = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  const runtime = { GOOGLE_OAUTH_REDIRECT_URI: "https://okri.ai/api/google/callback" };
  assert.equal(oauthModule.googleRedirectUri(runtime, new Request("https://okri.ai/api/auth/google")), "https://okri.ai/api/google/callback");
  assert.equal(oauthModule.googleRedirectUri(runtime, new Request("https://okrptr.com/api/auth/google")), "https://okrptr.com/api/google/callback");
  assert.equal(oauthModule.googleRedirectUri(runtime, new Request("http://localhost/api/auth/google")), "https://okri.ai/api/google/callback");
});

test("ships product metadata and removes starter assets", async () => {
  const [layout, page, globals, bootstrapRoute, itemRoute, workspaceRoute, integrationRoute, okrOrganizeRoute, okrPlanRoute, slackAuthRoute, slackDisconnectRoute, slackAutomationRoute, slackAutomationTestRoute, slackAutomation, paceData, googleSession, googleSignInRoute, googleCallbackRoute, logoutRoute, packageJson, avatarRoute, schema, hosting, mcpRoute, mcpOAuth, protectedResourceRoute, authorizationServerRoute, oauthRegisterRoute, oauthAuthorizeRoute, oauthTokenRoute] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/api/bootstrap/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/items/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/workspaces/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/integration-tokens/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/okr-organize/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/okr-plan/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/slack/auth/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/slack/disconnect/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/slack/automations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/slack/automations/test/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/slack-automation.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/pace-data.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/google-session.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/google/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/google/callback/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/logout/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/api/workspaces/avatar/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../app/mcp/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/mcp-oauth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/[wellKnown]/oauth-protected-resource/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/[wellKnown]/oauth-authorization-server/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/oauth/register/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/oauth/authorize/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/oauth/token/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(layout, /openGraph/);
  assert.doesNotMatch(layout, /\/og\.png/);
  const aiConnections = await readFile(new URL("../app/ai-connections.tsx", import.meta.url), "utf8");
  assert.match(page, /AIConnectionsDialog/);
  assert.match(aiConnections, /ChatGPT 연결 문구 복사/);
  assert.match(page, /개인 앱 연동/);
  assert.match(page, /mobile-navigation/);
  assert.match(page, /workspace-mobile-home/);
  assert.match(page, /goToMobileHome/);
  assert.match(page, /aria-label=\{t\("홈으로 이동"\)\}/);
  assert.match(page, /get home\(\) \{ return t\("AI 대화"\); \}/);
  assert.doesNotMatch(page, /assistant-sidebar-tab/);
  assert.match(page, /\{ id: "home", get label\(\) \{ return t\("AI 대화"\); \}, icon: Bot \}/);
  assert.ok(page.indexOf('{ id: "my_work", get label() { return t("내 업무"); }') < page.indexOf('{ id: "okr", label: "OKR"'), "내 업무가 OKR보다 먼저 표시되어야 합니다");
  assert.match(page, /const mobileNavItems = \(\["home", "okr", "my_work", "work", "inbox"\]/);
  assert.match(page, /id="home-okr-chat-title".*AI 대화/);
  assert.match(page, /assistant-target-picker/);
  assert.match(page, /Objective, KR, Initiative, Project 검색/);
  assert.match(page, /Project를 기준으로 이야기하겠습니다/);
  assert.match(page, /aria-label=\{t\("AI 대화 열기"\)\}/);
  assert.match(page, /currentWorkspace\.role !== "owner"/);
  assert.match(page, /freshWorkspaceDataReady/);
  assert.match(page, /Project 책임자/);
  assert.match(page, /지금은 건너뛰기/);
  assert.match(page, /더보기/);
  assert.match(page, /개인 연결/);
  assert.match(page, /Slack 연결/);
  assert.match(page, /팀 Slack을 연결하세요/);
  assert.match(page, /view=integrations/);
  assert.match(page, /내 계정에 연결된 앱/);
  assert.match(page, /workspace-settings-trigger/);
  assert.match(page, /Slack 연결 후 데일리 봇을 설정할 수 있습니다/);
  assert.match(page, /bot-accordion-trigger/);
  assert.match(page, /워크스페이스 설정.*일반.*멤버.*그룹.*Project 설정.*관리 요약.*자동화 봇.*위험 구역/s);
  assert.match(page, /settings=workspace&tab=integrations/);
  assert.match(page, /자동화 봇/);
  assert.match(page, /Task 완료 또는 다시 열림/);
  assert.match(page, /Task 다시 열림/);
  assert.match(page, /테스트 전송/);
  assert.match(paceData, /ALTER TABLE slack_daily_settings ADD COLUMN onboarding_completed_at TEXT/);
  assert.match(page, /최근 전송 기록/);
  assert.match(page, /30일 동안 복구/);
  assert.match(page, /function WorkspaceAvatarDialog/);
  assert.match(page, /워크스페이스 이미지/);
  assert.match(page, /AI로 만들기/);
  assert.match(page, /생성하고 바로 적용/);
  assert.match(page, /prepareWorkspaceAvatar/);
  assert.match(page, /currentWorkspace\.role === "owner" \|\| currentWorkspace\.role === "admin"/);
  assert.match(globals, /workspace-avatar-preview/);
  assert.match(avatarRoute, /WORKSPACE_AVATARS\?: R2Bucket/);
  assert.match(avatarRoute, /"gpt-image-2"/);
  assert.match(avatarRoute, /quality: "low"/);
  assert.match(avatarRoute, /output_format: "webp"/);
  assert.match(avatarRoute, /verifiedImageType/);
  assert.match(avatarRoute, /OKRI_AI_MAX_IMAGE_REQUESTS_PER_DAY/);
  assert.match(schema, /avatarKey: text\("avatar_key"\)/);
  assert.match(hosting, /"r2": "WORKSPACE_AVATARS"/);
  assert.match(page, /삭제 예정/);
  assert.match(page, /workspaceDeletionLabel/);
  assert.match(workspaceRoute, /scheduleWorkspaceDeletionForUser/);
  assert.match(workspaceRoute, /restoreWorkspaceForUser/);
  assert.match(workspaceRoute, /permanentlyDeleteWorkspaceForUser/);
  assert.match(workspaceRoute, /payload\.confirmed !== true/);
  assert.match(workspaceRoute, /Test workspace names cannot be created in production/);
  assert.match(page, /permanentlyDeleteWorkspace/);
  assert.match(bootstrapRoute, /Cache-Control": "no-store"/);
  assert.match(bootstrapRoute, /okri_workspace_id/);
  assert.doesNotMatch(page, /OAuth Redirect URL|Slash Command URL/);
  assert.match(page, /연결 관리/);
  assert.match(aiConnections, /연결됨/);
  assert.match(aiConnections, /연결 대기/);
  assert.match(aiConnections, /연결 없음/);
  assert.match(aiConnections, /발급된 연결 키/);
  assert.match(aiConnections, /lastUsedAt/);
  assert.doesNotMatch(page, /<span>ChatGPT 연동<\/span><i/);
  assert.doesNotMatch(page, /revoke-link/);
  assert.match(aiConnections, /\/api\/integration-tokens/);
  assert.match(page, /\/api\/okr-organize/);
  assert.match(page, /기존 OKR과 업무를 참고해/);
  assert.match(page, /referencesOpen && targetCandidates.length > 0/);
  assert.match(page, /답변 중/);
  assert.match(page, /보내기/);
  assert.match(page, /Objective 1개.*KR/);
  assert.match(page, /useState<View>\(\(\) => navigationFromLocation\(\)\.view\)/);
  assert.match(page, /OkrFileSurface/);
  assert.match(page, /Objective·KR·Initiative를 한 번에 작성/);
  assert.doesNotMatch(page, /AI 대화로 같이 만들기/);
  assert.match(page, /cycleId: targetCycleId/);
  assert.match(page, /context\?\.cycleId \?\? defaultCycleId/);
  assert.doesNotMatch(page, /첫 핵심 결과 정의|첫 실행 방향 정리/);
  assert.match(page, /planStringFieldsWithValues\(data\.organized\.plan\)/);
  assert.match(page, /OKR 트리 초안/);
  assert.match(page, /KR 미지정 Initiative/);
  assert.match(page, /onMoveInitiative/);
  assert.doesNotMatch(page, /function OkrItemEditPanel|function TreeView/);
  assert.doesNotMatch(page, /organizeLocally/);
  assert.match(page, /mode === "project" && visibleFields\.has\("project"\)/);
  assert.doesNotMatch(page, /첫 Project를 만들어볼까요\?/);
  assert.match(page, /mode === "project"/);
  assert.match(page, /get my_work\(\) \{ return t\("내 업무"\); \}/);
  assert.match(layout, /themeBootstrapScript/);
  assert.match(page, /type ThemeMode.*from "@\/lib\/themes"/);
  assert.match(page, /ThemePicker value=\{themeMode\}/);
  assert.match(page, /chat-send-button/);
  assert.match(page, /메시지 보내기/);
  assert.match(globals, /var\(--button-primary-bg\)/);
  assert.match(globals, /var\(--button-primary-fg\)/);
  const myWorkView = page.match(/function MyWorkView[\s\S]*?function MyWorkSection/)?.[0] ?? "";
  assert.ok(
    myWorkView.indexOf('title={t("Task")}') < myWorkView.indexOf('title={t("Project")}')
      && myWorkView.indexOf('title={t("Project")}') < myWorkView.indexOf('title={t("Routine")}'),
    "My Work sections must be ordered Task, Project, Routine",
  );
  assert.match(page, /systemKey === "general"/);
  assert.doesNotMatch(page, /status: "inbox"|인박스에 저장|인박스에 추가/);
  assert.match(okrOrganizeRoute, /"onboarding".*"coach"/);
  assert.doesNotMatch(okrOrganizeRoute, /initiative context is required for project mode/);
  assert.match(okrOrganizeRoute, /UI will require the user to choose an existing Initiative before saving/);
  assert.match(okrOrganizeRoute, /Always answer in the user's language/);
  assert.match(okrOrganizeRoute, /leave every plan field empty/);
  assert.doesNotMatch(page, /className="chat-presets"/);
  assert.doesNotMatch(page, /className="assistant-example"/);
  assert.doesNotMatch(page, /루틴부터/);
  assert.match(page, /언제 무엇을 반복할지 설명해 주세요/);
  assert.match(aiConnections, /브라우저 제어가 가능한 대화/);
  assert.match(integrationRoute, /현재 로그인된 내 ChatGPT 계정에 아래 OKRI MCP를 개인 연결로 지금 추가해 주세요/);
  assert.match(integrationRoute, /최종 실행 지시이자 명시적 사전 승인/);
  assert.match(integrationRoute, /'진행할까요\?' 같은 재확인 질문도 하지 마세요/);
  assert.match(integrationRoute, /OAuth 2\.1 메타데이터와 DCR, S256 PKCE 흐름/);
  assert.match(integrationRoute, /same_tool_confirmation/);
  assert.match(integrationRoute, /Project 승인 후 새 대화, @OKRI 재활성화, 검토 ID 복사/);
  assert.doesNotMatch(integrationRoute, /OKRI_ACCESS_TOKEN|Authorization: Bearer <OKRI_ACCESS_TOKEN>/);
  assert.match(integrationRoute, /같은 내용을 대화로 다시 묻지 않습니다/);
  assert.doesNotMatch(integrationRoute, /OKRI 연결을 계속할까요\?/);
  assert.match(integrationRoute, /로그인, 계정 선택, 2단계 인증 또는 CAPTCHA/);
  assert.match(protectedResourceRoute, /authorization_servers/);
  assert.match(authorizationServerRoute, /registration_endpoint/);
  assert.match(authorizationServerRoute, /code_challenge_methods_supported/);
  assert.match(oauthRegisterRoute, /token_endpoint_auth_method: "none"/);
  assert.match(oauthAuthorizeRoute, /code_challenge_method/);
  assert.match(oauthAuthorizeRoute, /callback\.searchParams\.set\("iss"/);
  assert.match(oauthTokenRoute, /exchangeMcpOAuthAuthorizationCode/);
  assert.match(mcpOAuth, /mcp_oauth_clients/);
  assert.match(mcpOAuth, /mcp_oauth_codes/);
  assert.match(mcpOAuth, /sha256Base64Url/);
  assert.match(mcpRoute, /resource_metadata/);
  assert.match(mcpRoute, /"manage_project"/);
  assert.match(mcpRoute, /MCP_CREATE_ITEM_CONFIRM_PREFIX/);
  assert.match(googleSession, /slice\(0, 4000\)/);
  assert.match(slackAuthRoute, /canManageTeam/);
  assert.match(slackDisconnectRoute, /canManageTeam/);
  assert.match(slackAutomationRoute, /canManageTeam/);
  assert.match(slackAutomationRoute, /listSlackAutomationDeliveries/);
  assert.match(slackAutomationTestRoute, /testSlackAutomation/);
  assert.match(slackAutomation, /chat\.postMessage/);
  assert.match(slackAutomation, /title\|status\|from_status\|priority\|kind\|workspace/);
  assert.match(slackAutomation, /replace\(\/&\/g, "&amp;"\)/);
  assert.match(paceData, /getSlackConnection\(ownerId: string\)/);
  assert.match(paceData, /dispatchSlackAutomationEvent/);
  assert.match(paceData, /scheduledDeletionAt/);
  assert.match(paceData, /purgeExpiredWorkspaces/);
  assert.match(paceData, /onConflictDoNothing/);
  assert.match(page, /트리거 포인트/);
  assert.match(page, /무엇을 어떻게/);
  assert.match(page, /연결 해제/);
  assert.match(aiConnections, /"chatgpt", "claude", "claude_code"/);
  assert.match(page, /taskParent/);
  assert.match(page, /parentId: projectItem\.id/);
  assert.match(page, /routineId: routine\.id/);
  assert.match(okrOrganizeRoute, /Routine is independent and may contain Task/);
  assert.match(okrOrganizeRoute, /Routine > Task is independent/);
  assert.match(okrOrganizeRoute, /Never concatenate separate Key Results or Initiatives/);
  assert.match(okrOrganizeRoute, /Polish every supported title while preserving its meaning, numbers, dates, and proper nouns/);
  assert.match(okrOrganizeRoute, /unassignedInitiatives/);
  assert.match(okrOrganizeRoute, /uniqueTitleMatch/);
  assert.match(okrOrganizeRoute, /if \(known && usedIds\.has\(known\.clientId\)\) return \[\]/);
  assert.match(okrOrganizeRoute, /recentConversation/);
  assert.match(okrOrganizeRoute, /workspaceContext/);
  assert.match(okrPlanRoute, /createOkrPlan/);
  assert.match(okrPlanRoute, /asTree\(payload\.tree\)/);
  assert.match(okrPlanRoute, /authorization\.userId/);
  assert.doesNotMatch(paceData, /validateRoutineInitiative|idx_routines_owner_initiative/);
  assert.match(page, /OKR이 오늘의 일로 이어지도록/);
  assert.match(await readFile(new URL("../lib/locales/en.ts", import.meta.url), "utf8"), /Connect your OKRs to today's work/);
  assert.match(await readFile(new URL("../lib/locales/ja.ts", import.meta.url), "utf8"), /目標を実行に変えるワークスペース/);
  assert.match(await readFile(new URL("../lib/locales/zh.ts", import.meta.url), "utf8"), /把目标变成行动的工作空间/);
  assert.match(await readFile(new URL("../lib/locales/es.ts", import.meta.url), "utf8"), /convertir objetivos en acción/);
  assert.match(page, /LandingScreen reason=\{authState.reason\} onSignIn=\{startGoogleSignIn\}/);
  assert.match(await readFile(new URL("../lib/landing-copy.ts", import.meta.url), "utf8"), /Google로 이동 중/);
  assert.match(page, /AppLoadingScreen/);
  assert.doesNotMatch(page, /GOOGLE_BROWSER_SIGN_IN_STATE_PREFIX/);
  assert.doesNotMatch(page, /accounts\.google\.com\/o\/oauth2\/v2\/auth/);
  assert.match(page, /\/api\/auth\/google\?returnTo=/);
  assert.match(page, /\/api\/bootstrap/);
  assert.match(page, /__OKRI_BOOTSTRAP_REQUEST__/);
  assert.match(page, /fetchBootstrapPayload/);
  assert.doesNotMatch(page, /scope=shell|scope=data/);
  assert.match(page, /workspaceDataState/);
  assert.match(page, /워크스페이스 데이터를 불러오지 못했습니다/);
  assert.doesNotMatch(page, /visibleCount.*20/);
  assert.doesNotMatch(page, /더 보기/);
  assert.match(page, /aria-label=\{t\("Project 필터"\)\}/);
  assert.match(page, /aria-label=\{t\("Project 정렬"\)\}/);
  assert.match(page, /aria-label=\{t\("Project 속성 관리"\)\} title=\{t\("Project 속성 관리"\)\}/);
  assert.match(page, /aria-label=\{t\("내 설정 닫기"\)\} title=\{t\("내 설정 닫기"\)\}/);
  assert.match(page, /workspaceNameCounts/);
  assert.match(page, /t\(" · 생성 \{value1\}", \{ value1: messageValue\(formatDateTime\(workspace\.createdAt\)\) \}\)/);
  assert.match(page, /Routine을 불러오지 못했습니다/);
  assert.match(page, /데일리 스크럼을 불러오지 못했습니다/);
  assert.match(page, /추천을 계산하지 못했습니다/);
  assert.match(page, /휴지통을 불러오지 못했습니다/);
  assert.match(page, /다시 시도/);
  assert.match(page, /savingChecklist/);
  assert.match(page, /Promise\.all\(\(kind === "project"/);
  assert.match(page, /void restoreRecord\(record\)/);
  assert.match(page, /void restoreItem\(entry\)/);
  assert.match(page, /cycleId=\{createItemCycle\?\.id \?\? null\}/);
  assert.match(page, /cycleId: kind === "task"/);
  assert.doesNotMatch(page, /\/api\/auth\/session/);
  assert.match(bootstrapRoute, /Promise\.all/);
  assert.match(bootstrapRoute, /Object\.assign\(\{\}, \.\.\.await Promise\.all/);
  assert.match(bootstrapRoute, /getTeam/);
  assert.match(bootstrapRoute, /listItems/);
  assert.match(bootstrapRoute, /Server-Timing/);
  assert.match(bootstrapRoute, /auth;dur=/);
  assert.match(bootstrapRoute, /workspace;dur=/);
  assert.match(bootstrapRoute, /data;dur=/);
  assert.match(paceData, /createdAt: workspace\.createdAt/);
  assert.match(paceData, /restoreTrashRecord/);
  assert.match(paceData, /itemAssignments: itemAssignmentRows/);
  assert.doesNotMatch(bootstrapRoute, /scope ===|scope !==/);
  assert.match(itemRoute, /payload\.cycleId === undefined \? undefined : asNullableString/);
  assert.match(paceData, /workspaceReady/);
  assert.doesNotMatch(paceData, /activatedWorkspaceIds/);
  assert.match(paceData, /createOkrPlan/);
  assert.match(paceData, /await d1\.batch\(statements\)/);
  assert.match(paceData, /Objective and at least one Key Result are required/);
  assert.match(paceData, /keyResultIds/);
  assert.match(paceData, /initiativeIds/);
  assert.match(paceData, /sortOrder: item\.sortOrder/);
  assert.match(paceData, /Parent and child must belong to the same OKR cycle/);
  assert.ok(
    paceData.indexOf("ALTER TABLE routines ADD COLUMN system_key") < paceData.indexOf("idx_routines_owner_system_key"),
    "routine compatibility columns must be added before dependent indexes",
  );
  assert.match(paceData, /schemaIsCurrent/);
  assert.match(paceData, /Validate every runtime compatibility sentinel in one D1 round trip/);
  assert.match(paceData, /LEFT JOIN project_documents AS project_document ON 1 = 0/);
  assert.match(paceData, /workspaceInitializationIsCurrent/);
  assert.match(paceData, /Keep the cold-path initialization audit to one D1 round trip/);
  assert.match(paceData, /AS legacy_hierarchy_exists/);
  assert.match(paceData, /DELETE FROM google_oauth_states WHERE expires_at <=/);
  assert.match(paceData, /delete\(googleOAuthStates\).*returning/);
  assert.match(page, /Google 계정 로그아웃/);
  assert.match(googleSession, /HttpOnly; Secure; SameSite=Lax/);
  assert.match(googleSession, /crypto\.subtle\.verify\("HMAC"/);
  assert.match(googleSession, /createGoogleSignInState/);
  assert.match(googleSession, /readGoogleSignInState/);
  assert.doesNotMatch(googleSession, /readGoogleBrowserSignInState/);
  assert.match(googleSignInRoute, /googleSignInAuthorizationUrl/);
  assert.match(googleSignInRoute, /createGoogleSignInState/);
  assert.doesNotMatch(googleSignInRoute, /createGoogleOAuthState/);
  assert.match(googleSignInRoute, /"Set-Cookie": signIn\.cookie/);
  assert.match(googleCallbackRoute, /createGoogleSessionCookie/);
  assert.match(googleCallbackRoute, /readGoogleSignInState/);
  assert.doesNotMatch(googleCallbackRoute, /readGoogleBrowserSignInState/);
  assert.match(googleCallbackRoute, /await import\("@\/lib\/pace-data"\)/);
  assert.match(googleCallbackRoute, /"Set-Cookie": await createGoogleSessionCookie/);
  assert.match(googleCallbackRoute, /const headers = new Headers/);
  assert.match(googleCallbackRoute, /return new Response\(null, \{ status: 303, headers \}\)/);
  assert.match(logoutRoute, /clearGoogleSessionCookies/);
  assert.match(logoutRoute, /headers\.append\("Set-Cookie", cookie\)/);
  assert.match(paceData, /canonicalUserIdForGoogle/);
  assert.doesNotMatch(paceData, /oai-authenticated-user/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("app/_sites-preview/SkeletonPreview.tsx", projectRoot)));
});

test("prerenders the startup shell and caches hashed assets", async () => {
  const [layout, viteConfig, assetHeaders, paceData, staticHtml, worker, publishScript, serviceWorker, generatedServiceWorker] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/_headers", import.meta.url), "utf8"),
    readFile(new URL("../lib/pace-data.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/client/index.html", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/publish-prerender.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/client/sw.js", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(layout, /next\/headers|await headers\(\)/);
  assert.match(layout, /__OKRI_BOOTSTRAP_REQUEST__/);
  assert.match(layout, /serviceWorker\.register\("\/sw\.js"/);
  assert.match(viteConfig, /prerender:\s*\{\s*routes:\s*"\*"\s*\}/);
  assert.match(viteConfig, /Resolve workspace entry hosts before serving the shared prerendered shell/);
  assert.match(viteConfig, /run_worker_first:\s*\["\/",\s*"\/_vinext\/image"\]/);
  assert.ok(worker.indexOf("workspaceSubdomainRedirect(request") < worker.indexOf("env.ASSETS.fetch(request)"));
  assert.match(assetHeaders, /max-age=31536000, immutable/);
  assert.match(assetHeaders, /Cloudflare-CDN-Cache-Control: public, max-age=31536000, immutable/);
  assert.match(assetHeaders, /Cloudflare-CDN-Cache-Control: no-cache, must-revalidate/);
  assert.doesNotMatch(layout, /Geist_Mono|font-geist-mono/);
  assert.doesNotMatch(paceData, /LEFT JOIN workspace_members AS member ON 1 = 0/);
  assert.match(paceData, /deletion_requested_by_user_id[\s\S]*FROM workspaces[\s\S]*LIMIT 0/);
  assert.match(staticHtml, /__OKRI_BOOTSTRAP_REQUEST__/);
  assert.match(staticHtml, /app-loading-shell/);
  assert.match(worker, /Cloudflare-CDN-Cache-Control/);
  assert.match(worker, /pathname\.startsWith\("\/_next\/static\/"\)/);
  assert.match(worker, /HASHED_ASSET_CACHE/);
  assert.match(worker, /APP_SHELL_EDGE_CACHE = "no-cache, must-revalidate"/);
  assert.match(staticHtml, /serviceWorker\.register/);
  assert.match(publishScript, /build:cache/);
  assert.match(publishScript, /build:precache/);
  assert.match(serviceWorker, /PRECACHE_URLS/);
  assert.match(serviceWorker, /networkFirst/);
  assert.match(serviceWorker, /fetch\(request, \{ cache: "no-store" \}\)/);
  assert.doesNotMatch(serviceWorker, /staleWhileRevalidate/);
  assert.match(serviceWorker, /event\.request\.mode === "navigate"/);
  assert.match(serviceWorker, /cacheFirst/);
  const indexAsset = staticHtml.match(/\/_next\/static\/chunks\/index-[A-Za-z0-9_-]+\.js/)?.[0];
  assert.ok(indexAsset);
  assert.match(generatedServiceWorker, new RegExp(indexAsset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(generatedServiceWorker, /const CACHE_NAME = "okri-assets-[A-Za-z0-9_-]+"; \/\/ build:cache/);
});

test("ships atomic OKR file editing and safe Project recovery contracts", async () => {
  const [surface, okrFiles, collectionRoute, fileRoute, splitRoute, trashRoute, paceData] = await Promise.all([
    readFile(new URL("../app/okr-file-surface.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/okr-files.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/okr-files/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/okr-files/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/okr-files/[id]/split/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/item-trash/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/pace-data.ts", import.meta.url), "utf8"),
  ]);

  assert.match(surface, /파일 전체 수정/);
  assert.match(surface, /expectedRevision/);
  assert.match(surface, /projectResolutions/);
  assert.match(surface, /beforeunload/);
  assert.match(surface, /KR은 한 개 이상 필요/);
  assert.match(surface, /Project 탭/);
  assert.match(surface, /onOpenProject/);
  assert.match(surface, /onOpenTask/);
  assert.match(surface, /aria-expanded/);
  assert.match(surface, /미완료 Project 없음/);
  assert.match(surface, /미완료 Task 없음/);
  assert.doesNotMatch(surface, /완료 처리/);
  assert.match(surface, /buildBootstrapOkrFile/);
  assert.match(surface, /fetchEditableOkrFile/);
  assert.doesNotMatch(surface, /\?mode=read/);
  assert.doesNotMatch(surface, /OKR 파일을 불러오는 중/);
  assert.match(okrFiles, /calculateRevision/);
  assert.match(okrFiles, /await d1\.batch\(statements\)/);
  assert.match(okrFiles, /Project resolution is required/);
  assert.match(okrFiles, /status = 'planned'.*status = 'active'/s);
  assert.match(okrFiles, /completed\(status\) \? 100/);
  assert.match(collectionRoute, /createOkrFile/);
  assert.match(fileRoute, /getOkrFile/);
  assert.match(fileRoute, /getOkrFileRead/);
  assert.match(fileRoute, /mode.*read/);
  assert.match(fileRoute, /ETag/);
  assert.match(fileRoute, /Server-Timing/);
  assert.match(fileRoute, /updateOkrFile/);
  assert.match(fileRoute, /status: 409/);
  assert.match(splitRoute, /splitOkrFile/);
  assert.match(trashRoute, /projectParentIds/);
  assert.match(trashRoute, /restoreParentRequired/);
  assert.match(paceData, /Project restore requires a target Initiative/);
  assert.match(paceData, /parent_id = \?, cycle_id = \?/);
});

test("uses Google verified email and separates optional email marketing consent", async () => {
  const [page, paceData, marketing, marketingRoute, retiredRegistrationRoute, sendRoute, verifyRoute, privacy, terms, migration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/pace-data.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/marketing-consent.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/account/marketing-consent/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/account/registration/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/account/phone/send/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/account/phone/verify/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/privacy/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/terms/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0034_billing_email.sql", import.meta.url), "utf8"),
  ]);
  assert.match(page, /api\/auth\/google\?returnTo=/);
  assert.doesNotMatch(page, /function RegistrationScreen|\/api\/account\/phone\/send|휴대전화 소유 확인/);
  assert.doesNotMatch(paceData, /registration_required|allowIncompleteRegistration/);
  const consentUi = await readFile(new URL("../app/marketing-consent.tsx", import.meta.url), "utf8");
  assert.match(page, /MarketingConsentPrompt/);
  assert.match(consentUi, /\/api\/account\/marketing-consent/);
  assert.match(consentUi, /마케팅 목적 개인정보 이용 설정/);
  assert.match(consentUi, /광고성 이메일 수신 설정/);
  assert.match(marketing, /marketingEligible: marketingDataConsent && advertisingEmailConsent && !needsReaffirmation/);
  assert.match(marketing, /2 \* 365 \* 24 \* 60 \* 60_000/);
  assert.match(marketingRoute, /typeof payload\.marketingDataConsent !== "boolean"/);
  assert.match(retiredRegistrationRoute, /account_registration_retired/);
  assert.match(sendRoute, /phone_verification_retired/);
  assert.match(verifyRoute, /phone_verification_retired/);
  assert.match(privacy, /광고성 이메일은 두 동의를 모두 유지/);
  assert.match(privacy, /전화번호와 원본 응답 전체는 저장하지 않습니다/);
  assert.match(terms, /서비스 이용 대가나 가입 조건이 아닙니다/);
  assert.match(migration, /email_marketing_consents/);
  assert.match(migration, /UPDATE `account_registrations` SET `encrypted_phone` = ''/);
  assert.match(migration, /DELETE FROM `phone_verification_requests`/);
});

test("ships workspace plans, fail-closed Payple billing, and one billing screen", async () => {
  const [page, billingView, billing, statusRoute, sessionRoute, internalRoute, workflow, terms] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/billing-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/billing.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/billing/status/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/billing/payple/session/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/internal/billing/run/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/billing-hourly.yml", import.meta.url), "utf8"),
    readFile(new URL("../app/terms/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /view=\{?"billing"\}?|navigateView\("billing"\)/);
  assert.match(page, /<BillingView onNotice=\{showNotice\}/);
  assert.doesNotMatch(billingView, /안전한 사전 배포 상태|결제는 아직 활성화하지 않았습니다|운영 보안값|해외 카드는 현재 지원하지 않습니다/);
  assert.match(billingView, /PayPal로 결제/);
  assert.match(billingView, /Project·AI는 한국시간 매월 1일 초기화/);
  assert.match(billing, /free: \{ label: "Free", priceWon: 0, projectLimit: 10, editorLimit: 5, aiBudgetWon: 500 \}/);
  assert.match(billing, /team: \{ label: "Team", priceWon: 11_000, projectLimit: 100, editorLimit: 10, aiBudgetWon: 2_000 \}/);
  assert.match(billing, /business: \{ label: "Business", priceWon: 55_000, projectLimit: null, editorLimit: null, aiBudgetWon: 10_000 \}/);
  assert.match(billing, /BILLING_ENFORCEMENT_ENABLED\?\.toLocaleLowerCase\(\) === "true"/);
  assert.match(billing, /priorClaim.*billing_trial_claims/s);
  assert.match(billing, /\[1, 3, 5, 7\]/);
  assert.match(billing, /UPDATE billing_sessions SET used_at = \?/);
  assert.match(billing, /okri-reactivate-.*stableTimestamp/s);
  assert.match(billing, /BILLING_ENFORCEMENT_STARTED_AT/);
  assert.match(statusRoute, /getBillingStatus/);
  assert.match(sessionRoute, /payload\?\.contractAccepted === true/);
  assert.match(internalRoute, /verifyInternalBillingRequest/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /cron: "17 \* \* \* \*"/);
  assert.match(workflow, /x-okri-signature/);
  assert.match(terms, /Free 0원, Team 11,000원, Business 55,000원/);
});

test("serves hashed assets with immutable browser and edge caching", async () => {
  const staticHtml = await readFile(new URL("../dist/client/index.html", import.meta.url), "utf8");
  const assetPath = staticHtml.match(/\/_next\/static\/chunks\/index-[A-Za-z0-9_-]+\.js/)?.[0];
  assert.ok(assetPath);
  const response = await renderAsset(assetPath);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(response.headers.get("cloudflare-cdn-cache-control"), "public, max-age=31536000, immutable");
});

test("ships Project property, Task table, document, template, trash, and MCP surfaces", async () => {
  const [page, okrFileSurface, editor, propertiesRoute, documentsRoute, templatesRoute, itemTrashRoute, mcpRoute, paceData] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/okr-file-surface.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/project-block-editor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/properties/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/project-documents/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/project-templates/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/item-trash/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/mcp/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/pace-data.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /Project 설정.*속성.*템플릿/s);
  assert.doesNotMatch(page, /setProjectTab\(/);
  assert.doesNotMatch(page, /setProjectTab\("archive"\)/);
  assert.doesNotMatch(page, /모든 Project·Task 선택|Project·Task 선택/);
  assert.doesNotMatch(page, /function TreeView/);
  assert.match(page, /<OkrFileSurface/);
  assert.match(okrFileSurface, /okr-file-read-objective/);
  assert.match(okrFileSurface, /okr-file-read-initiative/);
  assert.match(okrFileSurface, /linkedProjects/);
  assert.match(okrFileSurface, /Project 탭/);
  const myWorkView = page.match(/function MyWorkView[\s\S]*?function MyWorkSection/)?.[0] ?? "";
  assert.doesNotMatch(myWorkView, /DeleteSelectCheckbox|onSelectItems|selectedItemIds/);
  assert.match(page, /items=\{executionItems\}/);
  assert.match(page, /<TaskListView items=\{taskItems\}/);
  assert.match(page, /전체 선택/);
  assert.match(page, /연결 끊긴 Task/);
  assert.match(page, /bulk-delete-bar/);
  assert.match(page, /DeleteSelectCheckbox/);
  assert.match(page, /삭제한 Project·Task와 전체 데이터 정리 기록/);
  assert.match(page, /전체 OKR 클린업 기록/);
  assert.match(page, /confirmationText: t\("영구 삭제"\)/);
  assert.match(page, /연결된 Task/);
  assert.match(page, /템플릿 불러오기/);
  assert.doesNotMatch(page, /window\.(prompt|confirm)/);
  assert.match(page, /저장 중.*저장됨.*저장 실패/s);
  assert.match(page, /expectedVersion/);
  assert.match(editor, /BlockNoteSchema\.create/);
  assert.match(editor, /defaultBlockSpecs\.table/);
  assert.doesNotMatch(editor, /defaultBlockSpecs\.(image|video|audio|file)/);
  assert.match(propertiesRoute, /payload\.preview === true/);
  assert.match(propertiesRoute, /includeInactive/);
  assert.match(documentsRoute, /version conflict/i);
  assert.match(documentsRoute, /applyProjectTemplate/);
  assert.match(templatesRoute, /createProjectTemplate/);
  assert.match(templatesRoute, /deleteProjectTemplate/);
  assert.match(itemTrashRoute, /listTrashedItems/);
  assert.match(itemTrashRoute, /scope === "all_project_task"/);
  assert.match(itemTrashRoute, /restoreTrashedItems/);
  assert.match(itemTrashRoute, /permanentlyDeleteTrashedItems/);
  assert.match(mcpRoute, /list_project_templates/);
  assert.match(mcpRoute, /get_project_document/);
  assert.match(mcpRoute, /update_project_document/);
  assert.match(mcpRoute, /apply_project_template/);
  assert.ok(
    paceData.indexOf('ADD COLUMN system_key') < paceData.indexOf('idx_property_definitions_owner_system'),
    "property compatibility columns must be added before dependent indexes",
  );
  assert.match(paceData, /legacyValue: row\.value/);
  assert.match(paceData, /\.\.\.templateBlocks, \.\.\.existingBlocks/);
  assert.match(paceData, /export async function trashItems/);
  assert.match(paceData, /export async function restoreTrashedItems/);
  assert.match(paceData, /export async function permanentlyDeleteTrashedItems/);
  assert.match(paceData, /taskIdsByArchivedParent/);
  assert.match(paceData, /archiveProject[\s\S]*trashItems/);
  const legacyMigration = paceData.match(/async function migrateLegacyHierarchy[\s\S]*?\n}/)?.[0] ?? "";
  assert.doesNotMatch(legacyMigration, /INSERT[^\n]*legacy-project-/);
  assert.match(legacyMigration, /DELETE FROM items[\s\S]*legacy-project-/);
  assert.match(paceData, /workspaceInitializationIsCurrent\(ownerId\)\) return;[\s\S]*removeLegacySeedWorkspaceData\(ownerId\)/);
  assert.match(paceData, /Workspace name confirmation does not match/);
});

test("keeps Task row structure and the side panel while allowing long titles to wrap", async () => {
  const [page, styles, paceData, mcpRoute] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../lib/pace-data.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/mcp/route.ts", import.meta.url), "utf8"),
  ]);
  const taskList = page.match(/function TaskListView[\s\S]*?function AsyncState/)?.[0] ?? "";
  const taskDetail = page.match(/function TaskDetailPanel[\s\S]*?function LineageRow/)?.[0] ?? "";
  const projectDetail = page.match(/function ProjectPageView[\s\S]*?function ProjectDataSection/)?.[0] ?? "";

  assert.match(page, /aria-label=\{t\("Task 목록"\)\}/);
  assert.match(page, /task-list-inline-meta/);
  assert.doesNotMatch(page, /task-list-status/);
  assert.match(page, /aria-label=\{t\("Task 정보"\)\}/);
  assert.match(taskList, /taskCompletionPatch\(entry\.status\)/);
  assert.doesNotMatch(taskList, /statusLabel\(entry\.status\)/);
  assert.match(taskDetail, /task-completion-toggle/);
  assert.match(taskDetail, /onPatch\(\{ priority:/);
  assert.doesNotMatch(taskDetail, /statusLabels|task-progress-field|type="range"/);
  assert.match(projectDetail, /project-task-completion/);
  assert.doesNotMatch(projectDetail, /project-task-progress|task\.progress/);
  assert.match(paceData, /export function normalizeTaskStatus/);
  assert.match(paceData, /kind === "task"[\s\S]*?normalizeTaskStatus\(input\.status\)/);
  assert.match(paceData, /current\.kind === "task"[\s\S]*?delete normalizedPatch\.progress/);
  assert.match(paceData, /const status = item\.kind === "task"[\s\S]*?normalizeTaskStatus/);
  assert.match(paceData, /item\.kind === "task" && status !== "archived" \? status === "done" \? 100 : 0/);
  assert.match(mcpRoute, /"set_task_completed"/);
  assert.match(mcpRoute, /Tasks use only incomplete\/complete/);
  assert.match(styles, /\.task-list-open[^}]*grid-template-columns:[^}]*minmax\(260px, \.85fr\)/s);
  assert.match(styles, /\.task-list-open b, \.task-list-inline-meta[^}]*white-space: normal/s);
  assert.match(styles, /\.task-detail-panel \{ width: min\(36rem, 100vw\); \}/);
  assert.match(styles, /\.task-completion-toggle/);
  assert.match(styles, /\.project-task-row[^}]*grid-template-columns:[^}]*76px/s);
});

test("defaults unlinked web Tasks to General and exposes direct bulk deletion", async () => {
  const [page, styles, paceData, itemsRoute, organizeRoute] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../lib/pace-data.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/items/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/okr-organize/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /AI 대화로 추가/);
  assert.match(page, /연결 대상 · 선택 사항/);
  assert.match(page, /선택 안 함 — General에 저장/);
  assert.match(page, /연결할 Project·Routine이 없어 General\(기본\)에 저장됩니다/);
  assert.match(page, /Project·Routine에 연결하지 않은 Task가 모이는 기본 목록/);
  assert.doesNotMatch(page, /부모가 없는 Task/);
  assert.match(page, /initialRoutines=\{routines\}/);
  assert.match(page, /dailyScrumMemoryCache/);
  assert.match(page, /recommendationMemoryCache/);
  assert.match(page, /trashMemoryCache/);
  assert.match(page, /t\("연결 끊긴 Task"\)\}\{t\("\{count\}개 선택", \{ count: orphanedIds\.length \}\)/);
  assert.match(page, /task-selection-delete/);
  assert.doesNotMatch(page, /할 일을 입력하면 미분류 Task에 저장됩니다/);
  assert.match(styles, /\.task-selection-bar/);
  assert.match(styles, /\.page-create-actions/);
  assert.match(paceData, /if \(!projectId && !routineId\) routineId = \(await ensureGeneralRoutine\(ownerId\)\)\.id/);
  assert.match(paceData, /kind === "task" && !parentId && !routineId[\s\S]*?ensureGeneralRoutine\(ownerId\)/);
  assert.match(paceData, /export async function createLinkedTasks[\s\S]*?await d1\.batch/);
  assert.match(itemsRoute, /payload\.titles !== undefined/);
  assert.match(itemsRoute, /createLinkedTasks/);
  assert.match(organizeRoute, /mode === "task"/);
  assert.match(organizeRoute, /one or more short, actionable Task titles/);
});

test("uses distinct Project and Routine AI creation flows", async () => {
  const [page, styles, organizeRoute] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/api/okr-organize/route.ts", import.meta.url), "utf8"),
  ]);

  assert.ok((page.match(/AI 대화로 추가/g) ?? []).length >= 3);
  assert.match(page, /mode === "project" && visibleFields.has\("project"\)/);
  assert.match(page, /mode === "routine" && visibleFields.has\("routineTitle"\)/);
  assert.match(page, /상위 Initiative/);
  assert.match(page, /참고 항목 선택/);
  assert.match(page, /createOpen=\{routineCreateOpen\}/);
  assert.match(styles, /\.page-create-actions > button[^}]*min-height: var\(--control-height\)/);
  assert.match(styles, /\.page-create-actions > button \{ min-height: 44px/);
  assert.match(organizeRoute, /"okr" \| "project" \| "routine" \| "task"/);
  assert.match(organizeRoute, /if \(mode === "routine"\)/);
  assert.match(organizeRoute, /Never connect the Routine to an Initiative or Project/);
  assert.match(organizeRoute, /routineCadence/);
});

test("limits Project and Task deletion to creators and accountable assignees", async () => {
  const [page, paceData, itemTrashRoute, projectArchiveRoute, cleanupRoute] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/pace-data.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/item-trash/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/project-archives/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/workspace-cleanup/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(paceData, /class ItemDeletePermissionError/);
  assert.match(paceData, /item\?\.kind === "project" && assignment\.role === "project_dri"/);
  assert.match(paceData, /item\?\.kind === "task" && assignment\.role === "task_assignee"/);
  assert.match(paceData, /createdByUserId: input\.createdByUserId/);
  assert.match(paceData, /await assertItemDeletePermission\(ownerId, userId, deletionRoots\)/);
  assert.match(paceData, /await assertItemDeletePermission\(ownerId, userId, roots\)/);
  assert.match(itemTrashRoute, /status: 403/);
  assert.match(itemTrashRoute, /canDelete: deletePermissions/);
  assert.match(projectArchiveRoute, /authorization\.userId, projectId/);
  assert.match(page, /function canUserDeleteItem/);
  assert.match(page, /selectionMode.*선택 종료/s);
  assert.match(page, /task-list-summary/);
  assert.doesNotMatch(page, /project-card-open[^\n]*type-project/);
  assert.match(page, /entry\.canDelete && <button className="danger"/);
  assert.match(cleanupRoute, /authorization\.role !== "owner" && authorization\.role !== "admin"/);
});

test("connects API data independently to Key Results and Projects", async () => {
  const [page, view, route, syncRoute, legacyRoute, legacySyncRoute, paceData, syncEngine, schema, worker, viteConfig, migration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/kr-data-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/data-connections/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/data-connections/sync/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/kr-data-connections/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/kr-data-connections/sync/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/pace-data.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/kr-data-sync.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0025_kr_data_connections.sql", import.meta.url), "utf8"),
  ]);
  assert.match(page, /id: "data", get label\(\) \{ return t\("데이터"\); \}/);
  assert.match(page, /rawView === "kr_data" \? "data"/);
  assert.match(page, /function ProjectDataSection/);
  assert.match(page, /tracksProgress = entry\.kind !== "objective" && entry\.kind !== "initiative"/);
  assert.doesNotMatch(page, /objective\.progress\}%/);
  assert.match(view, /item\.kind === "key_result" \|\| item\.kind === "project"/);
  assert.match(view, /API URL/);
  assert.match(view, /connectionMemoryCache\.get\(cacheKey\)/);
  assert.match(view, /\["project", t\("Project"\)\]/);
  assert.match(view, /t\("이 \{kind\}에 API 연결", \{ kind: targetLabels\[item\.kind\] \}\)/);
  assert.match(view, /숫자 값 경로/);
  assert.match(view, /자동 갱신 주기/);
  assert.match(route, /createDataConnection/);
  assert.match(route, /itemId/);
  assert.match(syncRoute, /syncDataConnection/);
  assert.match(legacyRoute, /createKrDataConnection/);
  assert.match(legacySyncRoute, /syncKrDataConnection/);
  assert.match(paceData, /Private or local API addresses are not supported/);
  assert.match(paceData, /DATA_CONNECTION_TARGET_KINDS/);
  assert.match(syncEngine, /AbortSignal\.timeout\(10_000\)/);
  assert.match(syncEngine, /kind IN \('key_result', 'project'\)/);
  assert.match(syncEngine, /UPDATE items SET progress = \?, updated_at = \?.*kind = \?/);
  assert.match(schema, /kr_data_connections/);
  assert.match(schema, /itemId: text\("kr_item_id"\)/);
  assert.match(worker, /scheduled\(_controller/);
  assert.match(viteConfig, /crons: \["\* \* \* \* \*"\]/);
  assert.match(worker, /getUTCMinutes\(\) % 15 !== 0/);
  assert.match(migration, /UPDATE `items` SET `progress` = 0 WHERE `kind` IN \('objective', 'initiative'\)/);
});

test("implements personal daily drafts and the managed Slack daily bot contract", async () => {
  const [page, styles, dailyDomain, schema, migration, skipMigration, isolationMigration, oauth, interactions, events, slackDaily, manifest, slackStatus, slackCallback, onboardingRoute, channelRoute, settingsRoute, slackAutomation, operationsGuide, customerGuide] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../lib/daily-bot.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0026_slack_daily_bot.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0028_daily_skip.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0029_slack_workspace_isolation.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/slack-oauth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/slack/interactions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/slack/events/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/slack-daily.ts", import.meta.url), "utf8"),
    readFile(new URL("../slack-app-manifest.yml", import.meta.url), "utf8"),
    readFile(new URL("../app/api/slack/status/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/slack/callback/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/slack/onboarding/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/slack/channels/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/slack/daily/settings/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/slack-automation.ts", import.meta.url), "utf8"),
    readFile(new URL("../docs/slack-production-setup.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/slack-customer-connect.md", import.meta.url), "utf8"),
  ]);
  const paceData = await readFile(new URL("../lib/pace-data.ts", import.meta.url), "utf8");
  assert.match(page, /내 데일리/);
  assert.match(page, /확정 및 공유/);
  assert.match(page, /작성 중인 초안은 상태만 표시/);
  assert.match(page, /<DailyWorkPicker/);
  assert.doesNotMatch(page, /책임자이지만 미완료 Task가 없는 Project/);
  assert.match(page, /오늘은 데일리를 스킵합니다/);
  assert.match(page, /본업 과중/);
  assert.match(page, /확정된 스킵 사유만 공개/);
  assert.match(page, /SlackDailySettingsPanel/);
  assert.match(page, /데일리 설정/);
  assert.match(page, /공유 안 함/);
  assert.match(page, /설정 완료/);
  assert.match(page, /멤버 연결·발송 관리/);
  assert.match(page, /즉시 발송/);
  assert.match(page, /지금 보내기/);
  assert.match(styles, /\.daily-layout/);
  assert.match(styles, /\.integrations-page/);
  assert.match(styles, /\.integration-step/);
  assert.match(styles, /\.slack-manual-send/);
  assert.match(styles, /\.slack-channel-sync/);
  assert.ok(styles.includes(".workspace-integration-section .integration-service-card"));
  assert.match(page, /INTEGRATION_STATUS_CACHE_KEY/);
  assert.ok(page.includes("Promise.allSettled([googleRequest, slackRequest])"));
  assert.ok(page.includes('member.linked ? t("Slack 연결됨") : t("Slack 계정 미연결")'));
  assert.match(page, /SLACK_CHANNEL_REFRESH_MS = 15_000/);
  assert.match(page, /useLiveSlackChannels/);
  assert.match(page, /visibilitychange/);
  assert.match(page, /Slack Connect · 봇 참여 중/);
  assert.ok(!page.includes("member.slackDisplayName"));
  assert.match(slackDaily, /member.display_name/);
  assert.ok(slackDaily.includes("COALESCE(member.display_name, submission.member_name) AS member_name"));
  assert.ok(slackDaily.includes("memberName: String(row.current_member_name || row.member_name)"));
  assert.match(dailyDomain, /task\.status NOT IN \('done', 'development_done', 'archived'\)/);
  assert.match(dailyDomain, /assignment\.role = 'task_assignee'/);
  assert.match(dailyDomain, /source: "daily"/);
  assert.match(dailyDomain, /dueDate: date/);
  assert.match(dailyDomain, /daily_task_snapshots/);
  assert.match(schema, /slackDailyReminders/);
  assert.match(schema, /slackDailyPublications/);
  assert.match(migration, /idx_daily_scrums_legacy_owner_date/);
  assert.match(skipMigration, /skip_reason/);
  assert.match(skipMigration, /skip_note/);
  assert.match(isolationMigration, /CREATE UNIQUE INDEX `idx_slack_connections_owner`/);
  assert.match(schema, /onboardingCompletedAt: text\("onboarding_completed_at"\)/);
  for (const scope of ["im:write", "im:history", "users:read.email", "channels:read", "channels:join", "groups:read"]) assert.match(oauth, new RegExp(scope.replace(".", "\\.")));
  assert.match(interactions, /view_submission/);
  assert.match(interactions, /skip_reason/);
  assert.match(slackDaily, /오늘 데일리 스킵/);
  assert.match(interactions, /block_suggestion/);
  assert.match(events, /slack_event_receipts/);
  assert.match(manifest, /https:\/\/okri\.ai\/api\/slack\/interactions/);
  assert.match(manifest, /message\.im/);
  assert.match(manifest, /channels:join/);
  assert.doesNotMatch(manifest, /incoming-webhook/);
  for (const state of ["service_unavailable", "workspace_disconnected", "setup_required", "reauthorization_required", "connected"]) assert.match(slackStatus, new RegExp(state));
  for (const field of ["connectionScope", "distributionMode", "connectedTeam"]) assert.match(slackStatus, new RegExp(field));
  assert.doesNotMatch(slackStatus, /reconcileDailyReminders/);
  assert.match(slackStatus, /서비스 설정을 확인해 주세요/);
  for (const code of ["slack_admin_approval_required", "workspace_already_connected", "authorization_cancelled", "missing_scope", "oauth_exchange_failed"]) assert.match(`${oauth}\n${slackCallback}`, new RegExp(code));
  assert.match(slackCallback, /setup_required/);
  assert.match(slackCallback, /hasWorkspaceAdminAccess/);
  assert.match(slackCallback, /x-okri-workspace-id/);
  assert.match(slackCallback, /new Request\(request\.url, \{ method: "GET", headers: callbackHeaders \}\)/);
  assert.doesNotMatch(slackCallback, /new Request\(request, \{ headers: callbackHeaders \}\)/);
  assert.match(slackCallback, /Slack OAuth callback failed/);
  assert.match(paceData, /hasWorkspaceAdminAccess/);
  assert.doesNotMatch(page, /slack\?\.configured/);
  assert.doesNotMatch(paceData, /serializeSlackConnection\(connection: SlackConnection \| null, configured/);
  assert.match(onboardingRoute, /configureSlackDailyOnboarding/);
  assert.match(slackDaily, /conversations\.join/);
  assert.match(slackDaily, /is_ext_shared/);
  assert.match(slackDaily, /canAutoJoinSlackChannel/);
  assert.match(slackDaily, /chat\.scheduleMessage/);
  assert.match(slackDaily, /testDailyChannel/);
  assert.match(slackDaily, /sendDailyReminderNow/);
  assert.match(slackDaily, /\[데일리 봇\]/);
  assert.match(settingsRoute, /payload\.action === "send_now"/);
  assert.match(slackAutomation, /Task 변동 알림 봇/);
  assert.match(channelRoute, /includeJoinablePublic/);
  assert.match(channelRoute, /private, no-store, max-age=0/);
  assert.match(operationsGuide, /apps\.manifest\.create/);
  assert.match(operationsGuide, /일반 고객은 이 절차를 수행하지 않으며/);
  assert.doesNotMatch(operationsGuide, /AllVibe/i);
  assert.match(operationsGuide, /테스트 DM/);
  assert.match(customerGuide, /훅 URL, Client ID, Client Secret을 입력할 필요는 없다/);
  assert.match(customerGuide, /다른 고객의 Slack이나 운영자의 테스트 Slack과 연결되지 않는다/);
});

test("uses theme-specific KR and Initiative hierarchy surfaces", async () => {
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const themes = await readFile(new URL("../lib/themes.ts", import.meta.url), "utf8");
  assert.match(themes, /"okr-card-bg": "bg-raised"/);
  assert.match(themes, /"kr-badge-bg": seed\.accentSoft/);
  assert.match(themes, /"kr-badge-text": seed\.accent, "kr-rail": seed\.accent/);
  assert.match(themes, /"initiative-badge-bg": seed\.secondarySoft/);
  assert.match(themes, /"initiative-badge-text": seed\.secondaryAccent, "initiative-rail": seed\.secondaryAccent/);
  assert.match(themes, /"progress-fill": seed\.accent/);
  assert.match(styles, /\.hierarchy-kind-key_result \{[^}]*border-left: 2px solid var\(--kr-rail\)[^}]*box-shadow: none/);
  assert.match(styles, /\.hierarchy-kind-initiative \{[^}]*border-left: 2px solid var\(--initiative-rail\)[^}]*box-shadow: none/);
  assert.match(styles, /\.hierarchy-kind-initiative \.initiative-execution-summary \{ color: var\(--muted\); \}/);
  assert.doesNotMatch(styles, /--kr-soft|--initiative-soft|#42627a|#426653|#e8eff4|#e8f0eb/);
});

test("keeps desktop density stable at wide widths and enlarges only touch controls", async () => {
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(styles, /html \{ font-size: 100%; \}/);
  assert.doesNotMatch(styles, /@media[^{}]+\{\s*html\s*\{\s*font-size:/);
  assert.doesNotMatch(styles, /@media \(min-width: 1800px\)/);
  assert.match(styles, /grid-template-columns: 16rem minmax\(0, 1fr\)/);
  assert.match(styles, /width: min\(100rem, 100%\)/);
  assert.match(styles, /workspace-topbar, \.app-loading-topbar \{ min-height: var\(--row-height\)/);
  assert.match(styles, /page-header h1[^}]*font-size: var\(--type-page\)/);
  assert.match(styles, /task-table-row \{ min-height: var\(--row-height\)/);
  assert.match(styles, /task-list-row \{[^}]*min-height: var\(--row-height\)/);
  assert.match(styles, /routine-card b \{[^}]*font-size: var\(--type-body\)/);
  assert.match(styles, /my-work-item \{[^}]*min-height: var\(--row-height\)/);
  assert.doesNotMatch(styles, /\bzoom\s*:|transform\s*:\s*scale/);
  assert.match(styles, /@media \(max-width: 980px\), \(pointer: coarse\)/);
  assert.match(styles, /@media \(max-width: 700px\)/);
  assert.match(styles, /@media \(max-width: 980px\)/);
});

test("uses verified Google identities and explicit pending workspace invitations", async () => {
  const [page, paceData, schema, teamRoute, invitationRoute, previewRoute, acceptRoute, googleSession] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/pace-data.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/team/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/team/invitations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/invitations/preview/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/invitations/accept/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/google-session.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(paceData, /oai-authenticated-user/);
  assert.match(paceData, /canonicalUserIdForGoogle/);
  assert.match(paceData, /authIdentities\.providerSubject/);
  assert.match(schema, /export const users = sqliteTable/);
  assert.match(schema, /export const authIdentities = sqliteTable/);
  assert.match(schema, /export const workspaceInvitations = sqliteTable/);
  assert.match(schema, /idx_workspaces_personal_owner/);
  assert.match(teamRoute, /inviteTeamMember/);
  assert.match(invitationRoute, /resendWorkspaceInvitation/);
  assert.match(invitationRoute, /rotateWorkspaceInvitationLink/);
  assert.match(invitationRoute, /revokeWorkspaceInvitation/);
  assert.match(previewRoute, /previewWorkspaceInvitation/);
  assert.match(acceptRoute, /acceptWorkspaceInvitation/);
  assert.match(acceptRoute, /okri_workspace_id/);
  assert.match(page, /function InvitationDialog/);
  assert.match(page, /대기 중인 초대/);
  assert.match(page, /재전송/);
  assert.match(page, /초대 링크 복사/);
  assert.match(googleSession, /emailVerified/);
  assert.doesNotMatch(googleSession, /BrowserSignIn/);
});

test("implements a workspace management bot for data quality and urgency reporting", async () => {
  const [page, styles, route, domain, schema, runtimeSchema, worker, viteConfig, migration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/api/workspace-management-bot/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/workspace-management-bot.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/pace-data.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0033_workspace_management_bot.sql", import.meta.url), "utf8"),
  ]);

  for (const signal of ["missing_due_date", "missing_owner", "overdue", "completed_yesterday", "due_today"]) {
    assert.match(domain, new RegExp(signal));
  }
  assert.match(page, /id: "summary", label: "관리 요약"/);
  assert.match(page, /id: "integrations", label: "자동화 봇"/);
  assert.match(page, /rawTab === "management" \? "summary"/);
  assert.match(page, /function WorkspaceManagementSummary/);
  assert.match(page, /function WorkspaceManagementBot/);
  assert.match(page, /<WorkspaceManagementBot\b[^>]*active=\{openBot === "management"\}/);
  assert.match(page, /title=\{t\("업무 관리 봇"\)\}/);
  assert.match(page, /title=\{t\("Task 변동 알림 봇"\)\}/);
  assert.match(page, /워크스페이스 관리 봇 사용/);
  assert.doesNotMatch(page, /LIVE PREVIEW/);
  assert.doesNotMatch(page, /id: "blocked", name: "막힘 상태 알림"/);
  assert.match(page, /Task 완료 알림/);
  assert.match(page, /Task 다시 열림 알림/);
  assert.match(page, /새 Task 알림/);
  assert.doesNotMatch(page, /BOT CONNECTIONS|WORKSPACE HEALTH|RECOMMENDED|CURRENT RULES/);
  assert.match(page, /workspace-settings-section-header workspace-bot-header/);
  assert.doesNotMatch(page, /integration-intro compact/);
  assert.match(styles, /\.workspace-bot-header > button \{[^}]*min-height: var\(--control-height\);[^}]*background: var\(--raised\)/s);
  assert.match(styles, /\.bot-accordion/);
  assert.match(styles, /\.management-summary-groups/);
  assert.match(styles, /\.management-summary-project\.overdue/);
  assert.match(styles, /\.management-summary-delay-status/);
  assert.match(route, /mode === "settings"/);
  assert.match(route, /mode === "summary"/);
  assert.match(route, /canManageTeam/);
  assert.match(route, /testWorkspaceManagementBot/);
  assert.match(domain, /activity_log/);
  assert.match(domain, /parent_project/);
  assert.match(domain, /renderSlackReportGroup/);
  assert.match(domain, /Project 기한 초과/);
  assert.match(domain, /listSlackChannels/);
  assert.match(domain, /last_sent_date/);
  assert.match(domain, /`\[\$\{t\("관리 봇"\)\}\]/);
  assert.match(schema, /workspace_management_bot_settings/);
  assert.match(runtimeSchema, /workspace_management_bot_settings/);
  assert.match(migration, /idx_workspace_management_bot_due/);
  assert.match(worker, /runDueWorkspaceManagementBots/);
  assert.match(viteConfig, /crons: \["\* \* \* \* \*"\]/);
  assert.match(worker, /getUTCMinutes\(\) % 15 !== 0/);
});

test("keeps completion checkboxes visually compact while preserving mobile touch targets", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /aria-pressed=\{isCompletedStatus\(entry\.status\)\}/);
  assert.match(styles, /--control-height: 2\.75rem/);
  assert.match(styles, /\.task-check \{[^}]*width: var\(--control-height\);[^}]*min-height: var\(--control-height\);[^}]*border: 0;[^}]*background: transparent/s);
  assert.match(styles, /\.task-check::before \{[^}]*width: 18px;[^}]*height: 18px;[^}]*border-radius: 50%/s);
  assert.match(styles, /\.workspace-topbar button, \.icon-button, \.task-check,[^}]*min-width: 44px; min-height: var\(--row-height\)/s);
});

test("keeps workspace controls visible above project checkboxes", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /workspace-settings-trigger[\s\S]*?<Settings size=\{17\}/);
  assert.match(styles, /\.sidebar \{[^}]*position: sticky;[^}]*z-index: 20;/s);
  assert.match(styles, /\.workspace-settings-trigger \{[^}]*width: var\(--control-height\);[^}]*min-height: var\(--control-height\);[^}]*border: 1px solid var\(--line\)/s);
  assert.match(styles, /\.workspace-menu \{[^}]*z-index: 50;/s);
});
