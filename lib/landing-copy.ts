import { ANONYMOUS_LANGUAGE_KEY, languages, isLanguage, resolveLanguage, formatLocale } from "./language";
export const LANDING_LANGUAGE_KEY = ANONYMOUS_LANGUAGE_KEY;
export const landingLanguages = languages;

export type LandingLanguage = (typeof landingLanguages)[number]["id"];
export type LandingExampleKind = "okr" | "connection" | "conversation" | "slack";
export type LandingSlide = { title: string; description: string; example: LandingExampleKind };
export type LandingExampleContent = {
  objective: string; keyResult: string; initiative: string; project: string; task: string; secondTask: string;
  objectiveLabel: string; keyResultLabel: string; initiativeLabel: string; projectLabel: string; taskLabel: string;
  current: string; target: string; currentValue: string; targetValue: string; inProgress: string;
  request: string; proposal: string; review: string;
  daily: string; dailyDetail: string; management: string; managementDetail: string;
  work: string; changes: string; changesDetail: string;
};
type LandingCopy = {
  language: string; carousel: string; slide: string; previous: string; next: string;
  heroTitle: string; heroDescription: string;
  login: string; loggingIn: string; loginNote: string; loginError: string; unavailable: string;
  sourceLabel: string; exampleSource: string; google: string; intel: string; mcp: string; slack: string;
  example: LandingExampleContent;
  slides: readonly [LandingSlide, LandingSlide, LandingSlide, LandingSlide];
};

export function resolveLandingLanguage(saved: string | null, browserLanguages: readonly string[]): LandingLanguage {
  return isLanguage(saved) ? saved : resolveLanguage(browserLanguages);
}

export function getLandingCopy(translate: (key: string) => string, language: LandingLanguage = "ko"): LandingCopy {
  const percent = new Intl.NumberFormat(formatLocale(language), { style: "percent", maximumFractionDigits: 0 });
  const integer = new Intl.NumberFormat(formatLocale(language));
  return {
    language: translate("안내 언어"), carousel: translate("OKRI 소개"),
    slide: translate("슬라이드"), previous: translate("이전 슬라이드"), next: translate("다음 슬라이드"),
    heroTitle: translate("목표부터 오늘 할 일까지."),
    heroDescription: translate("검증된 OKR로 목표를 세우고, 모든 업무와 성과의 연결을 확인하세요."),
    login: translate("Google로 시작하기"), loggingIn: translate("Google로 이동 중"),
    loginNote: translate("기존 계정은 로그인, 처음이면 가입합니다."),
    loginError: translate("Google 로그인을 완료하지 못했습니다. 다시 시도해 주세요."),
    unavailable: translate("Google 로그인 설정을 완료하는 중입니다."),
    sourceLabel: translate("예시 출처"),
    exampleSource: translate("Healthcare.gov의 Objective와 Key Result는 공개 사례를 번역했고, Initiative 이하는 OKRI 구조에 맞춰 구성했습니다."),
    google: translate("Google의 OKR 이야기"), intel: translate("Intel의 OKR 사례"),
    mcp: translate("MCP로 사용 중인 AI에서도 이어가세요."),
    slack: translate("Slack 승인 후 알림 대상과 시간을 설정하세요."),
    example: {
      objective: translate("대다수 사람이 Healthcare.gov에서 보험 가입을 완료할 수 있게 한다."),
      keyResult: translate("보험 가입 완료율을 70%까지 높인다."),
      initiative: translate("가입 경험의 안정성과 속도를 개선한다."),
      project: translate("보험 가입 흐름의 병목을 제거한다."),
      task: translate("가입 실패 로그를 원인별로 분류한다."),
      secondTask: translate("응답 지연이 발생하는 구간을 점검한다."),
      objectiveLabel: translate("Objective"), keyResultLabel: translate("Key Result"),
      initiativeLabel: translate("Initiative"), projectLabel: translate("Project"), taskLabel: translate("Task"),
      current: translate("출시 당시 가입 성공"), target: translate("목표 완료율"), currentValue: `3 / ${integer.format(100000)}`, targetValue: percent.format(0.7),
      inProgress: translate("진행 중"), request: translate("Healthcare.gov의 가입 완료율을 높일 Project로 정리해줘."),
      proposal: translate("Project 제안"), review: translate("등록 전 검토"),
      daily: translate("데일리 봇"), dailyDetail: translate("오늘 할 일과 완료한 일"),
      management: translate("관리 봇"), managementDetail: translate("누락된 담당자·기한 확인"),
      work: translate("업무 관리 봇"), changes: translate("Task 변동 알림 봇"), changesDetail: translate("Task의 변경사항 알림"),
    },
    slides: [
      {
        title: translate("세계적인 기업들이 선택한 OKR."),
        description: translate("구글과 인텔이 활용해 온 목표 관리 방식. 이제 우리 팀에서도."),
        example: "okr",
      },
      {
        title: translate("내 일이 어떤 성과와 연결되는지."),
        description: translate("목표부터 개별 Task까지, 일의 목적과 진행 상황을 함께 보세요."),
        example: "connection",
      },
      {
        title: translate("대화로 정리하고, 확인 후 등록하세요."),
        description: translate("AI와 업무를 정리하고, 제안을 확인한 뒤 Project로 만드세요."),
        example: "conversation",
      },
      {
        title: translate("Slack 연결은 버튼 하나로."),
        description: translate("데일리 스크럼, 누락 확인, Task 생성과 변경 알림을 한곳에서."),
        example: "slack",
      },
    ],
  };
}
