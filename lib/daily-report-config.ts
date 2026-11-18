import type {RequestAuthorization} from "./pace-data";
import {DailyReportError,parseReportPolicy} from "./daily-report-model";
import {readReportPreferences,saveReportPreferences} from "./daily-report";
import {reportChannels} from "./daily-report-slack";
export function requireReportAdmin(auth:RequestAuthorization,write=false) {
  if(!["owner","admin"].includes(auth.role))throw new DailyReportError("daily_report_admin_required",403);
  if(write&&auth.oauthScopes!==undefined&&!auth.oauthScopes.split(/\s+/).includes("okri:write"))throw new DailyReportError("write_access_required",403);
}
export async function updateReportPreferences(db:D1Database,auth:RequestAuthorization,input:Record<string,unknown>,expectedVersion?:number) {
  requireReportAdmin(auth,true);const current=await readReportPreferences(db,auth.ownerId,auth.userId);
  const patch:Record<string,unknown>={};for(const key of ["enabled","approverMemberId","channelIds","instructions","trigger","reportTime","weekdays","timezone","condition"])if(input[key]!==undefined)patch[key]=input[key];
  if(patch.approverMemberId==="me") {if(!current.currentMemberId)throw new DailyReportError("daily_report_current_member_required",403);patch.approverMemberId=current.currentMemberId;}
  const scope={...current.policy.scope,...(input.scope&&typeof input.scope==="object"&&!Array.isArray(input.scope)?input.scope:{})};
  const value=parseReportPolicy({...current.policy,...patch,scope});
  const channels=await reportChannels(auth.ownerId,value.channelIds);
  return saveReportPreferences(db,auth.ownerId,auth.userId,value,expectedVersion??current.policy.version,channels);
}
