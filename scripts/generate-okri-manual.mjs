import { readFile, writeFile } from "node:fs/promises";
import ts from "typescript";

function compile(source, dependencies = {}) {
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", js)((name) => {
    if (!(name in dependencies)) throw new Error(`Unexpected manual dependency: ${name}`);
    return dependencies[name];
  }, loaded, loaded.exports);
  return loaded.exports;
}

const guide = compile(await readFile(new URL("../lib/slack-work-command-guide.ts", import.meta.url), "utf8"));
const manual = compile(await readFile(new URL("../lib/okri-manual.ts", import.meta.url), "utf8"), {
  "./slack-work-command-guide": guide,
});
const target = new URL("../docs/OKRI_MANUAL.md", import.meta.url);
const markdown = manual.renderOkriManualMarkdown();
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")).replaceAll("\r\n", "\n") !== markdown) {
    throw new Error("OKRI manual is stale. Run node scripts/generate-okri-manual.mjs.");
  }
} else {
  await writeFile(target, markdown);
}
console.log("OKRI manual is synchronized.");
