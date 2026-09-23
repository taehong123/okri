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
    description: "명령을 입력한 사람에게 확인 양식이 열립니다.",
    entries: [
      { command: "!프로젝트 [이름]", label: "Project", fields: "Initiative · DRI · 참여자 · 기한" },
      { command: "!루틴 [이름]", label: "Routine", fields: "주기 · 트리거 · 장소 · 실행 방법 · 담당자" },
      { command: "!티켓 [이름]", label: "Ticket", fields: "클라이언트 · 제품 · 상태 · 우선순위 · 기한" },
      { command: "!테스크 [이름]", label: "Task", fields: "Project·Ticket·Routine · 담당자 · 기한" },
    ],
  },
  {
    label: "말로 요청",
    description: "맥락을 설명하면 OKRI가 내용을 정리해 생성 초안을 제안합니다.",
    entries: [{ command: "@OKRI [요청]", label: "자연어 대화" }],
  },
  {
    label: "조회와 관리",
    description: "기존 Project와 Task를 Slack에서 확인하고 변경합니다.",
    entries: [
      { command: "!내업무", label: "내 업무" },
      { command: "!프로젝트조회 · !프로젝트수정 · !프로젝트상태", label: "Project 관리" },
      { command: "!테스크조회 · !테스크수정 · !테스크완료 · !테스크재열기", label: "Task 관리" },
      { command: "!도움말", label: "최신 사용법" },
    ],
  },
] as const;

type GuideTranslator = (key: string) => string;

export function slackWorkGuideText(t: GuideTranslator) {
  const lines = [
    `*${t("OKRI Slack 업무 매뉴얼")}*`,
    t("느낌표 명령은 양식을 열고, 말로 요청할 때는 @OKRI를 태그하세요."),
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
      text: { type: "mrkdwn", text: t("느낌표 명령은 양식을 열고, 말로 요청할 때는 @OKRI를 태그하세요.") },
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
      elements: [{ type: "mrkdwn", text: t("Ticket의 실행 담당자는 하위 Task에서 지정합니다. 연결 대상을 고르지 않은 Task는 General에 저장됩니다.") }],
    },
  ];
}
