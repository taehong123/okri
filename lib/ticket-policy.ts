/** Pure policy. Customer text can never grant capabilities or select a runner. */
export type TicketRisk = "blocked" | "review" | "low";
const DEVELOPMENT_ADVISORIES=new Set(['scope_ambiguous','sensitive_change']);
/** Approved, isolated code work may investigate business details; capabilities remain gated. */
export function ticketDevelopmentAdvisory(verdict:string,reported:unknown,codes:string[],approved:boolean){
  return approved&&verdict==='warning'&&Array.isArray(reported)&&reported.length>0&&reported.every(v=>typeof v==='string'&&DEVELOPMENT_ADVISORIES.has(v))&&codes.length>0&&codes.every(v=>DEVELOPMENT_ADVISORIES.has(v));
}
export const TICKET_PRIORITIES = ['urgent','high','medium','low'] as const;
export type TicketPriority = typeof TICKET_PRIORITIES[number];
export const TICKET_PRIORITY_LABELS:Record<TicketPriority,string>={urgent:'긴급',high:'높음',medium:'보통',low:'낮음'};
export const ticketPriorityRank=(value:string)=>Math.max(0,TICKET_PRIORITIES.indexOf(value as TicketPriority));
export type TicketAssessment = { risk: TicketRisk; reasons: string[]; candidate: boolean };
export function normalizedTicketText(text: string) {
  return text.normalize("NFKC").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, "");
}
export function redactTicketText(text: string) {
  const normalized=normalizedTicketText(text);
  const redacted=normalized.replace(/-----BEGIN [^-\r\n]{0,60}PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]{0,60}PRIVATE KEY-----|$)/gu,"[비밀정보 삭제]")
    .replace(/\b(?:sk|rk)-(?:proj-)?[A-Za-z0-9_-]{16,}|\bxox[baprs]-[A-Za-z0-9-]+|\bgh[pousr]_[A-Za-z0-9_]+|\bAKIA[A-Z0-9]{16}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[비밀정보 삭제]")
    .replace(/\bBearer\s+[^\s]+/giu, "Bearer [삭제]")
    .replace(/((?:api[_ -]?(?:key|키)|access[_ -]?token|password|secret|비밀\s*번호|비밀\s*키|인증\s*(?:토큰|코드))\s*[:：=]\s*)[^\s,;<>]+/giu, "$1[삭제]")
    .replace(/(https?:\/\/[^\s<>]*[?&](?:token|key|secret|password|code|signature|access_token)=)[^&\s<>]+/giu,"$1[삭제]");
  return redacted===normalized?text:redacted;
}
export function assessTicketText(raw: string): TicketAssessment {
  const text = normalizedTicketText(raw);
  const reasons: string[] = [];
  if (/(?:ignore|override|bypass|disregard).{0,60}(?:instruction|prompt|guard|policy|approval)|(?:system|developer)\s*(?:prompt|message)|(?:이전|시스템|개발자|보안).{0,20}(?:지시|프롬프트|정책).{0,20}(?:무시|우회|덮어)|(?:승인|보안).{0,12}(?:우회|비활성)|(?:jailbreak|prompt.?injection)/iu.test(text)) reasons.push("지시 또는 보안 경계 우회 시도");
  if (/(?:\.env\b|\.ssh\b|id_rsa|credential.?store|browser.?profile|private.?key|비밀.?키|인증.?토큰|비밀번호.{0,15}(?:보내|출력|조회|알려)|(?:secret|token|credential).{0,35}(?:exfiltrate|upload|send|dump)|(?:고객|사용자|전체).{0,15}(?:데이터|정보).{0,20}(?:추출|덤프|전송)|(?:curl|wget|powershell|bash|cmd\.exe)\s|base64.{0,30}(?:decode|디코딩)|169\.254\.169\.254|https?:\/\/(?:localhost|127\.|10\.|192\.168\.|\[::1\]))/iu.test(text)) reasons.push("비밀정보·외부 명령·내부망 접근 요청");
  if (redactTicketText(text) !== text || /-----BEGIN .{0,20}PRIVATE KEY-----/u.test(text)) reasons.push("비밀정보가 포함된 요청");
  const candidate = /개선|요청|수정|추가|오류|에러|버그|안\s*(?:돼|되)|불편|바꿔|변경|해주세요|해\s*주세요|fix|bug|request|improve|please|오타/iu.test(text);
  if (reasons.length) return { risk: "blocked", reasons, candidate: true };
  const sensitive = /인증|로그인|권한|결제|정산|개인정보|데이터|삭제|마이그레이션|배포|서버|보안|비밀번호|암호|API|auth|permission|payment|database|migration|deploy|delete|security|password|https?:\/\//iu.test(text);
  const cosmetic = /오타|문구|텍스트|맞춤법|띄어쓰기|색상|간격|정렬|스타일|글자|typo|wording|copy|spacing|alignment|style/iu.test(text);
  return { risk: cosmetic && !sensitive ? "low" : "review", reasons: sensitive ? ["민감 기능 또는 외부 링크가 포함되어 담당자 검토 필요"] : [], candidate };
}
export function canAutoApproveTicket(input: { mode: string; risk: TicketRisk; memberId?: string | null; portId?: string | null; hasAttachments?: boolean }) {
  return input.mode === "low_risk" && input.risk === "low" && Boolean(input.memberId && input.portId) && !input.hasAttachments;
}
export const TICKET_STATES = ["recommended", "created", "queued", "running", "waiting_answer", "security_review", "review", "publishing", "published", "blocked", "failed", "dismissed"] as const;
export type TicketState = typeof TICKET_STATES[number];
export const TICKET_STATE_LABELS: Record<TicketState, string> = {
  recommended: "추천 검토", created: "개발 승인 대기", queued: "실행 대기", running: "진행 중", waiting_answer: "답변 대기",
  security_review: "작업 내용 확인", review: "완료 공유 대기",publishing:'완료 안내 전송 대기', published: "공유 완료", blocked: "보안 차단", failed: "확인 필요", dismissed: "제외",
};
export function escapeSlackText(text: string) { return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
