import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {DatabaseSync} from "node:sqlite";
import ts from "typescript";
const require=createRequire(import.meta.url);
export const read=path=>readFile(new URL(`../../${path}`,import.meta.url),"utf8");
export function compile(source,dependencies={}) {
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,m={exports:{}};
  new Function("require","module","exports",js)(name=>name in dependencies?dependencies[name]:require(name),m,m.exports);return m.exports;
}
export const model=compile(await read("lib/daily-report-model.ts"));
export const reports=compile(await read("lib/daily-report.ts"),{"./daily-report-model":model});
const snapshot=JSON.parse(await read("drizzle/meta/0072_snapshot.json")),migration=await read("drizzle/0081_daily_report_review.sql");
export const now=new Date("2026-11-18T06:00:00Z");
export const channel={id:"C1",name:"reports",isMember:true,isExternal:false,isShared:false,isPrivate:false};
export function fixture(t) {
  const sql=new DatabaseSync(":memory:");t.after(()=>sql.close());sql.exec("PRAGMA foreign_keys=ON;PRAGMA recursive_triggers=ON");
  for(const table of Object.values(snapshot.tables)) {
    const cols=Object.values(table.columns).map(c=>`${c.name} ${c.type}${c.primaryKey?" PRIMARY KEY":""}${c.notNull?" NOT NULL":""}${c.default!==undefined?` DEFAULT ${c.default}`:""}`);
    for(const fk of Object.values(table.foreignKeys))cols.push(`FOREIGN KEY (${fk.columnsFrom.join(",")}) REFERENCES ${fk.tableTo} (${fk.columnsTo.join(",")}) ON DELETE ${fk.onDelete}`);
    sql.exec(`CREATE TABLE ${table.name} (${cols.join(",")})`);
    for(const index of Object.values(table.indexes))sql.exec(`CREATE ${index.isUnique?"UNIQUE ":""}INDEX ${index.name} ON ${table.name} (${index.columns.join(",")})${index.where?` WHERE ${index.where}`:""}`);
  }
  sql.exec(migration);
  const seed=(table,row)=>sql.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(()=>"?").join(",")})`).run(...Object.values(row));
  seed("users",{id:"u",email_normalized:"owner@example.com"});seed("users",{id:"u2",email_normalized:"member@example.com"});
  seed("workspaces",{id:"w",name:"Team",owner_user_id:"u"});seed("workspaces",{id:"other",name:"Other",owner_user_id:"u2"});
  seed("workspace_backup_state",{owner_id:"w"});seed("workspace_backup_state",{owner_id:"other"});
  for(const [id,user,name,role]of[["m1","u","Owner","owner"],["m2","u2","Member","member"]])seed("workspace_members",{id,workspace_id:"w",user_id:user,display_name:name,email:user+"@example.com",role,status:"active"});
  seed("slack_connections",{id:"connection",owner_id:"w",user_id:"u",team_id:"T1",encrypted_bot_token:"test-cipher",connected_at:"2026-11-01T00:00:00Z"});
  for(const[id,member,user,dm]of[["link1","m1","U1","D1"],["link2","m2","U2","D2"]])seed("slack_member_links",{id,owner_id:"w",member_id:member,team_id:"T1",slack_user_id:user,dm_channel_id:dm});
  seed("slack_daily_settings",{owner_id:"w",enabled:1,summary_time:"12:00",onboarding_completed_at:"2026-11-01",install_status:"connected"});
  seed("slack_daily_channels",{id:"channel",owner_id:"w",channel_id:"C1",channel_name:"reports"});
  for(const[id,kind,parent,title]of[["kr","key_result",null,"KR"],["i","initiative","kr","Initiative"],["p","project","i","Project A"],["task1","task","p","Task one"],["task2","task","p","Task two"]])seed("items",{id,owner_id:"w",kind,parent_id:parent,title});
  seed("item_assignments",{id:"assignment",owner_id:"w",item_id:"task1",member_id:"m2",role:"task_assignee"});
  const work=id=>({id,kind:"task",title:id==="task1"?"Task one":"Task two",parentId:"p",parentKind:"project",parentTitle:"Project A",status:"in_progress"});
  for(const[id,member,name,mustDo,yesterday]of[["s1","m1","Owner",["task:task1"],[work("task2")]],["s2","m2","Member",[],[]]])seed("daily_submissions",{id,owner_id:"w",member_id:member,member_name:name,member_email:member+"@example.com",scrum_date:"2026-11-18",version:1,work_snapshot_json:JSON.stringify([work("task1")]),yesterday_work_snapshot_json:JSON.stringify(yesterday),must_do_work_ids_json:JSON.stringify(mustDo)});
  seed("daily_task_snapshots",{id:"snapshot",owner_id:"w",submission_id:"s1",task_id:"task1",task_title:"Task one",parent_kind:"project",parent_id:"p",parent_title:"Project A",status:"in_progress"});
  const prepare=(query,args=[])=>({bind:(...values)=>prepare(query,values),first:async()=>sql.prepare(query).get(...args)??null,all:async()=>({results:sql.prepare(query).all(...args)}),run:async()=>({meta:{changes:Number(sql.prepare(query).run(...args).changes)}})});
  const db={prepare,batch:async statements=>{sql.exec("BEGIN");try{const out=[];for(const s of statements)out.push(await s.run());sql.exec("COMMIT");return out;}catch(error){sql.exec("ROLLBACK");throw error;}}};
  const save=async(patch={})=>{
    const current=await reports.readReportPreferences(db,"w","u");return reports.saveReportPreferences(db,"w","u",{...current.policy,enabled:true,...patch},current.policy.version,[channel],now);
  };
  const draft=async(pages)=>{const context=await reports.getReportContext(db,"w","u",undefined,now);return reports.createReportDraft(db,"w","u",{sourceHash:context.facts.sourceHash,policyVersion:context.preferences.policy.version,pages},[channel],now);};
  const review=async()=>{
    await save();const value=await draft();sql.prepare("UPDATE daily_report_drafts SET status='awaiting_approval',dm_channel_id='D1',review_root_ts='1.1',review_action_ts='1.9' WHERE id=?").run(value.id);
    seed("slack_bot_deliveries",{id:"review",owner_id:"w",bot_kind:"daily_report_review",subject_id:value.id,event_key:value.id+"/review",connection_key:"[]",policy:"{}",payload:"{}",status:"sent",retry_at:now.toISOString(),expires_at:"2026-11-19T06:00:00Z",message_ts:"1.9",created_at:now.toISOString(),updated_at:now.toISOString()});
    return {draftId:value.id,revision:value.revision,teamId:"T1",slackUserId:"U1",channelId:"D1",messageTs:"1.9",decision:"approve"};
  };
  return {sql,db,seed,save,draft,review};
}
