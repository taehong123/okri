import { ContributionError } from "./project-contributions";
export type KrObservation = {id:string;source:"api"|"projects";eventKind:string;currentValue:number|null;baselineValue:number;targetValue:number;unit:string;observedAt:string};
export async function readKrHistory(db:D1Database,ownerId:string,keyResultId:string,days:number,now=new Date()) {
  if(![7,30,90,365].includes(days))throw new ContributionError("invalid_history_range",400);
  const target=await db.prepare("SELECT id FROM items WHERE owner_id=? AND id=? AND kind='key_result' AND archived_at IS NULL").bind(ownerId,keyResultId).first();
  if(!target)throw new ContributionError("key_result_not_found",404);
  const since=new Date(now.getTime()-days*86_400_000).toISOString();
  const result=await db.prepare(`SELECT * FROM kr_metric_observations WHERE owner_id=? AND kr_item_id=? AND observed_at>=? AND observed_at<=? ORDER BY observed_at DESC,rowid DESC LIMIT 5001`).bind(ownerId,keyResultId,since,now.toISOString()).all<{id:string;source:"api"|"projects";event_kind:string;current_value:number|null;baseline_value:number;target_value:number;unit:string;observed_at:string}>();
  return {days,limited:result.results.length>5000,observations:result.results.slice(0,5000).reverse().map(r=>({id:r.id,source:r.source,eventKind:r.event_kind,currentValue:r.current_value,baselineValue:r.baseline_value,targetValue:r.target_value,unit:r.unit,observedAt:r.observed_at} satisfies KrObservation))};
}
