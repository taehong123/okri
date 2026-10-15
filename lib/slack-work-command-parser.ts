export const SLACK_WORK_COMMANDS = [
  "help", "my_work", "work_create",
  "project_create", "project_view", "project_edit", "project_status",
  "routine_create", "ticket_create",
  "task_create", "task_view", "task_edit", "task_complete", "task_reopen",
] as const;

export type SlackWorkCommand = (typeof SLACK_WORK_COMMANDS)[number];
export type ParsedSlackWorkCommand = { command: SlackWorkCommand; query: string };

const commandPatterns: Array<[SlackWorkCommand, RegExp]> = [
  ["help", /^!\s*(?:메뉴얼|매뉴얼|도움말|manual|help|okri)(?:\s+(.*))?$/iu],
  ["my_work", /^!\s*(?:내\s*업무|my\s*work)(?:\s+(.*))?$/iu],
  ["work_create", /^(?:!\s*)?(?:업무\s*생성|work\s+create)(?:\s+(.*))?$/iu],
  ["project_create", /^!\s*(?:프로젝트(?!\s*(?:조회|수정|상태)(?:\s|$))(?:\s*생성)?|project(?!\s+(?:view|edit|status)\b)(?:\s+create)?)(?:\s+(.*))?$/iu],
  ["project_view", /^!\s*(?:프로젝트\s*조회|project\s+view)(?:\s+(.*))?$/iu],
  ["project_edit", /^!\s*(?:프로젝트\s*수정|project\s+edit)(?:\s+(.*))?$/iu],
  ["project_status", /^!\s*(?:프로젝트\s*상태|project\s+status)(?:\s+(.*))?$/iu],
  ["routine_create", /^!\s*(?:루틴(?:\s*생성)?|routine(?:\s+create)?)(?:\s+(.*))?$/iu],
  ["ticket_create", /^!\s*(?:티켓(?:\s*생성)?|ticket(?:\s+create)?)(?:\s+(.*))?$/iu],
  ["task_create", /^!\s*(?:(?:테스크|태스크)(?!\s*(?:조회|수정|완료|재\s*열기)(?:\s|$))(?:\s*생성)?|task(?!\s+(?:view|edit|complete|reopen)\b)(?:\s+create)?)(?:\s+(.*))?$/iu],
  ["task_view", /^!\s*(?:(?:테스크|태스크)\s*조회|task\s+view)(?:\s+(.*))?$/iu],
  ["task_edit", /^!\s*(?:(?:테스크|태스크)\s*수정|task\s+edit)(?:\s+(.*))?$/iu],
  ["task_complete", /^!\s*(?:(?:테스크|태스크)\s*완료|task\s+complete)(?:\s+(.*))?$/iu],
  ["task_reopen", /^!\s*(?:(?:테스크|태스크)\s*재\s*열기|task\s+reopen)(?:\s+(.*))?$/iu],
];

export function parseSlackWorkCommand(input: string): ParsedSlackWorkCommand | null {
  const parsed = matchSlackWorkCommand(input);
  if (!parsed) return null;
  const query = isFormCreation(parsed.command) ? creationFields(parsed.content).title : parsed.content.slice(0, 240);
  return { command: parsed.command, query };
}

export function slackWorkCommandFormContent(input: string) {
  const parsed = matchSlackWorkCommand(input);
  return parsed && isFormCreation(parsed.command)
    ? { command: parsed.command, ...creationFields(parsed.content) }
    : null;
}

function matchSlackWorkCommand(input: string) {
  const normalized = input.normalize("NFC").replace(/\r\n?|\u2028|\u2029/g, "\n").trim();
  for (const [command, pattern] of commandPatterns) {
    // Match the command against its complete body, including pasted paragraphs.
    const match = normalized.match(new RegExp(pattern.source, `${pattern.flags}s`));
    if (match) return { command, content: (match[1] ?? "").trim() };
  }
  return null;
}

function isFormCreation(command: SlackWorkCommand) {
  return ["project_create", "routine_create", "ticket_create", "task_create"].includes(command);
}

function creationFields(content: string) {
  const title = content.split("\n")
    .map((line) => line.replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/giu, "").replace(/^\s*>+\s*/, "").trim())
    .find(Boolean)?.slice(0, 240) ?? "";
  return { title, description: content.includes("\n") || content.length > 240 ? content : "" };
}
