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
      { command: "/okri ticket [검색어] · !티켓관리", label: "Slack 티켓 운영", fields: "원문·분류·해결안 · 담당자·포트 · 승인·완료 안내 · 수집 점검" },
      { command: "!프로젝트조회 · !프로젝트수정 · !프로젝트상태", label: "Project 관리" },
      { command: "!테스크조회 · !테스크수정 · !테스크완료 · !테스크재열기", label: "Task 관리" },
      { command: "!도움말", label: "최신 사용법" },
      { command: "/okri daily", label: "개인 데일리 작성", fields: "라디오 선택 · 오늘 꼭 할 일 / 여유되면 할 일" },
    ],
  },
] as const;

type GuideTranslator = (key: string) => string;
export const SLACK_TICKET_AUTOMATION_GUIDE = "고객 채널과 제품·포트 연결 후 /okri ticket 또는 !티켓관리로 Slack에서 운영합니다. 고객사·요청자·요구사항·분류를 먼저 보여주며 개발 시작에서 담당자와 자동 배정을 한 번 확인합니다. 생성·배정·개발 승인을 함께 처리하고, 단순 안내는 문안과 요청자를 확인하여 바로 회신합니다. 담당자의 답변·진행 안내·설정 정보 요청은 새 티켓으로 만들지 않고 기존 요청의 문맥으로 반영합니다. 담당자의 실제 새 문제 제보와 고객 요구 전달은 분석합니다. 추천 카드는 기존 메시지에서 갱신합니다. 내용·담당자·포트 수정, 질문 답변, 보안 경고 확인, 완료 문안 수정·공유를 같은 티켓에 반영합니다. 완료 안내는 최종 승인 후 지정한 요청자를 태그합니다.";
export const SLACK_TICKET_SETUP_GUIDE = "제품 명세·Git 저장소·PC 준비 지침과 기본 모델을 설정하고, PC별 포트 개수를 정해 본인의 Codex에 연결합니다. 선행 작업 반영 후 긴급·높음·보통·낮음 순으로 검토합니다. 중계 앱은 허용한 봇의 수신 본문만 분석하며, 완료 공유 전 실제 Slack 요청자를 지정합니다. 포트는 검토용 패치를 준비하고 실제 병합·배포는 별도 승인합니다.";
export const SLACK_TICKET_CLASSIFICATION_GUIDE = "원문 아래에 버그 픽스·기능 개선·기능 추가·단순 안내로 분류하고 고객의 문제와 해결안을 제안합니다. 단순 안내는 개발 없이 문안 승인을 거칩니다. 활성화 시점 이후의 새 원문을 먼저 저장하고 분석 실패를 재시도합니다. 흩어진 메시지는 같은 고객·제품 안에서 문제별로 묶고, 연결된 댓글의 변경분을 주기적으로 확인합니다. 같은 원문에 이미 연결된 티켓의 짧은 확인 응답은 AI를 다시 호출하지 않고 원문 그대로 덧붙입니다. 해결 완료나 개발 승인으로 해석하지 않으며 새 내용·첨부·명시적 재검토는 정상 분석합니다. 해결·상태 댓글은 기존 티켓에 근거와 함께 갱신하며 새 개발을 시작하거나 완료 안내를 자동 승인하지 않습니다. 범위 변경은 다시 승인이 필요합니다. 제외 사유와 미처리 상태도 수집 점검에서 확인합니다. 분석 한도로 중단되면 수집은 계속하고, 공유를 허용한 관리 채널에 중단 이유와 자동 재개 시점을 하루 한 번 알립니다.";

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
