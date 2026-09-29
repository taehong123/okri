import { slackWorkGuideText } from "./slack-work-command-guide";

export const OKRI_MANUAL_VERSION = "2026-09-28";
export const MANUAL_SURFACES = ["web", "slack", "mcp"] as const;
export type ManualSurface = (typeof MANUAL_SURFACES)[number];

type ManualArticle = { id: string; title: string; keywords: string[]; content: string };

// Product documentation only. Never insert workspace records or user-authored text here.
export const OKRI_MANUAL_ARTICLES: readonly ManualArticle[] = [
  {
    id: "start", title: "시작하기와 AI 대화", keywords: ["시작", "처음", "온보딩", "사용법", "사용방법", "사용 방법", "guide", "getting started"],
    content: `OKRI는 목표와 실행 업무를 연결하는 도구입니다. OKR에서 달성할 변화를 정하고, Project·Routine·Ticket 아래 Task로 실행합니다.
웹의 AI 대화에서 목표나 업무를 설명하면 초안을 정리할 수 있습니다. 사용법 질문은 설명만 하며, 웹 AI 초안은 생성/저장 동작을 완료하기 전에는 실제 업무가 아닙니다.
기존 업무를 확인·수정할 때는 해당 항목의 상세를 엽니다. 내 업무에서는 담당 업무를 확인하고 기한순/우선순위순으로 정렬합니다.
초대 링크로 참여한 사람은 초대된 워크스페이스를 확인하세요. 개인 워크스페이스와 팀 워크스페이스의 데이터는 서로 다릅니다.
예시: "OKR과 Project는 어떻게 달라?", "프로젝트 생성 방법 알려줘", "Slack에서 가능한 명령어 전부 알려줘".
이 매뉴얼은 제품 사용법이며 현재 계정의 연결 성공 여부나 실제 업무 현황을 증명하지 않습니다.`,
  },
  {
    id: "structure", title: "Objective·KR·Initiative와 업무 구조", keywords: ["okr", "objective", "목표", "key result", "kr", "이니셔티브", "initiative", "계층", "구조", "차이", "hierarchy"],
    content: `OKR 실행 계층은 Objective > Key Result > Initiative > Project > Task입니다.
Objective는 이루려는 변화, KR은 측정 가능한 결과, Initiative는 그 결과를 개선할 실행 방향입니다. 하나의 Objective 아래 여러 KR, 각 KR 아래 여러 Initiative를 둘 수 있습니다.
Project는 결과·범위·완료 조건이 있는 업무 묶음입니다. 해당 Initiative에 연결합니다. Task는 한 사람이 실행하고 완료하는 구체적인 일입니다.
Routine > Task는 반복 업무, Ticket > Task는 요청 업무를 위한 독립 구조입니다. Routine과 Ticket에 Initiative 연결은 필요하지 않습니다.
Project·Routine·Ticket 중 소속을 정하지 않은 Task는 General에 둡니다. AI는 연결 후보가 있으면 선택을 돕고 임의로 소속을 결정하지 않습니다.
Task를 완료했다고 KR의 실제 성과 수치가 자동으로 달성되는 것은 아닙니다. 실행 완료와 결과 측정은 구분하세요.`,
  },
  {
    id: "projects", title: "Project 생성·수정·속성·문서", keywords: ["project", "프로젝트", "dri", "속성", "property", "문서", "document", "템플릿", "template"],
    content: `Project를 생성할 때 제목과 연결할 Initiative를 확인하고 필요한 상태, 우선순위, 기한, DRI와 참여자를 정합니다. DRI는 결과 책임자 1명이며 모든 Task를 직접 수행할 필요는 없습니다.
목록의 Project를 열어 제목과 속성을 수정합니다. 상세에는 연결된 Task와 문서 본문이 있습니다. Task를 추가할 때 해당 Project 연결을 확인합니다.
속성 관리는 기본·커스텀 속성의 설정을 관리합니다. 특정 Project의 속성을 숨겨도 값이 삭제되는 것은 아닙니다. 템플릿 관리는 문서 본문을 재사용하는 기능이며 속성값·Task·담당자를 복제하지 않습니다.
템플릿을 불러오면 기존 본문 위에 삽입됩니다. 적용된 문서는 독립 사본이므로 원본 템플릿 수정이 기존 Project 문서를 바꾸지 않습니다.
Slack에서는 !프로젝트로 양식을 열거나 @OKRI로 생성안을 요청합니다. AI 생성안의 Initiative와 내용을 확인하고 다음 메시지에서 승인해야 실제 생성됩니다. 승인 전 초안을 생성 완료로 보지 마세요.
Project를 휴지통으로 옮기면 직속 Task도 함께 활성 화면에서 제외되고 복구할 수 있습니다. 영구 삭제는 복구 가능한 보관과 다르므로 대상과 영향을 반드시 확인합니다.`,
  },
  {
    id: "tasks", title: "Task 생성·담당·완료와 내 업무", keywords: ["task", "태스크", "테스크", "할 일", "할일", "내 업무", "내업무", "기한", "우선순위", "체크리스트", "checklist"],
    content: `Task는 담당자 1명이 실행하는 단위입니다. Project·Routine·Ticket 중 하나에 연결하거나 General에 둡니다. 동시에 여러 실행 컨테이너에 소속시키지 않습니다.
목록 행을 선택하면 상세를 확인·수정할 수 있습니다. 완료/미완료를 전환하며 완료 취소로 다시 열 수 있습니다. Task 안의 체크리스트는 세부 실행 단계이지 또 하나의 업무 계층이 아닙니다.
내 업무는 Task와 Project 구분을 유지합니다. 기한순은 빠른 기한부터, 미지정은 마지막입니다. 우선순위순은 긴급 > 높음 > 보통 > 낮음입니다. 같은 우선순위는 기한순입니다.
Slack: !테스크 [이름]으로 양식을 열어 소속, 담당자, 기한을 확인한 뒤 생성합니다. !테스크조회, !테스크수정, !테스크완료, !테스크재열기를 지원합니다. 태스크 표기도 같습니다.
AI로 여러 Task를 만들 때는 실제로 요청한 업무만 전달하세요. 제목·담당자·기한을 임의로 채우지 않습니다. 삭제는 권한을 확인한 뒤 휴지통 이동으로 처리하며 영구 삭제와 구분합니다.`,
  },
  {
    id: "routines", title: "Routine 반복 업무", keywords: ["routine", "루틴", "반복", "주기", "매일", "매주", "매월"],
    content: `Routine은 반복해서 수행하는 독립 업무 컨테이너입니다. 언제 시작하는지(트리거), 어디서 하는지(장소/도구), 무엇을 어떻게 하는지(실행 방법), 주기와 담당자를 정합니다.
Routine 아래 Task를 연결할 수 있으며 Initiative나 Project에 연결할 필요는 없습니다.
Slack의 !루틴 [이름]은 생성 양식을 엽니다. @OKRI로 조회·생성·수정, 일시정지·재개, 특정 날짜의 완료·취소를 요청할 수 있습니다.
Routine의 날짜별 완료 기록과 연결 Task의 완료는 구분합니다. Routine 삭제 시 완료 이력 등 영향 범위를 확인해야 합니다.`,
  },
  {
    id: "tickets", title: "Ticket 요청 업무", keywords: ["ticket", "티켓", "요청 업무", "클라이언트", "client", "고객 요청"],
    content: `Ticket은 요청을 접수하고 해결하는 독립 업무 컨테이너입니다. OKR 주기나 Initiative 연결 없이 사용할 수 있습니다.
제목, 필요하면 클라이언트·제품, 상태, 우선순위, 기한과 내용을 정합니다. 상태는 접수(backlog), 정책 논의(policy_discussion), 진행(in_progress), 완료(done)로 구분합니다.
실제로 수행할 일은 Ticket 아래 Task로 나누고 Task 담당자를 지정합니다. Ticket에 Project의 DRI·참여자 구조를 그대로 적용하지 않습니다.
Slack의 !티켓 [이름]으로 클라이언트·제품을 포함한 생성 양식을 엽니다. Slack AI는 Ticket 생성·조회·일반 수정을 지원하지만 클라이언트 관리, Ticket 삭제·복구 도구는 현재 노출하지 않습니다. 해당 작업은 웹 또는 지원하는 외부 MCP 도구 범위를 확인합니다.`,
  },
  {
    id: "daily", title: "데일리 작성·공유와 요약 봇", keywords: ["daily", "데일리", "스크럼", "어제", "오늘", "미공유", "요약", "회고", "리뷰"],
    content: `데일리에서 담당 업무를 확인하고 오늘 할 업무를 선택한 뒤 공유합니다. 업무 선택/초안 저장과 팀에 공유 완료는 다른 단계입니다. 공유 결과와 상태 표시를 확인하세요.
담당 업무 전체(availableWork), 현재 선택한 계획(selectedWork), 마지막 공유 내용(latestSubmittedWork)은 서로 다릅니다. 선택하지 않은 업무를 담당 목록 누락으로 판단하지 않습니다.
Slack에서 /okri daily 또는 /okri 데일리로 개인 데일리 작성창을 엽니다. !데일리 명령은 없습니다.
Slack 데일리는 Task마다 라디오 버튼으로 선택 안 함 / 오늘 꼭 할 일 / 여유되면 할 일 / 완료 / 아카이브 중 하나를 선택합니다. 프로젝트는 제목과 Task 추가 버튼만 표시하며 별도로 선택하거나 완료하지 않습니다. 다른 사람의 프로젝트라도 나에게 할당된 Task는 표시합니다.
오늘 꼭 할 일은 오늘 완료하기로 정한 업무, 여유되면 할 일은 그 이후 진행할 추가 업무입니다. 날짜별 데일리 구분이며 Task 기한이나 우선순위를 변경하지 않습니다. 개인 공유와 팀 요약에도 구분을 유지합니다. 완료와 아카이브는 제출할 때 반영하며 아카이브한 Task는 휴지통에서 복구할 수 있습니다.
이전 공유 기록은 유지합니다. 기존 오늘 할 일을 새 Slack 작성창에서 수정하거나 Task를 추가하면 여유되면 할 일로 시작합니다. 웹·설치형 앱의 기존 작성 화면은 유지하며 기존 요청으로 수정해도 남아 있는 선택의 필수 구분은 보존합니다.
@OKRI로 내 데일리를 조회하거나 어제·오늘·막힌 일 메모 저장, 기간별 리뷰와 실행 추천을 요청할 수 있습니다. AI 메모 저장을 Slack 공유 완료라고 표현하지 않습니다.
Owner/Admin은 워크스페이스 설정의 연동에서 데일리 봇 대상, 시간과 요약 공유 설정을 확인합니다. 예약·완료 조건과 미공유 인원은 실제 설정을 조회해야 하며 매뉴얼만 보고 발송 성공을 단정하지 않습니다.`,
  },
  {
    id: "data", title: "KR·Project 데이터 연결", keywords: ["데이터", "data", "동기화", "sync", "진행률", "측정", "소스"],
    content: `데이터 화면에서 활성 KR 또는 Project 하나를 대상으로 연결을 설정합니다. 항목당 연결은 최대 하나이며 Project 데이터 연결은 필수가 아닙니다.
HTTPS JSON 소스, 값 경로, 기준값·목표값, 갱신 주기를 지정하고 최근 결과와 오류를 확인합니다. Project 상세의 연결 데이터에서도 요약을 볼 수 있습니다.
동기화는 연결된 대상 하나의 진행률만 갱신합니다. KR과 Project, 상위 OKR과 하위 Task에 값을 복사·합산·전파하지 않습니다.
보관된 대상은 자동 동기화에서 제외되지만 연결 설정은 보존됩니다. Viewer는 조회만 합니다. 현재 Slack AI에는 데이터 연결 생성·설정·동기화 도구가 없으므로 웹에서 관리합니다.`,
  },
  {
    id: "slack-commands", title: "Slack 느낌표·슬래시 명령어 전체", keywords: ["slack", "슬랙", "명령어", "느낌표", "슬래시", "command", "!", "/okri"],
    content: `${slackWorkGuideText((text) => text)}
생성·수정 명령은 보통 '양식 열기'를 누른 뒤 내용을 확인하고 생성/저장해야 완료됩니다. 명령 입력 자체가 생성 완료는 아닙니다.
생성 별칭: !프로젝트생성, !루틴생성, !티켓생성, !테스크생성. 테스크 대신 태스크도 됩니다.
도움말 별칭: !메뉴얼, !매뉴얼, !manual, !help, !okri. @OKRI !도움말도 같은 안내를 표시합니다.
영어: !project [create|view|edit|status], !routine [create], !ticket [create], !task [create|view|edit|complete|reopen], !work create, !my work. 대괄호는 선택 표현이며 실제로 입력하지 않습니다.
/okri 또는 /okri help는 슬래시 사용법, /okri daily는 데일리 작성, /okri <내용>은 업무 생성 초안입니다. !OKR, !데일리, !티켓삭제 같은 명령은 지원하지 않습니다.`,
  },
  {
    id: "slack-ai", title: "@OKRI AI 기능과 지원 범위", keywords: ["ai", "봇", "bot", "태그", "멘션", "mention", "기능", "가능", "capabilities", "features", "할 수"],
    content: `채널이나 스레드에서 @OKRI 뒤에 원하는 작업을 설명합니다. AI는 현재 스레드의 접근 가능한 대화·Canvas·이미지를 참고하고 요청자의 워크스페이스 권한으로 도구를 호출합니다.
지원: OKR 항목 생성·조회·수정, Project 생성안·승인·수정·휴지통·복구, Task 단건/여러 건 생성·조회·수정·완료·재열기·소속 연결·휴지통, Ticket 생성·조회·일반 수정.
지원: Routine 조회·생성·수정·일시정지·재개·날짜별 완료/취소·삭제, Routine 속성 조회, Task 체크리스트 조회·추가·수정.
지원: Project 문서 조회·수정, 템플릿 조회·생성·적용, 이미지 조회, 속성 조회·추가·값 설정/비우기·제거.
지원: 내 데일리 조회·메모 저장, 일/주/월/분기 리뷰, 실행 추천, 팀 멤버·초대 현황 조회, 그룹 조회·생성·수정·보관/복구·그룹원 관리, 워크스페이스 규칙 조회·수정, read_manual로 제품 매뉴얼 읽기.
현재 Slack AI 미지원: 워크스페이스 멤버 초대·수정·제거, 클라이언트 관리/연결 도구, Ticket 삭제·복구, Project 영구 삭제, 그룹 영구 삭제, 데이터 연결 관리. 외부 MCP의 도구 목록과 Slack AI 범위는 다릅니다.
Project 생성은 제안 내용을 먼저 공개하고 다음 요청에서 승인받습니다. 일반 변경은 명확한 요청과 권한이 있어야 하며 삭제·멤버 변경은 대상과 영향을 확인합니다. 사용법만 질문하면 업무를 생성하거나 수정하지 않습니다.`,
  },
  {
    id: "permissions", title: "계정 연결·권한·워크스페이스", keywords: ["권한", "계정", "멤버", "member", "viewer", "admin", "owner", "초대", "oauth", "mcp", "연결", "로그인", "permission"],
    content: `워크스페이스마다 데이터와 멤버 권한이 분리됩니다. Owner/Admin의 관리 권한, Member의 업무 권한, Viewer의 조회 권한을 구분합니다. AI도 같은 서버 권한 검사를 받으며 권한 오류를 우회할 수 없습니다.
Slack 연결은 워크스페이스의 Slack 앱 설치와 사용자별 OKRI 계정 연결이 구분됩니다. 앱이 설치되었어도 현재 Slack 사용자가 OKRI 멤버에 연결되지 않으면 계정 연결이 필요할 수 있습니다.
외부 AI의 MCP 연결은 OAuth로 인증하고 해당 클라이언트에서 OKRI 도구가 실제로 표시되는지 확인합니다. 주소를 대화창에 붙여 넣는 것만으로 설치·인증이 완료되지는 않습니다.
제품 매뉴얼은 읽기 전용입니다. 실제 고객 데이터, 사용자의 권한, 연결 상태를 포함하지 않습니다. 매뉴얼을 읽은 것을 실제 항목 조회나 변경 완료로 보고하면 안 됩니다.
이름 표시는 워크스페이스 멤버 연결을 기준으로 확인하고 문자열 이름만 보고 다른 사람에게 업무를 배정하지 않습니다.`,
  },
  {
    id: "troubleshooting", title: "Slack·Canvas 문제 확인", keywords: ["오류", "안돼", "안되", "실패", "에러", "canvas", "캔버스", "허들", "권한 업데이트", "error", "troubleshoot"],
    content: `명령어 안내는 !도움말 또는 @OKRI !도움말로 확인합니다. 사용법 질문은 현재 스레드 원문이나 Canvas를 읽지 않아도 답할 수 있습니다.
스레드 작업은 앱의 채널 참여와 채널 유형별 읽기 권한이 필요합니다. 공개/비공개 채널과 DM의 권한이 서로 다르며 권한 변경 후 재연결이 필요할 수 있습니다.
Canvas를 봇과 공유한 것만으로 본문 접근이 보장되지는 않습니다. 앱 권한과 연결을 승인한 사용자의 해당 Canvas 접근 권한을 함께 확인합니다. 접근 실패 시 내용을 읽었다고 주장하거나 빈 내용으로 업무를 만들지 않습니다.
허들 메모 Canvas 지원은 접근 가능한 문서 본문에 대한 것입니다. 허들 음성을 직접 듣거나 존재하지 않는 녹취를 가져오는 기능은 아닙니다.
AI 한도 초과, 모델 연결 오류, 계정 미연결, 채널/Canvas 접근 오류는 서로 다른 문제입니다. 정확한 오류와 실제 상태를 확인합니다. 양식 명령과 !도움말은 AI 답변 생성과 별개입니다.`,
  },
];

export function isOkriManualQuestion(input: string) {
  const text = input.normalize("NFC").trim().toLocaleLowerCase().slice(0, 4_000);
  // An imperative to create/update actual work wins over documentation words in its title.
  if (/(?:만들어|생성해|추가해|등록해|저장해|수정해|삭제해|완료해|배정해|연결해|정리해)\s*(?:줘|주세요|줄래|라)|^(?:please\s+)?(?:create|save|delete|update|assign)\s+(?:a|an|the|this|that|my)\b/iu.test(text)) return false;
  if (/^!?\s*(?:(?:okri|오크리)\s*)?(?:도움말|매뉴얼|메뉴얼|사용법|사용방법|사용 방법|help|manual)[?.!\s]*$/iu.test(text)) return true;
  const product = /okri|오크리|okr|objective|key result|\bkr\b|initiative|project|task|routine|ticket|프로젝트|테스크|태스크|루틴|티켓|데일리|슬랙|slack|canvas|허들|속성|템플릿|체크리스트|내\s*업무|명령어|기능|사용법|사용\s*방법|매뉴얼|메뉴얼|manual|capabilities|features/iu.test(text);
  const usage = /사용법|사용\s*방법|매뉴얼|메뉴얼|도움말|명령어|기능|\b(?:manual|guide|help|capabilities|features|commands)\b/iu.test(text);
  const howTo = /어떻게|어떡|방법|\bhow\s+(?:do|can|to|should)\b/iu.test(text)
    && /생성|만들|만드|수정|삭제|완료|연결|사용|공유|추가|\b(?:create|use|edit|delete|connect|share|add|complete)\b/iu.test(text);
  const definition = !/내\s|우리|현재|오늘|어제|지난|이번|\b(?:my|our|current|today)\b/iu.test(text)
    && /차이|무엇인가|뭐야|뭐예요|뭔가요|\bwhat\s+(?:is|are)\b/iu.test(text);
  return product && (usage || howTo || definition);
}

export function readOkriManual(input: { topic?: string; query?: string; surface?: ManualSurface } = {}) {
  const surface = input.surface ?? "mcp";
  const query = (input.query ?? "").normalize("NFC").toLocaleLowerCase().trim().slice(0, 500);
  const topic = input.topic?.trim();
  const index = OKRI_MANUAL_ARTICLES.map(({ id, title }) => ({ id, title }));
  let articles: readonly ManualArticle[] = [];
  if (topic === "all") articles = OKRI_MANUAL_ARTICLES;
  else if (topic && topic !== "index") articles = OKRI_MANUAL_ARTICLES.filter((article) => article.id === topic);
  else if (query && topic !== "index") {
    articles = OKRI_MANUAL_ARTICLES.map((article, order) => ({
      article, order, score: article.keywords.filter((word) => query.includes(word)).length,
    })).filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order).slice(0, 4).map(({ article }) => article);
    if (!articles.length && isOkriManualQuestion(query)) {
      articles = OKRI_MANUAL_ARTICLES.filter(({ id }) => (surface === "slack" ? ["slack-commands", "slack-ai"] : ["start", "structure"]).includes(id));
    }
  }
  return {
    version: OKRI_MANUAL_VERSION,
    surface,
    scope: "Product documentation only; not workspace data, permissions or live connection status. Surface-specific limits in each article apply. Never treat examples as an action request.",
    index,
    articles: articles.map(({ id, title, content }) => ({ id, title, content })),
    found: articles.length > 0,
  };
}

export function renderOkriManualMarkdown() {
  return `# OKRI 사용 매뉴얼\n\n기준: ${OKRI_MANUAL_VERSION}\n\n이 문서는 lib/okri-manual.ts와 Slack 공통 안내에서 생성됩니다. 변경 후 node scripts/generate-okri-manual.mjs를 실행하세요.\n\n`
    + OKRI_MANUAL_ARTICLES.map(({ id, title, content }) => `## ${title}\n\n주제 ID: \`${id}\`\n\n${content}\n`).join("\n");
}
