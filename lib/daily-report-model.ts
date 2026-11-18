export class DailyReportError extends Error {
  constructor(public code:string,public status=400){super(code);this.name="DailyReportError";}
}
export type ReportTrigger="at_time"|"all_or_deadline"|"manual"|"custom";
export type ReportCondition={all:ReportCondition[]}|{any:ReportCondition[]}|{not:ReportCondition}|{field:string;operator:string;value:string|number|boolean|number[]};
export type ReportScope={memberIds:string[];projectIds:string[];includeCompleted:boolean;includeBlockers:boolean;onlyMustDo:boolean};
export type ReportPolicyInput={enabled:boolean;approverMemberId:string;channelIds:string[];instructions:string;trigger:ReportTrigger;reportTime:string;weekdays:number[];timezone:string;condition:ReportCondition;scope:ReportScope};
const validTime=(value:unknown):value is string=>typeof value==="string"&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value);
export function reportClock(now:Date,timezone:string){
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(now),get=(key:string)=>parts.find(p=>p.type===key)!.value;
  const date=`${get("year")}-${get("month")}-${get("day")}`;return {date,time:`${get("hour")}:${get("minute")}`,weekday:new Date(date+"T00:00:00Z").getUTCDay()};
}
export function parseReportCondition(raw:unknown):ReportCondition {
  let count=0;
  const parse=(value:unknown,depth:number):ReportCondition=>{
    if(++count>40||depth>5||!value||typeof value!=="object"||Array.isArray(value))throw new DailyReportError("invalid_report_condition");
    const v=value as Record<string,unknown>,keys=Object.keys(v);
    if(keys.length===1&&(keys[0]==="all"||keys[0]==="any")) {
      const key=keys[0],nodes=v[key];if(!Array.isArray(nodes)||!nodes.length||nodes.length>12)throw new DailyReportError("invalid_report_condition");
      const children=nodes.map(n=>parse(n,depth+1));return key==="all"?{all:children}:{any:children};
    }
    if(keys.length===1&&keys[0]==="not")return {not:parse(v.not,depth+1)};
    if(keys.length!==3||!keys.every(k=>["field","operator","value"].includes(k)))throw new DailyReportError("invalid_report_condition");
    const {field,operator,value:operand}=v;
    if(field==="time") {if(!["eq","gte","lte"].includes(String(operator))||!validTime(operand))throw new DailyReportError("invalid_report_condition");}
    else if(field==="weekday") {if(operator!=="in"||!Array.isArray(operand)||!operand.length||operand.some(n=>!Number.isInteger(n)||n<0||n>6))throw new DailyReportError("invalid_report_condition");}
    else if(["all_submitted","manual"].includes(String(field))) {if(operator!=="eq"||typeof operand!=="boolean")throw new DailyReportError("invalid_report_condition");}
    else if(["submitted_count","missing_count","task_count","blocker_count"].includes(String(field))) {if(!["eq","gte","lte"].includes(String(operator))||!Number.isSafeInteger(operand)||(operand as number)<0||(operand as number)>100000)throw new DailyReportError("invalid_report_condition");}
    else throw new DailyReportError("invalid_report_condition");
    return {field:String(field),operator:String(operator),value:operand as string|number|boolean|number[]};
  };
  return parse(raw,0);
}
export function defaultReportCondition(trigger:Exclude<ReportTrigger,"custom">,time:string,weekdays:number[]):ReportCondition {
  const timed:ReportCondition={field:"time",operator:"gte",value:time};
  return {all:[{field:"weekday",operator:"in",value:weekdays},trigger==="manual"?{field:"manual",operator:"eq",value:true}:trigger==="all_or_deadline"?{any:[{field:"all_submitted",operator:"eq",value:true},timed]}:timed]};
}
export function reportConditionMatches(condition:ReportCondition,facts:Record<string,string|number|boolean>):boolean {
  if("all"in condition)return condition.all.every(c=>reportConditionMatches(c,facts));
  if("any"in condition)return condition.any.some(c=>reportConditionMatches(c,facts));
  if("not"in condition)return !reportConditionMatches(condition.not,facts);
  const left=facts[condition.field],right=condition.value;
  if(condition.operator==="in")return Array.isArray(right)&&right.includes(left as number);
  if(condition.operator==="eq")return left===right;
  if(typeof left==="number"&&typeof right==="number")return condition.operator==="gte"?left>=right:condition.operator==="lte"?left<=right:false;
  if(typeof left==="string"&&typeof right==="string")return condition.operator==="gte"?left>=right:condition.operator==="lte"?left<=right:false;
  return false;
}
function ids(raw:unknown,max=200){
  if(!Array.isArray(raw)||raw.length>max||raw.some(v=>typeof v!=="string"||!v||v.length>150))throw new DailyReportError("invalid_report_scope");return [...new Set(raw)] as string[];
}
export function parseReportPolicy(raw:unknown):ReportPolicyInput {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new DailyReportError("invalid_report_policy");const v=raw as Record<string,unknown>;
  if(typeof v.enabled!=="boolean"||typeof v.approverMemberId!=="string"||!v.approverMemberId||typeof v.instructions!=="string"||v.instructions.length>8000||!validTime(v.reportTime)||typeof v.timezone!=="string"||v.timezone.length>100||!["at_time","all_or_deadline","manual","custom"].includes(String(v.trigger)))throw new DailyReportError("invalid_report_policy");
  try{new Intl.DateTimeFormat("en-US",{timeZone:v.timezone}).format();}catch{throw new DailyReportError("invalid_report_timezone");}
  if(!Array.isArray(v.weekdays)||!v.weekdays.length||v.weekdays.some(n=>!Number.isInteger(n)||n<0||n>6))throw new DailyReportError("invalid_report_weekdays");
  const weekdays=[...new Set(v.weekdays)] as number[],trigger=v.trigger as ReportTrigger;
  if(v.scope!==undefined&&(!v.scope||typeof v.scope!=="object"||Array.isArray(v.scope)))throw new DailyReportError("invalid_report_scope");
  const scope=(v.scope??{}) as Record<string,unknown>;
  for(const key of ["includeCompleted","includeBlockers","onlyMustDo"])if(scope[key]!==undefined&&typeof scope[key]!=="boolean")throw new DailyReportError("invalid_report_scope");
  const channelIds=ids(v.channelIds,20);if(v.enabled&&!channelIds.length)throw new DailyReportError("report_channel_required");
  return {enabled:v.enabled,approverMemberId:v.approverMemberId,channelIds,instructions:v.instructions.trim(),trigger,reportTime:v.reportTime,weekdays,timezone:v.timezone,
    condition:trigger==="custom"?parseReportCondition(v.condition):defaultReportCondition(trigger,v.reportTime,weekdays),
    scope:{memberIds:ids(scope.memberIds??[]),projectIds:ids(scope.projectIds??[]),includeCompleted:scope.includeCompleted!==false,includeBlockers:scope.includeBlockers!==false,onlyMustDo:scope.onlyMustDo===true}};
}
export function reportPages(raw:unknown):string[] {
  if(!Array.isArray(raw)||!raw.length||raw.length>40||raw.some(v=>typeof v!=="string"||!v.trim()||v.length>2800||/<!(?:channel|here|everyone)(?:\||>)/i.test(v)))throw new DailyReportError("invalid_report_pages");
  return raw.map(page=>(page as string).trim());
}
export function escapeReportText(value:string) {return value.replace(/[\r\n]+/g," ").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/[*_`~]/g,c=>({"*":"＊","_":"＿","`":"｀","~":"～"})[c]!);}
