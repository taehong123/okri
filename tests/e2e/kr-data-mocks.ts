import type { Page } from "@playwright/test";
import { bootstrap,json } from "./api-mocks";
import type { KrSourceSettings } from "../../lib/kr-data-sources";
import type { DataConnection } from "../../app/kr-data-view";
import type { KrObservation } from "../../lib/kr-metric-history";
export async function installKrDataMocks(page:Page,{configured=false,viewer=false,long=false}={}){
  const items=structuredClone(bootstrap.items),kr=items.find(i=>i.id==="kr-1")!,project=items.find(i=>i.id==="project-1")!;
  if(long){kr.title="고객 활성 사용자와 장기 유지율 개선 KR 2026 ".repeat(7);project.title="핵심 경험을 개선하는 Project 2026 ".repeat(7);}
  let state:KrSourceSettings={keyResult:{id:kr.id,title:kr.title,progress:configured?28:20},revision:"1",mode:configured?"projects":null,metric:configured?{startingValue:20,currentValue:28,targetValue:100,unit:"건"}:null,api:null,projects:[{id:project.id,title:project.title,status:project.status,defaultValue:configured?10:null,actualValue:configured?8:null,applied:configured}]};
  const observations:KrObservation[]=[20,25,28].map((n,i)=>({id:"sample-"+i,source:"projects",eventKind:i?"completed":"settings",currentValue:n,baselineValue:0,targetValue:100,unit:"건",observedAt:new Date(Date.now()-(8-i*2)*86_400_000).toISOString()}));
  let connections:DataConnection[]=[],writes:Record<string,unknown>[]=[],fail=false;
  await page.route("**/api/**",async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    if(path==="/api/bootstrap")return json(route,{...bootstrap,items,workspaces:bootstrap.workspaces.map(w=>({...w,role:viewer?"viewer":"owner"})),team:{...bootstrap.team,currentRole:viewer?"viewer":"owner",canManage:!viewer}});
    if(path==="/api/kr-data-sources"){
      if(request.method()==="PUT"){
        if(viewer)return json(route,{code:"forbidden"},403);
        const body=request.postDataJSON();writes.push(body);
        if(fail){fail=false;return json(route,{code:"save_failed"},503);}
        state={...state,mode:body.mode,revision:String(Number(state.revision)+1)};
        if(body.mode==="projects"){
          state.metric={startingValue:body.startingValue,currentValue:body.startingValue+(state.metric?8:0),targetValue:body.targetValue,unit:body.unit};
          state.keyResult.progress=Math.round(state.metric.currentValue/state.metric.targetValue*100);
          state.projects=state.projects.map(p=>({...p,defaultValue:body.projects.find((v:{id:string})=>v.id===p.id).defaultValue}));
          connections=connections.map(c=>c.itemId===kr.id?{...c,active:false}:c);
        }else{
          state.api=body.api;state.keyResult.progress=0;
          connections=connections.filter(c=>c.itemId!==kr.id);
          connections.push({id:"kr-api",itemId:kr.id,targetKind:"key_result",...body.api,lastValue:null,lastSyncStatus:"never",lastError:"",lastSyncedAt:null,nextSyncAt:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
        }
        return json(route,state);
      }
      return json(route,url.searchParams.has("keyResultId")?state:{metrics:[{keyResultId:kr.id,mode:state.mode,currentValue:state.mode==="projects"?state.metric?.currentValue??null:null,targetValue:state.mode==="projects"?state.metric?.targetValue??null:state.api?.targetValue??null,unit:state.mode==="projects"?state.metric?.unit??"":state.api?.unit??"",progress:state.keyResult.progress}]});
    }
    if(path==="/api/kr-metric-history")return json(route,{observations:configured?observations:[],limited:false});
    if(path==="/api/project-contributions")return json(route,{metrics:state.mode==="projects"&&state.metric?[{id:"metric",keyResultId:kr.id,title:kr.title,...state.metric,version:1,active:true,progress:state.keyResult.progress}]:[]});
    if(path==="/api/data-connections"&&request.method()==="GET")return json(route,{connections:url.searchParams.has("itemId")?connections.filter(c=>c.itemId===url.searchParams.get("itemId")):connections});
    if(path==="/api/data-connections"&&request.method()==="POST"){const body=request.postDataJSON();writes.push(body);const connection={id:"project-api",...body,lastValue:null,lastSyncStatus:"never",lastError:"",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};connections.push(connection);return json(route,{connection},201);}
    if(path==="/api/data-connections/sync"){const body=request.postDataJSON(),connection=connections.find(c=>c.id===body.id)!;connection.lastValue=connection.targetKind==="project"?35:60;connection.lastSyncStatus="success";return json(route,{connection,progress:connection.lastValue,value:connection.lastValue});}
    return route.fallback();
  });
  return {state:()=>state,writes,fail:()=>{fail=true;},observations};
}
