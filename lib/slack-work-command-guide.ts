export type SlackWorkGuideEntry = {
  command: string;
  label: string;
  fields?: string;
};

export type SlackWorkGuideGroup = {
  label: string;
  description: string;
  entries: readonly SlackWorkGuideEntry[];
};

export const SLACK_WORK_GUIDE_GROUPS: readonly SlackWorkGuideGroup[] = [
  {
    label: "양식으로 추가",
    description: "같은 스레드에 남는 '양식 열기' 버튼을 누르면 명령을 입력한 사람에게 확인 양식이 열립니다. 제출 전에는 생성되지 않습니다.",
    entries: [
      { command: "!프로젝트 [이름]", label: "Project", fields: "Initiative · DRI · 참여자 · 기한" },
      { command: "!루틴 [이름]", label: "Routine", fields: "주기 · 트리거 · 장소 · 실행 방법 · 담당자" },
      { command: "!티켓 [이름]", label: "Ticket", fields: "클라이언트 · 제품 · 상태(기본: 처리 대기) · 우선순위 · 기한" },
      { command: "!테스크 [이름]", label: "Task", fields: "Project·Ticket·Routine · 담당자 · 기한" },
    ],
  },
  {
    label: "말로 요청",
    description: "같은 스레드에서 다 반영해·남은 것도 처리해로 실행을 이어갑니다. Project 생성안을 다음 답장에서 승인하면 하위 Task도 처리하고, 기존 Task의 잘못된 소속은 중복 생성 없이 수정합니다.",
    entries: [
      { command: "@OKRI [요청]", label: "자연어 대화" },
      { command: "!업무생성 [내용]", label: "업무 생성" },
    ],
  },
  {
    label: "조회와 관리",
    description: "기존 Project와 Task를 Slack에서 확인하고 변경합니다.",
    entries: [
      { command: "!내업무", label: "내 업무" },
      { command: "!프로젝트조회 · !프로젝트수정 · !프로젝트상태", label: "Project 관리" },
      { command: "!테스크조회 · !테스크수정 · !테스크완료 · !테스크재열기", label: "Task 관리" },
      { command: "!도움말", label: "최신 사용법" },
      { command: "/okri daily", label: "개인 데일리 작성", fields: "라디오 선택 · 오늘 꼭 할 일 / 여유되면 할 일" },
    ],
  },
] as const;

type GuideTranslator = (key: string) => string;
export const SLACK_TICKET_AUTOMATION_GUIDE = "고객 채널 자동화는 웹의 Ticket > 티켓 자동화에서 설정합니다. 개발 승인 후 포트에서 보안 검증하며, 완료 안내는 문안 승인 후 지정한 요청자를 태그해 원문 스레드에 공유합니다.";
export const SLACK_TICKET_SETUP_GUIDE = "제품 명세·Git 저장소·PC 준비 지침과 기본 모델을 설정하고, PC별 포트 개수를 정해 본인의 Codex에 연결합니다. 선행 작업 반영 후 긴급·높음·보통·낮음 순으로 검토합니다. 중계 앱은 허용한 봇의 수신 본문만 분석하며, 완료 공유 전 실제 Slack 요청자를 지정합니다. 포트는 검토용 패치를 준비하고 실제 병합·배포는 별도 승인합니다.";
export const SLACK_TICKET_CLASSIFICATION_GUIDE = "감사·확인 대화와 단순 발송 결과는 추천에서 제외합니다. AI 요청 판별이 불가하면 자동 승인 없이 수동 검토로 남깁니다.";

export function slackWorkGuideText(t: GuideTranslator) {
  const lines = [
    `*${t("OKRI Slack 업무 매뉴얼")}*`,
    t("느낌표 명령은 양식을 열고, 말로 요청할 때는 @OKRI를 태그하세요."),
    t("여러 줄 요청도 가능합니다. 첫 내용 줄은 제목, 전체 내용은 설명에 채워집니다."),
    t("!티켓생성은 스레드 전체를 읽어 제목·설명을 채웁니다. 내용을 확인하고 제출하면 생성됩니다."),
    t("느낌표 명령은 봇이 참여한 채널에서만 수신됩니다. 채널에 OKRI 앱을 한 번 초대해 주세요."),
    t(SLACK_TICKET_AUTOMATION_GUIDE),
    t(SLACK_TICKET_SETUP_GUIDE),
    t(SLACK_TICKET_CLASSIFICATION_GUIDE),
  ];
  for (const group of SLACK_WORK_GUIDE_GROUPS) {
    lines.push("", `*${t(group.label)}*`, t(group.description));
    for (const entry of group.entries) {
      lines.push(`• \`${entry.command}\` — ${t(entry.label)}${entry.fields ? ` · ${t(entry.fields)}` : ""}`);
    }
  }
  lines.push("", `_${t("Ticket의 실행 담당자는 하위 Task에서 지정합니다. 연결 대상을 고르지 않은 Task는 General에 저장됩니다.")}_`);
  return lines.join("\n");
}

export function slackWorkGuideBlocks(t: GuideTranslator) {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: t("OKRI Slack 업무 매뉴얼") },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `${t("느낌표 명령은 양식을 열고, 말로 요청할 때는 @OKRI를 태그하세요.")}\n${t("여러 줄 요청도 가능합니다. 첫 내용 줄은 제목, 전체 내용은 설명에 채워집니다.")}\n${t("!티켓생성은 스레드 전체를 읽어 제목·설명을 채웁니다. 내용을 확인하고 제출하면 생성됩니다.")}\n${t("느낌표 명령은 봇이 참여한 채널에서만 수신됩니다. 채널에 OKRI 앱을 한 번 초대해 주세요.")}` },
    },
    ...SLACK_WORK_GUIDE_GROUPS.map((group) => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*${t(group.label)}*`,
          t(group.description),
          ...group.entries.map((entry) => `• \`${entry.command}\` — ${t(entry.label)}${entry.fields ? ` · ${t(entry.fields)}` : ""}`),
        ].join("\n"),
      },
    })),
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `${t("Ticket의 실행 담당자는 하위 Task에서 지정합니다. 연결 대상을 고르지 않은 Task는 General에 저장됩니다.")}\n${t(SLACK_TICKET_AUTOMATION_GUIDE)}` },{type:'mrkdwn',text:t(SLACK_TICKET_SETUP_GUIDE)},{type:'mrkdwn',text:t(SLACK_TICKET_CLASSIFICATION_GUIDE)}],
    },
  ];
}
