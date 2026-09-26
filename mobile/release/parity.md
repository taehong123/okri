# Native parity ledger

- 2026-09-26: Removed web browser-install entry points and install manifest linking to avoid confusing the web shortcut with the native Android closed test. The Play Store tester link remains. This is web-only; `/api/mobile/v1` and native binaries are unchanged.

- 2026-09-26: Web Project board now uses spaced horizontal Kanban columns on desktop, a separated responsive toolbar, and vertical status sections on narrow screens. This is a web-only presentation change; `/api/mobile/v1`, native Project data, and installed-client UI are unchanged.

- 2026-09-26: Android closed-test recruitment, private tester status links, feedback collection, and the Slack morning aggregate are web/server-only. They do not change `/api/mobile/v1`, the installed client, or native release behavior.

- 2026-09-24: Web Daily work groups can now be expanded and collapsed, while Slack team summaries add a divider between completed and planned work. This is presentation-only: `/api/mobile/v1` payloads and native Daily behavior are unchanged, so no native release is required.

## 2026-09-23 — Slack 업무 양식과 매뉴얼 공유

- Web/Slack 전용: `!프로젝트`, `!루틴`, `!티켓`, `!테스크` 양식과 `@OKRI` 대화 진입을 분리하고, 워크스페이스 관리자가 최신 명령 매뉴얼을 Slack 채널에 공유할 수 있게 했다.
- Native UI 변경 없음: iOS/Android 앱의 화면과 배포 채널에는 변경이 없다.
- `/api/mobile/v1` 및 기존 모바일 소비자 fixture/semantics 변경 없음.

## 1.0.0 candidate (not publicly released)

- Shared: themes, five languages, authorized OKR/Project/Task/Routine data.
- Native: Today, Projects, hierarchy tree, detail/edit/create, personal Daily,
  read-only Gantt, workspace selection, settings, Google/Apple auth and deletion.
- Web-only for this first release: property/document editing, administration,
  integration configuration and billing. Existing web links remain available
  where appropriate; do not add payment steering without store-policy review.
- This policy change: native v1 transport, current-member mapping, release status,
  isolated preview and store-binary-only release lanes.
- Re-run physical iOS/Android validation. Previous APK predates these changes.
- Integrated web/Slack work status (916d46c): v1 preserves remote status and
  translates skip to the existing skipReason contract; selecting work can resume
  without discarding Tasks. Native office/remote controls are explicitly deferred
  to the next native UI release and are not claimed in this candidate.
- Native schema migration 0063 retains the frozen 0054 schema and runs after the
  web migrations that were already deployed before native authentication.
- Web Project images and rich work documents are additive server capabilities.
  Native v1 keeps plain descriptions and does not claim image/document editing;
  those editors require a later binary and dedicated upload/privacy validation.
- Web first-run goal coaching remains web-only. Native first sign-in creates the
  same empty personal workspace and exposes the core creation screens directly.
- Web invitation acceptance now completes first-run onboarding in the invited
  workspace instead of opening team creation. `/api/mobile/v1` and native first
  sign-in remain unchanged; this is a web-only invitation-flow correction.
- Windows local-agent setup, integration administration and PayPal/card billing
  remain web-only. Native v1 contains no purchase link, plan promotion or payment
  SDK, so store commerce declarations remain false.
- Store review readiness adds a public five-language account deletion flow,
  recent-auth deletion protection and actionable Apple/Google review alerts.
- AI Task placement policy is now enforced consistently by MCP, Slack and
  integration-token writes: select an active Project/Routine first, or use
  General only after an explicit choice or when no active candidate exists.
  Native `/api/mobile/v1` already requires an explicit Project/Routine for its
  creation flows and remains contract-compatible; no native UI change is claimed.
- Slack Daily now presents every assigned open Project, Task and Routine, keeps
  empty Projects available for inline Task creation, and accepts Project/Routine
  selections instead of silently reducing the list to Tasks. This is a Slack-only
  interaction correction with no `/api/mobile/v1` contract or native UI change.
- Self-hosted deployment support keeps the frozen `/api/mobile/v1` routes,
  native-session semantics and SQLite-compatible schema intact. This is an
  infrastructure migration only; no native UI or mobile release is claimed.
- Web adds the independent `Ticket > Task` intake structure, including search,
  recoverable trash and MCP lifecycle tools. The frozen native v1 adapter omits
  Ticket records and their child Tasks from bootstrap and Daily responses, so
  installed clients keep their Project/Routine/General model unchanged. Native
  Ticket UI is deferred to a later store release with new consumer fixtures.
- Web extends Ticket with a workspace-scoped client directory, repeatable client
  products, optional Ticket links, copy actions, MCP tools and a bearer-token
  push/upsert API. The frozen native v1 adapter still omits Ticket and client
  records entirely; native client-directory UI remains deferred with Ticket.
- Web adds the client directory's external-integration guide, purpose-scoped
  customer push keys and optional personal MCP keys. Key administration remains
  web-only; `/api/mobile/v1` exposes no token secret or integration-management
  route, so the frozen native client and its authentication semantics are unchanged.
- Slack channel-main `@OKRI` invocations retain their own message as the
  creation source even when Slack thread lookup is unavailable, while threaded
  invocations keep excluding the live command. This is a Slack-only conversation
  fix; `/api/mobile/v1` and native UI are unchanged.
- Slack MCP answers now convert escaped/CommonMark emphasis to Slack mrkdwn so
  headings render as bold text instead of literal asterisks. This is Slack-only;
  `/api/mobile/v1` and native UI are unchanged.
- Slack bot conversations invoked in a Huddle thread now include a bounded plain
  text copy of that Huddle's attached notes Canvas. Canvas reads use the encrypted,
  read-only Slack user token granted by the installing Owner/Admin because bot
  sharing alone does not guarantee Canvas body access. The token is not used for
  messages or other bot calls. This does not read audio or transcripts and does
  not change `/api/mobile/v1`, native contracts or native UI.
- Slack Huddle Canvas reads now recover from unresolved attached-file lookups by
  matching the exact Canvas in the channel list and downloading its authenticated,
  size-bounded Slack HTML export. Mentions inside a Canvas also carry the exact
  file ID and bounded Slack excerpt into the same conversation. This remains a
  Slack-only server fix; `/api/mobile/v1`, native contracts and native UI are unchanged.
- Slack Huddle Canvas recovery now uses Slack's documented `spaces` file filter,
  reports stale delegated permissions instead of a generic sharing error, and gives
  workspace administrators a read-only check against their most recent Slack request.
  This remains a Slack/web administration fix; `/api/mobile/v1`, native contracts
  and native UI are unchanged.
- The Sites fallback build now skips Node-only prerendering and lets the Cloudflare
  worker render requests with its real runtime bindings. Self-hosted and native
  builds are unchanged, and `/api/mobile/v1` keeps its frozen contract.
- Slack Daily team summaries now update their existing channel message when a
  member submits or revises after the initial summary. This is Slack-only;
  `/api/mobile/v1` and native UI are unchanged.
- New active workspace members now join the Slack team-Daily scope by default,
  including before their Slack account is linked; admins can explicitly exclude
  them while DM delivery remains limited to linked members. This is Slack/web
  administration only; `/api/mobile/v1` and native UI are unchanged.
- A new Slack member's first bot invocation now links automatically when their
  Slack email uniquely matches one active OKRI member, then continues the same
  request. Ambiguous or unavailable email falls back to a private one-time link.
  This is Slack-only; `/api/mobile/v1` and native UI are unchanged.
- The protected Sites-to-self-hosted transfer receiver and import unpacker are
  one-time infrastructure operations. They do not change `/api/mobile/v1`,
  native authentication, or any native UI.
- Web and shared authorization now normalize persisted workspace roles before
  rendering or permission checks. Unknown legacy roles fail closed as Viewer,
  while the recorded workspace owner is restored as Owner. This prevents the
  workspace switcher/settings crash without changing `/api/mobile/v1` response
  shapes or adding a native UI claim.
- Slack Daily now keeps up to 23 assigned open items on one safe modal page and
  exposes separate authoritative candidate, draft-selection and latest-shared
  counts to the Slack MCP agent. This corrects Slack visibility and diagnosis;
  `/api/mobile/v1`, native contracts and native UI are unchanged.

For every later product request, record web implementation and one explicit native
disposition: shared next bundle, native implemented, web-only with rationale, or
deferred with a target store release. The candidate report is input to this review,
not evidence that a web feature magically exists in React Native.
