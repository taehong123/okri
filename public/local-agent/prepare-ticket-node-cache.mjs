import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,realpath,open,unlink,stat,writeFile} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';

// Preparation has no Codex authentication, device token, host home or Docker socket.
// Only sanitized source enters the installer. Project install scripts stay disabled.
export async function prepareTicketNodeCache(root,{image,environment,snapshotFactory,snapshotCleanup,repositoryRemote,installRoots=['.']}) {
  const canonicalRoot=await realpath(root),hash=createHash('sha256').update('okri-dependencies-v2').update(image).update(repositoryRemote),roots=[];
  for(const directory of installRoots){
    if(!directory||(directory.startsWith('/')||directory.startsWith('\\')||/[:\p{Cc}]/u.test(directory))||directory.replaceAll('\\','/').split('/').some(p=>p==='..'||/^\.(?:git|env|ssh|codex|aws)$/.test(p)))throw new Error('Dependency installation paths must stay inside the selected repository.');
    const actual=await realpath(join(root,directory)).catch(()=>null);if(!actual)continue;const scope=relative(canonicalRoot,actual);if(scope.startsWith('..')||isAbsolute(scope))throw new Error('Dependency installation path leaves the selected repository.');
    const lock=await readFile(join(actual,'package-lock.json')).catch(()=>null),manifest=await readFile(join(actual,'package.json')).catch(()=>null),go=await readFile(join(actual,'go.mod')).catch(()=>null),sum=await readFile(join(actual,'go.sum')).catch(()=>null);
    if((!lock||!manifest)&&!go)continue;
    hash.update(directory).update(lock||'').update(manifest||'').update(go||'').update(sum||'');roots.push({directory,node:Boolean(lock&&manifest),go:Boolean(go)});
  }
  if(!roots.length)return [];
  const key=hash.digest('hex');
  const volume=`okri-ticket-cache-${key.slice(0,24)}`;
  const lockPath=join(tmpdir(),`okri-ticket-cache-${key}.lock`),failurePath=`${lockPath}.failed.json`;
  async function docker(args,{input='',allowFailure=false}={}) {
    return new Promise((resolve,reject)=>{
      const child=spawn('docker',args,{windowsHide:true,env:environment,stdio:['pipe','pipe','pipe']});let output='',errors='';
      child.stdout.on('data',d=>{output=(output+d).slice(-300000);});child.stderr.on('data',d=>{errors=(errors+d).slice(-10000);});
      const timer=setTimeout(()=>{child.kill();reject(new Error('Product dependency preparation timed out.'));},300000);
      child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);if(code===0||allowFailure)resolve({code,output});else reject(new Error(`Product dependency preparation failed (${errors.match(/npm error code ([A-Z0-9_]+)/)?.[1]||code}). No credentials were mounted.`));});
      child.stdin.end(input);
    });
  }
  const options=['run','--rm','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','256','--memory','4g','--cpus','2','--mount',`type=volume,source=${volume},target=/workspace`];
  const cached=await docker([...options,'--network','none','--entrypoint','node',image,'-e',"process.stdout.write(require('fs').readFileSync('/workspace/.okri-cache-ready.json','utf8'))"],{allowFailure:true});
  if(cached.code===0){try{const ready=JSON.parse(cached.output);if(ready.key===key)return ready.mounts.map(path=>({volume,path}));}catch{/* incomplete cache is rebuilt */}}
  let lock;
  for(let attempt=0;attempt<360;attempt++){
    try{lock=await open(lockPath,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:Date.now()}));break;}catch(error){if(error.code!=='EEXIST')throw error;}
    const info=await stat(lockPath).catch(()=>null);
    if(!info)continue;
    if(Date.now()-info.mtimeMs>360000){const owner=JSON.parse(await readFile(lockPath,'utf8').catch(()=>'{}'));let alive=true;try{process.kill(owner.pid,0);}catch(error){alive=error.code!=='ESRCH';}if(!alive){await unlink(lockPath).catch(()=>undefined);continue;}throw new Error('Another port is still preparing this product. Retry after it finishes.');}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  if(!lock)throw new Error('Another port is still preparing this product.');
  const name=`okri-ticket-prepare-${randomUUID()}`;
  let preparedSnapshot,cachedFailure=false;
  try{
    const ready=await docker([...options,'--network','none','--entrypoint','node',image,'-e',"process.stdout.write(require('fs').readFileSync('/workspace/.okri-cache-ready.json','utf8'))"],{allowFailure:true});
    if(ready.code===0){const parsed=JSON.parse(ready.output);if(parsed.key===key)return parsed.mounts.map(path=>({volume,path}));}
    let failure={};try{failure=JSON.parse(await readFile(failurePath,'utf8'));}catch{/* no recent failure */}
    if(failure.time&&Date.now()-failure.time<60000){cachedFailure=true;throw new Error(failure.message||'Product dependency preparation failed.');}
    const snapshot=await snapshotFactory(root);preparedSnapshot=snapshot;
    const script=`import{cp,writeFile,readdir,mkdir}from'node:fs/promises';import{spawn}from'node:child_process';import{join,relative}from'node:path';
      await cp('/source','/workspace',{recursive:true,force:true,filter:p=>!p.split('/').includes('.git')});
      const roots=${JSON.stringify(roots)};
      async function run(command,args,directory){await new Promise((ok,no)=>{const p=spawn(command,args,{cwd:join('/workspace',directory),stdio:'inherit',env:{...process.env,GIT_TERMINAL_PROMPT:'0',NPM_CONFIG_IGNORE_SCRIPTS:'true',GOPROXY:'https://proxy.golang.org',GOSUMDB:'sum.golang.org',GOTOOLCHAIN:'local'}});p.once('error',no);p.once('exit',c=>c===0?ok():no(new Error('Dependency installation failed')))})}
      for(const root of roots){if(root.node)await run('npm',['ci','--ignore-scripts','--include=dev','--no-audit','--no-fund'],root.directory);if(root.go)await run('go',['mod','download'],root.directory);}
      const mounts=[];async function scan(dir){for(const e of await readdir(dir,{withFileTypes:true})){if(e.name==='.git'||e.name==='.okri-go')continue;const path=join(dir,e.name);if(e.isDirectory()){if(e.name==='node_modules')mounts.push(relative('/workspace',path));else await scan(path)}}}await scan('/workspace');
      if(roots.some(r=>r.go)){await mkdir('/workspace/.okri-go/pkg/mod',{recursive:true});mounts.push('.okri-go/pkg/mod');}
      await writeFile('/workspace/.okri-cache-ready.json',JSON.stringify({key:${JSON.stringify(key)},mounts}));`;
    await docker([...options,'--name',name,'--mount',`type=bind,source=${snapshot},target=/source,readonly`,'-i','--entrypoint','node',image,'--input-type=module'],{input:script});
    const result=await docker([...options,'--network','none','--entrypoint','node',image,'-e',"process.stdout.write(require('fs').readFileSync('/workspace/.okri-cache-ready.json','utf8'))"]);
    await unlink(failurePath).catch(()=>undefined);return JSON.parse(result.output).mounts.map(path=>({volume,path}));
  }catch(error){if(!cachedFailure)await writeFile(failurePath,JSON.stringify({time:Date.now(),message:error.message}));throw error;}
  finally{await docker(['rm','-f',name],{allowFailure:true}).catch(()=>undefined);if(preparedSnapshot&&snapshotCleanup)await snapshotCleanup(preparedSnapshot).catch(()=>undefined);await lock.close();await unlink(lockPath).catch(()=>undefined);}
}
