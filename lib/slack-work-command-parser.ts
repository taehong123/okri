export const SLACK_WORK_COMMANDS = [
  "help", "my_work", "work_create",
  "project_create", "project_view", "project_edit", "project_status",
  "task_create", "task_view", "task_edit", "task_complete", "task_reopen",
] as const;

export type SlackWorkCommand = (typeof SLACK_WORK_COMMANDS)[number];
export type ParsedSlackWorkCommand = { command: SlackWorkCommand; query: string };

const commandPatterns: Array<[SlackWorkCommand, RegExp]> = [
  ["help", /^!\s*(?:메뉴얼|매뉴얼|도움말|manual|help|okri)(?:\s+(.*))?$/iu],
  ["my_work", /^!\s*(?:내\s*업무|my\s*work)(?:\s+(.*))?$/iu],
  ["work_create", /^(?:!\s*)?(?:업무\s*생성|work\s+create)(?:\s+(.*))?$/iu],
  ["project_create", /^!\s*(?:프로젝트\s*생성|project(?!\s+(?:view|edit|status)\b)(?:\s+create)?)(?:\s+(.*))?$/iu],
  ["project_view", /^!\s*(?:프로젝트\s*조회|project\s+view)(?:\s+(.*))?$/iu],
  ["project_edit", /^!\s*(?:프로젝트\s*수정|project\s+edit)(?:\s+(.*))?$/iu],
  ["project_status", /^!\s*(?:프로젝트\s*상태|project\s+status)(?:\s+(.*))?$/iu],
  ["task_create", /^!\s*(?:(?:테스크|태스크)\s*생성|task(?!\s+(?:view|edit|complete|reopen)\b)(?:\s+create)?)(?:\s+(.*))?$/iu],
  ["task_view", /^!\s*(?:(?:테스크|태스크)\s*조회|task\s+view)(?:\s+(.*))?$/iu],
  ["task_edit", /^!\s*(?:(?:테스크|태스크)\s*수정|task\s+edit)(?:\s+(.*))?$/iu],
  ["task_complete", /^!\s*(?:(?:테스크|태스크)\s*완료|task\s+complete)(?:\s+(.*))?$/iu],
  ["task_reopen", /^!\s*(?:(?:테스크|태스크)\s*재\s*열기|task\s+reopen)(?:\s+(.*))?$/iu],
];

export function parseSlackWorkCommand(input: string): ParsedSlackWorkCommand | null {
  const normalized = input.normalize("NFC").trim();
  for (const [command, pattern] of commandPatterns) {
    const match = normalized.match(pattern);
    if (match) return { command, query: (match[1] ?? "").trim().slice(0, 240) };
  }
  return null;
}
