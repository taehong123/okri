import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexAppServer } from '../public/local-agent/okri-local-agent.mjs';
const directory = await mkdtemp(join(tmpdir(),'okri-ticket-sandbox-check-'));
await writeFile(join(directory,'allowed.txt'),'test fixture');
const server = new CodexAppServer(directory,{docker:true,auth:false});
try {
  await server.start();
  const response = await server.request('command/exec',{
    cwd:'/workspace',permissionProfile:'okri_ticket',timeoutMs:5000,
    command:['node','-e',`const fs=require('fs'),net=require('net');const r={};
      try{fs.writeFileSync('/workspace/verified.txt','ok');r.write=true}catch{r.write=false}
      try{fs.readFileSync('/home/node/.bashrc');r.outsideRead=true}catch{r.outsideRead=false}
      const c=net.connect({host:'1.1.1.1',port:443});
      c.on('connect',()=>{r.network=true;c.destroy();console.log(JSON.stringify(r))});
      c.on('error',e=>{r.network=false;r.networkError=e.code;console.log(JSON.stringify(r))});
      c.setTimeout(2000,()=>{c.destroy();console.log(JSON.stringify({...r,network:'timeout'}))});`],
  });
  assert.equal(response.exitCode,0,JSON.stringify(response));
  const result=JSON.parse(response.stdout.trim());
  assert.equal(result.write,true);assert.equal(result.outsideRead,false);assert.equal(result.network,false);
  assert.ok(['EPERM','EACCES','ENETUNREACH'].includes(result.networkError),JSON.stringify(result));
  const readOnly = await server.request('command/exec',{cwd:'/workspace',permissionProfile:'okri_ticket_review',command:['node','-e',"try{require('fs').writeFileSync('/workspace/forbidden.txt','no');process.exit(1)}catch{console.log('read-only enforced')}"],timeoutMs:5000});
  assert.equal(readOnly.exitCode,0,JSON.stringify(readOnly));
  console.log(JSON.stringify({snapshotWrite:true,outsideReadDenied:true,networkDenied:true,reviewWriteDenied:true}));
} finally {server.stop();}
