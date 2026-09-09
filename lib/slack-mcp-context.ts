const THREAD_SOURCE_REFERENCE = /(?:이\s*스레드|위\s*(?:스레드|내용|대화)|스레드\s*(?:전체|내용|원문)|앞선\s*(?:내용|대화)|논의(?:한)?\s*내용|이\s*내용|이거|이것|this\s+thread|the\s+thread|above|previous\s+(?:messages?|conversation))/iu;

export function referencesSlackThreadSource(value: string) {
  return THREAD_SOURCE_REFERENCE.test(value.normalize("NFC"));
}

export function slackCreationDetails(value: string) {
  return normalizeSlackText(value)
    .replace(/(?:이\s*스레드|스레드\s*전체|위\s*내용|이\s*내용|논의(?:한)?\s*내용|이거|이것|내용)/giu, " ")
    .replace(/(?:업무|일|작업|프로젝트|태스크|테스크|루틴|task|project|routine|thread)(?:\s*로|\s*으로)?/giu, " ")
    .replace(/(?:생성|만들어?|등록|정리|추가|읽고|바탕으로|기준으로|해\s*줘|해주세요|create|add|organize)/giu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

export function hasInlineSlackCreationDetails(value: string) {
  return slackCreationDetails(value).length >= 3;
}

export function hasSlackCreationSource(messages: string[], query: string, imageCount: number) {
  if (imageCount > 0) return true;
  const request = normalizeSlackText(query);
  return messages.some((message) => {
    const text = normalizeSlackText(message);
    return Boolean(text) && (text !== request || hasInlineSlackCreationDetails(text));
  });
}

export function slackThreadSourceMessages<T extends { user: string; text: string; ts?: string }>(
  messages: T[],
  eventTs: string,
  botUserId: string,
) {
  return messages.filter((message) => message.ts !== eventTs && message.user !== botUserId);
}

export function missingSlackThreadSourceMessage(hasThreadTs: boolean) {
  return hasThreadTs
    ? "Slack에서 원본 스레드 내용을 받지 못해 아무 업무도 저장하지 않았습니다. 해당 채널에 OKRI가 참여 중인지 확인한 뒤 같은 스레드에서 다시 불러 주세요."
    : "현재 @OKRI 호출이 원본 Slack 스레드 밖의 메시지로 들어와 위 내용을 읽을 수 없습니다. 아무 업무도 저장하지 않았습니다. 원본 스레드의 답글 입력창에서 @OKRI를 불러 주세요.";
}

function normalizeSlackText(value: string) {
  return value.replace(/<@[A-Z0-9]+>/gi, "").replace(/\s+/g, " ").trim().slice(0, 4_000);
}
