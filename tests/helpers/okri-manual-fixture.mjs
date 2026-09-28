import { readFile } from "node:fs/promises";
import { compileLanguageModule as compile } from "./language-fixture.mjs";

export const slackGuide = compile(await readFile(new URL("../../lib/slack-work-command-guide.ts", import.meta.url), "utf8"));
export const okriManual = compile(await readFile(new URL("../../lib/okri-manual.ts", import.meta.url), "utf8"), {
  "./slack-work-command-guide": slackGuide,
});
