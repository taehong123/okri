import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareTicketNodeCache} from '../public/local-agent/prepare-ticket-node-cache.mjs';
import {CodexAppServer,sanitizedCodexEnvironment} from '../public/local-agent/okri-local-agent.mjs';
// Manual executor integration check; a local file dependency needs no registry.
const root=await mkdtemp(join(tmpdir(),'okri-cache-fixture-'));
await mkdir(join(root,'vendor','dependency'),{recursive:true});
await writeFile(join(root,'vendor','dependency','package.json'),JSON.stringify({name:'okri-check',version:'1.0.0',main:'index.cjs'}));
await writeFile(join(root,'vendor','dependency','index.cjs'),'module.exports=42;');
await writeFile(join(root,'package.json'),JSON.stringify({name:'cache-fixture',version:'1.0.0',dependencies:{'okri-check':'file:vendor/dependency'}}));
await writeFile(join(root,'package-lock.json'),JSON.stringify({name:'cache-fixture',version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':{name:'cache-fixture',version:'1.0.0',dependencies:{'okri-check':'file:vendor/dependency'}},'node_modules/okri-check':{resolved:'vendor/dependency',link:true},'vendor/dependency':{name:'okri-check',version:'1.0.0'}}}));
await mkdir(join(root,'backend'));
await writeFile(join(root,'backend','go.mod'),'module example.com/cachecheck\n\ngo 1.25.0\n');
await writeFile(join(root,'backend','main_test.go'),'package cachecheck\nimport "testing"\nfunc TestValue(t *testing.T){if 6*7!=42{t.Fatal("wrong value")}}\n');
let preparations=0;
const options={image:'okri-ticket-codex:0.4.0',repositoryRemote:`https://github.com/fixture/${root.split(/[\\/]/).at(-1)}`,installRoots:['.','backend'],environment:sanitizedCodexEnvironment(),snapshotFactory:async()=>{preparations++;return root;}};
const [a,b]=await Promise.all([prepareTicketNodeCache(root,options),prepareTicketNodeCache(root,options)]);
assert.equal(preparations,1);assert.deepEqual(a,b);assert.ok(a.some(m=>m.path==='.okri-go/pkg/mod'));
const server=new CodexAppServer(root,{docker:true,auth:false,dependencyMounts:a});
try{
  await server.start();const result=await server.request('command/exec',{cwd:'/workspace',permissionProfile:'okri_ticket',timeoutMs:5000,command:['node','-e',`const fs=require('fs');let denied=false;try{fs.writeFileSync('node_modules/injected.js','bad')}catch{denied=true}console.log(JSON.stringify({loaded:require('okri-check')===42,writeDenied:denied}))`]});
  const report=JSON.parse(result.stdout.trim());assert.equal(report.loaded,true);assert.equal(report.writeDenied,true);console.log(JSON.stringify({singlePreparation:true,sharedCache:true,...report}));
  const cache=await server.request('command/exec',{cwd:'/workspace',permissionProfile:'okri_ticket',timeoutMs:5000,command:['node','-e',`try{require('fs').writeFileSync('.okri-go/pkg/mod/injected.txt','bad');process.exit(1)}catch{console.log('go cache is read-only')}`]});assert.equal(cache.exitCode,0);assert.match(cache.stdout,/read-only/);
  const go=await server.request('command/exec',{cwd:'/workspace/backend',permissionProfile:'okri_ticket',timeoutMs:60000,command:['go','test','-p=2','.']});assert.equal(go.exitCode,0,go.stderr);console.log(JSON.stringify({goTestPassed:true}));
}finally{server.stop();}
