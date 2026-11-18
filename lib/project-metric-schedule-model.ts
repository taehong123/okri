export type ContributionCadence = "once" | "business_days" | "daily";
export type ContributionPause = {startDate:string; endDate:string|null};
export type ContributionScheduleInput = {mode:ContributionCadence; amount:number; startDate:string; endDate:string|null; pauses:ContributionPause[]};
export type MetricCalendar = {timezone:string; holidays:string[]; version:number};
export class ScheduleError extends Error {
  constructor(public code:string, public status=400) {super(code);this.name="ScheduleError";}
}
export function dateOnly(value:unknown):string {
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+"T00:00:00Z"))||new Date(value+"T00:00:00Z").toISOString().slice(0,10)!==value)throw new ScheduleError("invalid_schedule_date");
  return value;
}
export function localDate(now:Date,timezone:string) {
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);
  const part=(type:string)=>parts.find(p=>p.type===type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function shiftDate(date:string,days:number) {return new Date(Date.parse(date+"T00:00:00Z")+days*86400000).toISOString().slice(0,10);}
export function calendarInput(input:unknown):Omit<MetricCalendar,"version"> {
  if(!input||typeof input!=="object")throw new ScheduleError("invalid_metric_calendar");
  const v=input as Record<string,unknown>;
  if(typeof v.timezone!=="string"||v.timezone.length>100||!Array.isArray(v.holidays)||v.holidays.length>2000)throw new ScheduleError("invalid_metric_calendar");
  try {new Intl.DateTimeFormat("en-US",{timeZone:v.timezone}).format();}catch{throw new ScheduleError("invalid_metric_timezone");}
  return {timezone:v.timezone,holidays:[...new Set(v.holidays.map(dateOnly))].sort()};
}
export function scheduleInput(input:unknown):ContributionScheduleInput {
  if(!input||typeof input!=="object")throw new ScheduleError("invalid_contribution_schedule");
  const v=input as Record<string,unknown>;
  if(!["once","business_days","daily"].includes(v.mode as string)||typeof v.amount!=="number"||!Number.isFinite(v.amount)||v.amount<0||v.amount>1e12)throw new ScheduleError("invalid_contribution_schedule");
  const startDate=dateOnly(v.startDate),endDate=v.endDate==null||v.endDate===""?null:dateOnly(v.endDate);
  if(endDate&&endDate<startDate)throw new ScheduleError("invalid_schedule_period");
  if(v.pauses!==undefined&&(!Array.isArray(v.pauses)||v.pauses.length>50))throw new ScheduleError("invalid_schedule_pauses");
  const pauses=((v.pauses??[]) as unknown[]).map(raw=>{
    if(!raw||typeof raw!=="object")throw new ScheduleError("invalid_schedule_pauses");
    const p=raw as Record<string,unknown>,startDate=dateOnly(p.startDate),endDate=p.endDate==null||p.endDate===""?null:dateOnly(p.endDate);
    if(endDate&&endDate<startDate)throw new ScheduleError("invalid_schedule_period");return {startDate,endDate};
  }).sort((a,b)=>a.startDate.localeCompare(b.startDate));
  return {mode:v.mode as ContributionCadence,amount:v.amount,startDate,endDate,pauses};
}
/** Recurring savings credit closed local days; an explicitly dated one-off can credit today. */
export function scheduleCredits(input:ContributionScheduleInput,calendar:MetricCalendar,now:Date) {
  const today=localDate(now,calendar.timezone),throughDate=input.mode==="once"?today:shiftDate(today,-1);
  const last=[input.endDate??throughDate,throughDate].sort()[0];
  if((Date.parse(last+"T00:00:00Z")-Date.parse(input.startDate+"T00:00:00Z"))/86400000>=36600)throw new ScheduleError("schedule_period_too_long");
  const holidays=new Set(calendar.holidays),dates:string[]=[];
  for(let date=input.startDate;date<=last;date=shiftDate(date,1)) {
    if(input.mode==="once"&&date!==input.startDate)break;
    if(input.pauses.some(p=>date>=p.startDate&&(!p.endDate||date<=p.endDate)))continue;
    const weekday=new Date(date+"T00:00:00Z").getUTCDay();
    if(input.mode==="business_days"&&(weekday===0||weekday===6||holidays.has(date)))continue;
    dates.push(date);
  }
  const accruedValue=dates.length*input.amount;
  if(!Number.isFinite(accruedValue)||accruedValue>1e12)throw new ScheduleError("schedule_total_too_large");
  return {dates,accruedValue,throughDate,monthValue:dates.filter(d=>d.startsWith(today.slice(0,7))).length*input.amount};
}
