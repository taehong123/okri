/**
 * OpenAI commonly returns CommonMark while Slack's message `text` uses its
 * mrkdwn dialect. Convert only balanced presentation markers, leaving all
 * ordinary user text untouched.
 */
export function formatSlackMrkdwn(value: string) {
  return value
    // Escaped CommonMark is what users otherwise see as `\*\*제목:\*\*`.
    .replace(/\\\*\\\*([^*\n]+?)\\\*\\\*/g, "*$1*")
    .replace(/\*\*([^*\n]+?)\*\*/g, "*$1*")
    .replace(/\\\*([^*\n]+?)\\\*/g, "*$1*")
    .replace(/^[\t ]*\\-\s+/gm, "• ");
}
