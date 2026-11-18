import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const code=ts.transpileModule(await readFile(new URL("../app/kr-trend-model.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const model={};new Function("exports",code)(model);
const p=(value,extra={})=>({id:crypto.randomUUID(),source:"projects",eventKind:"completed",currentValue:value,baselineValue:0,targetValue:100,unit:"명",observedAt:new Date().toISOString(),...extra});
test("KR signals describe observed movement toward either increasing or decreasing targets",()=>{
  assert.equal(model.krTrendSignal([p(20),p(28)]),"improving");
  assert.equal(model.krTrendSignal([p(28),p(20)]),"declining");
  assert.equal(model.krTrendSignal([p(28),p(28)]),"steady");
  assert.equal(model.krTrendSignal([p(90),p(110)]),"reached");
  assert.equal(model.krTrendSignal([p(80,{baselineValue:100,targetValue:0}),p(60,{baselineValue:100,targetValue:0})]),"improving");
  assert.equal(model.krTrendSignal([p(60,{baselineValue:100,targetValue:0}),p(80,{baselineValue:100,targetValue:0})]),"declining");
});
test("missing, single and failed records do not invent a direction",()=>{
  assert.equal(model.krTrendSignal([]),"insufficient");
  assert.equal(model.krTrendSignal([p(20)]),"insufficient");
  assert.equal(model.krTrendSignal([p(20),p(28)],true),"error");
  assert.deepEqual(model.krTrendSegments([p(null)],"명"),[]);
});
test("source, unit, baseline and goal changes split historical lines",()=>{
  const history=[p(20),p(28),p(null,{source:"api",eventKind:"settings"}),p(30,{source:"api"}),p(35,{source:"api"}),p(40,{source:"api",targetValue:200}),p(60,{source:"api",targetValue:200}),p(70,{unit:"원"})];
  const segments=model.krTrendSegments(history,"명");
  assert.deepEqual(segments.map(s=>s.map(p=>p.currentValue)),[[20,28],[30,35],[40,60]]);
  assert.equal(model.krTrendSignal(segments.at(-1)),"improving");
});
test("the last day uses its final real sample without filling missing dates",()=>{
  const segments=model.krTrendSegments([p(20,{observedAt:"2026-11-01T01:00:00Z"}),p(28,{observedAt:"2026-11-01T02:00:00Z"}),p(30,{observedAt:"2026-11-10T01:00:00Z"})],"명",true);
  assert.deepEqual(segments[0].map(p=>p.currentValue),[28,30]);
});
test("a source switch without a new measurement never reuses the previous source's signal",()=>{
  const history=[p(20),p(28),p(null,{source:"api",eventKind:"settings"})];
  assert.deepEqual(model.latestKrTrendSegment(history,"명","api",100),[]);
  assert.deepEqual(model.latestKrTrendSegment([p(20),p(28)],"명","api",100),[]);
  assert.deepEqual(model.latestKrTrendSegment([p(20),p(28)],"명","projects",200),[]);
  assert.deepEqual(model.latestKrTrendSegment([p(20),p(28)],"명",null),[]);
});
