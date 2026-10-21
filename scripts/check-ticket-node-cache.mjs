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
let preparations=0;
const options={image:'okri-ticket-codex:0.3.0',repositoryRemote:`https://github.com/fixture/${root.split(/[\\/]/).at(-1)}`,environment:sanitizedCodexEnvironment(),snapshotFactory:async()=>{preparations++;return root;}};
const [a,b]=await Promise.all([prepareTicketNodeCache(root,options),prepareTicketNodeCache(root,options)]);
assert.equal(preparations,1);assert.deepEqual(a,b);assert.ok(a.length);
const server=new CodexAppServer(root,{docker:true,auth:false,dependencyMounts:a});
try{
  await server.start();const result=await server.request('command/exec',{cwd:'/workspace',permissionProfile:'okri_ticket',timeoutMs:5000,command:['node','-e',`const fs=require('fs');let denied=false;try{fs.writeFileSync('node_modules/injected.js','bad')}catch{denied=true}console.log(JSON.stringify({loaded:require('okri-check')===42,writeDenied:denied}))`]});
  const report=JSON.parse(result.stdout.trim());assert.equal(report.loaded,true);assert.equal(report.writeDenied,true);console.log(JSON.stringify({singlePreparation:true,sharedCache:true,...report}));
}finally{server.stop();}
