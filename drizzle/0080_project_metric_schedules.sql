CREATE TABLE workspace_metric_calendars (
 id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
 timezone TEXT NOT NULL DEFAULT 'Asia/Seoul', holidays_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(holidays_json) AND json_type(holidays_json)='array'),
 version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE project_metric_schedules (
 id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, kr_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
 mode TEXT NOT NULL CHECK(mode IN ('once','business_days','daily')), amount REAL NOT NULL CHECK(amount BETWEEN 0 AND 1000000000000),
 start_date TEXT NOT NULL, end_date TEXT, pauses_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(pauses_json) AND json_type(pauses_json)='array'),
 credit_dates_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(credit_dates_json) AND json_type(credit_dates_json)='array' AND json_array_length(credit_dates_json)<=36600),
 accrued_value REAL NOT NULL DEFAULT 0 CHECK(accrued_value BETWEEN 0 AND 1000000000000),
 through_date TEXT NOT NULL, calendar_version INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), suspended_at TEXT,
 version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(owner_id,project_id,kr_item_id)
);
--> statement-breakpoint
CREATE INDEX idx_project_metric_schedules_due ON project_metric_schedules(active,through_date);
--> statement-breakpoint
CREATE INDEX idx_project_metric_schedules_owner_kr ON project_metric_schedules(owner_id,kr_item_id);
--> statement-breakpoint
ALTER TABLE kr_metric_observations ADD is_estimate INTEGER NOT NULL DEFAULT 0 CHECK(is_estimate IN (0,1));

--> statement-breakpoint
DROP TRIGGER project_contribution_insert;
--> statement-breakpoint
CREATE TRIGGER project_contribution_insert AFTER INSERT ON project_contributions BEGIN
  UPDATE kr_project_metrics SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.kr_item_id;
  UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(s.accrued_value) FROM project_metric_schedules s WHERE s.owner_id=kr_project_metrics.owner_id AND s.kr_item_id=kr_project_metrics.kr_item_id),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=NEW.owner_id AND id=NEW.kr_item_id AND kind='key_result' AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id AND active=1);
END;

--> statement-breakpoint
DROP TRIGGER project_contribution_update;
--> statement-breakpoint
CREATE TRIGGER project_contribution_update AFTER UPDATE OF actual_value, applied, enabled, kr_item_id ON project_contributions BEGIN
  UPDATE kr_project_metrics SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=OLD.owner_id AND kr_item_id=OLD.kr_item_id;
  UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(s.accrued_value) FROM project_metric_schedules s WHERE s.owner_id=kr_project_metrics.owner_id AND s.kr_item_id=kr_project_metrics.kr_item_id),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=OLD.owner_id AND id=OLD.kr_item_id AND kind='key_result' AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id AND active=1);
  UPDATE kr_project_metrics SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.kr_item_id;
  UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(s.accrued_value) FROM project_metric_schedules s WHERE s.owner_id=kr_project_metrics.owner_id AND s.kr_item_id=kr_project_metrics.kr_item_id),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=NEW.owner_id AND id=NEW.kr_item_id AND kind='key_result' AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id AND active=1);
END;

--> statement-breakpoint
DROP TRIGGER project_contribution_delete;
--> statement-breakpoint
CREATE TRIGGER project_contribution_delete AFTER DELETE ON project_contributions BEGIN
  UPDATE kr_project_metrics SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=OLD.owner_id AND kr_item_id=OLD.kr_item_id;
  UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(s.accrued_value) FROM project_metric_schedules s WHERE s.owner_id=kr_project_metrics.owner_id AND s.kr_item_id=kr_project_metrics.kr_item_id),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=OLD.owner_id AND id=OLD.kr_item_id AND kind='key_result' AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id AND active=1);
END;

--> statement-breakpoint
DROP TRIGGER project_contribution_complete;
--> statement-breakpoint
CREATE TRIGGER project_contribution_complete AFTER UPDATE OF status ON items
WHEN NEW.kind='project' AND NEW.status IN ('done','development_done') AND OLD.status NOT IN ('done','development_done') AND NEW.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM project_metric_schedules s JOIN items i ON i.id=NEW.parent_id AND i.owner_id=NEW.owner_id WHERE s.owner_id=NEW.owner_id AND s.project_id=NEW.id AND s.kr_item_id=i.parent_id)
BEGIN
  UPDATE project_contributions SET applied=1,actual_value=coalesce(actual_value,default_value),version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE owner_id=NEW.owner_id AND project_id=NEW.id AND enabled=1 AND applied=0 AND EXISTS(SELECT 1 FROM kr_project_metrics m WHERE m.owner_id=project_contributions.owner_id AND m.kr_item_id=project_contributions.kr_item_id AND m.active=1);
END;

--> statement-breakpoint
DROP TRIGGER project_metric_progress;
--> statement-breakpoint
CREATE TRIGGER project_metric_progress AFTER UPDATE OF progress ON items
WHEN NEW.kind='key_result' AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.id AND active=1) AND NEW.progress != (SELECT (SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(s.accrued_value) FROM project_metric_schedules s WHERE s.owner_id=kr_project_metrics.owner_id AND s.kr_item_id=kr_project_metrics.kr_item_id),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id) FROM items WHERE id=NEW.id)
BEGIN UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(s.accrued_value) FROM project_metric_schedules s WHERE s.owner_id=kr_project_metrics.owner_id AND s.kr_item_id=kr_project_metrics.kr_item_id),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id) WHERE id=NEW.id AND owner_id=NEW.owner_id; END;

--> statement-breakpoint
DROP TRIGGER project_metric_value_insert;
--> statement-breakpoint
CREATE TRIGGER project_metric_value_insert AFTER INSERT ON kr_project_metrics WHEN NEW.active=1 BEGIN
UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(s.accrued_value) FROM project_metric_schedules s WHERE s.owner_id=kr_project_metrics.owner_id AND s.kr_item_id=kr_project_metrics.kr_item_id),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=NEW.owner_id AND id=NEW.kr_item_id AND kind='key_result' AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id);
END;

--> statement-breakpoint
DROP TRIGGER project_metric_value_update;
--> statement-breakpoint
CREATE TRIGGER project_metric_value_update AFTER UPDATE OF starting_value, target_value, active ON kr_project_metrics WHEN NEW.active=1 BEGIN
UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(s.accrued_value) FROM project_metric_schedules s WHERE s.owner_id=kr_project_metrics.owner_id AND s.kr_item_id=kr_project_metrics.kr_item_id),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=NEW.owner_id AND id=NEW.kr_item_id AND kind='key_result' AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id);
END;

--> statement-breakpoint
DROP TRIGGER kr_history_metric_insert;
--> statement-breakpoint
CREATE TRIGGER kr_history_metric_insert AFTER INSERT ON kr_project_metrics WHEN (NEW.active=1) AND NOT EXISTS(SELECT 1 FROM workspace_backup_guards) BEGIN
INSERT INTO kr_metric_observations(id,owner_id,kr_item_id,source,event_kind,current_value,baseline_value,target_value,unit,observed_at) SELECT lower(hex(randomblob(16))),m.owner_id,m.kr_item_id,'projects','settings',
 m.starting_value+coalesce((SELECT sum(actual_value) FROM project_contributions c WHERE c.owner_id=m.owner_id AND c.kr_item_id=m.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(s.accrued_value) FROM project_metric_schedules s WHERE s.owner_id=m.owner_id AND s.kr_item_id=m.kr_item_id),0),
 0,m.target_value,m.unit,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM kr_project_metrics m
 WHERE m.owner_id=NEW.owner_id AND m.kr_item_id=NEW.kr_item_id AND m.active=1 AND (1);
END;

--> statement-breakpoint
DROP TRIGGER kr_history_metric_update;
--> statement-breakpoint
CREATE TRIGGER kr_history_metric_update AFTER UPDATE OF starting_value,target_value,unit,active ON kr_project_metrics WHEN (NEW.active=1) AND NOT EXISTS(SELECT 1 FROM workspace_backup_guards) BEGIN
INSERT INTO kr_metric_observations(id,owner_id,kr_item_id,source,event_kind,current_value,baseline_value,target_value,unit,observed_at) SELECT lower(hex(randomblob(16))),m.owner_id,m.kr_item_id,'projects','settings',
 m.starting_value+coalesce((SELECT sum(actual_value) FROM project_contributions c WHERE c.owner_id=m.owner_id AND c.kr_item_id=m.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(s.accrued_value) FROM project_metric_schedules s WHERE s.owner_id=m.owner_id AND s.kr_item_id=m.kr_item_id),0),
 0,m.target_value,m.unit,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM kr_project_metrics m
 WHERE m.owner_id=NEW.owner_id AND m.kr_item_id=NEW.kr_item_id AND m.active=1 AND (1);
END;

--> statement-breakpoint
DROP TRIGGER kr_history_contribution_insert;
--> statement-breakpoint
CREATE TRIGGER kr_history_contribution_insert AFTER INSERT ON project_contributions WHEN (NEW.applied=1) AND NOT EXISTS(SELECT 1 FROM workspace_backup_guards) BEGIN
INSERT INTO kr_metric_observations(id,owner_id,kr_item_id,source,event_kind,current_value,baseline_value,target_value,unit,observed_at) SELECT lower(hex(randomblob(16))),m.owner_id,m.kr_item_id,'projects','completed',
 m.starting_value+coalesce((SELECT sum(actual_value) FROM project_contributions c WHERE c.owner_id=m.owner_id AND c.kr_item_id=m.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(s.accrued_value) FROM project_metric_schedules s WHERE s.owner_id=m.owner_id AND s.kr_item_id=m.kr_item_id),0),
 0,m.target_value,m.unit,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM kr_project_metrics m
 WHERE m.owner_id=NEW.owner_id AND m.kr_item_id=NEW.kr_item_id AND m.active=1 AND (1);
END;

--> statement-breakpoint
DROP TRIGGER kr_history_contribution_delete;
--> statement-breakpoint
CREATE TRIGGER kr_history_contribution_delete AFTER DELETE ON project_contributions WHEN (OLD.applied=1) AND NOT EXISTS(SELECT 1 FROM workspace_backup_guards) BEGIN
INSERT INTO kr_metric_observations(id,owner_id,kr_item_id,source,event_kind,current_value,baseline_value,target_value,unit,observed_at) SELECT lower(hex(randomblob(16))),m.owner_id,m.kr_item_id,'projects','adjusted',
 m.starting_value+coalesce((SELECT sum(actual_value) FROM project_contributions c WHERE c.owner_id=m.owner_id AND c.kr_item_id=m.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(s.accrued_value) FROM project_metric_schedules s WHERE s.owner_id=m.owner_id AND s.kr_item_id=m.kr_item_id),0),
 0,m.target_value,m.unit,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM kr_project_metrics m
 WHERE m.owner_id=OLD.owner_id AND m.kr_item_id=OLD.kr_item_id AND m.active=1 AND (1);
END;

--> statement-breakpoint
DROP TRIGGER kr_history_contribution_update;
--> statement-breakpoint
CREATE TRIGGER kr_history_contribution_update AFTER UPDATE OF actual_value,applied,kr_item_id ON project_contributions WHEN (OLD.applied!=NEW.applied OR (OLD.applied=1 AND (OLD.actual_value IS NOT NEW.actual_value OR OLD.kr_item_id IS NOT NEW.kr_item_id))) AND NOT EXISTS(SELECT 1 FROM workspace_backup_guards) BEGIN
INSERT INTO kr_metric_observations(id,owner_id,kr_item_id,source,event_kind,current_value,baseline_value,target_value,unit,observed_at) SELECT lower(hex(randomblob(16))),m.owner_id,m.kr_item_id,'projects','adjusted',
 m.starting_value+coalesce((SELECT sum(actual_value) FROM project_contributions c WHERE c.owner_id=m.owner_id AND c.kr_item_id=m.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(s.accrued_value) FROM project_metric_schedules s WHERE s.owner_id=m.owner_id AND s.kr_item_id=m.kr_item_id),0),
 0,m.target_value,m.unit,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM kr_project_metrics m
 WHERE m.owner_id=OLD.owner_id AND m.kr_item_id=OLD.kr_item_id AND m.active=1 AND (OLD.applied=1 AND (NEW.applied=0 OR OLD.kr_item_id IS NOT NEW.kr_item_id));
INSERT INTO kr_metric_observations(id,owner_id,kr_item_id,source,event_kind,current_value,baseline_value,target_value,unit,observed_at) SELECT lower(hex(randomblob(16))),m.owner_id,m.kr_item_id,'projects','completed',
 m.starting_value+coalesce((SELECT sum(actual_value) FROM project_contributions c WHERE c.owner_id=m.owner_id AND c.kr_item_id=m.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(s.accrued_value) FROM project_metric_schedules s WHERE s.owner_id=m.owner_id AND s.kr_item_id=m.kr_item_id),0),
 0,m.target_value,m.unit,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM kr_project_metrics m
 WHERE m.owner_id=NEW.owner_id AND m.kr_item_id=NEW.kr_item_id AND m.active=1 AND (NEW.applied=1);
END;

--> statement-breakpoint
CREATE TRIGGER project_metric_schedule_target_insert BEFORE INSERT ON project_metric_schedules WHEN NOT EXISTS(SELECT 1 FROM items p JOIN items i ON i.id=p.parent_id AND i.owner_id=p.owner_id JOIN items k ON k.id=i.parent_id AND k.owner_id=p.owner_id WHERE p.owner_id=NEW.owner_id AND p.id=NEW.project_id AND p.kind='project' AND i.kind='initiative' AND k.id=NEW.kr_item_id AND k.kind='key_result') AND NOT EXISTS(SELECT 1 FROM workspace_backup_guards) BEGIN SELECT RAISE(ABORT,'schedule target constraint'); END;

--> statement-breakpoint
CREATE TRIGGER project_metric_schedule_target_update BEFORE UPDATE OF owner_id,project_id,kr_item_id ON project_metric_schedules WHEN NOT EXISTS(SELECT 1 FROM items p JOIN items i ON i.id=p.parent_id AND i.owner_id=p.owner_id JOIN items k ON k.id=i.parent_id AND k.owner_id=p.owner_id WHERE p.owner_id=NEW.owner_id AND p.id=NEW.project_id AND p.kind='project' AND i.kind='initiative' AND k.id=NEW.kr_item_id AND k.kind='key_result') AND NOT EXISTS(SELECT 1 FROM workspace_backup_guards) BEGIN SELECT RAISE(ABORT,'schedule target constraint'); END;

--> statement-breakpoint
CREATE TRIGGER project_metric_schedule_dates_insert BEFORE INSERT ON project_metric_schedules WHEN NOT EXISTS(SELECT 1 FROM workspace_backup_guards) AND (abs(NEW.accrued_value-json_array_length(NEW.credit_dates_json)*NEW.amount)>max(0.000001,abs(NEW.accrued_value)*0.000000000001)
 OR (SELECT count(DISTINCT value) FROM json_each(NEW.credit_dates_json))!=json_array_length(NEW.credit_dates_json)
 OR EXISTS(SELECT 1 FROM json_each(NEW.credit_dates_json) d WHERE d.type!='text' OR length(d.value)!=10 OR date(d.value) IS NULL OR date(d.value)!=d.value
 OR d.value<NEW.start_date OR d.value>NEW.through_date OR (NEW.end_date IS NOT NULL AND d.value>NEW.end_date)
 OR (NEW.mode='once' AND d.value!=NEW.start_date)
 OR EXISTS(SELECT 1 FROM json_each(NEW.pauses_json) p WHERE d.value>=json_extract(p.value,'$.startDate') AND (json_extract(p.value,'$.endDate') IS NULL OR d.value<=json_extract(p.value,'$.endDate')))
 OR (NEW.mode='business_days' AND (strftime('%w',d.value) IN ('0','6') OR EXISTS(SELECT 1 FROM workspace_metric_calendars c,json_each(c.holidays_json) h WHERE c.owner_id=NEW.owner_id AND h.value=d.value))))) BEGIN SELECT RAISE(ABORT,'schedule dates constraint'); END;

--> statement-breakpoint
CREATE TRIGGER project_metric_schedule_dates_update BEFORE UPDATE OF mode,amount,start_date,end_date,pauses_json,credit_dates_json,accrued_value,through_date,calendar_version ON project_metric_schedules WHEN NOT EXISTS(SELECT 1 FROM workspace_backup_guards) AND (abs(NEW.accrued_value-json_array_length(NEW.credit_dates_json)*NEW.amount)>max(0.000001,abs(NEW.accrued_value)*0.000000000001)
 OR (SELECT count(DISTINCT value) FROM json_each(NEW.credit_dates_json))!=json_array_length(NEW.credit_dates_json)
 OR EXISTS(SELECT 1 FROM json_each(NEW.credit_dates_json) d WHERE d.type!='text' OR length(d.value)!=10 OR date(d.value) IS NULL OR date(d.value)!=d.value
 OR d.value<NEW.start_date OR d.value>NEW.through_date OR (NEW.end_date IS NOT NULL AND d.value>NEW.end_date)
 OR (NEW.mode='once' AND d.value!=NEW.start_date)
 OR EXISTS(SELECT 1 FROM json_each(NEW.pauses_json) p WHERE d.value>=json_extract(p.value,'$.startDate') AND (json_extract(p.value,'$.endDate') IS NULL OR d.value<=json_extract(p.value,'$.endDate')))
 OR (NEW.mode='business_days' AND (strftime('%w',d.value) IN ('0','6') OR EXISTS(SELECT 1 FROM workspace_metric_calendars c,json_each(c.holidays_json) h WHERE c.owner_id=NEW.owner_id AND h.value=d.value))))) BEGIN SELECT RAISE(ABORT,'schedule dates constraint'); END;

--> statement-breakpoint
CREATE TRIGGER project_metric_schedule_insert AFTER INSERT ON project_metric_schedules BEGIN UPDATE kr_project_metrics SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.kr_item_id;
UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0*(starting_value+coalesce((SELECT sum(actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(accrued_value) FROM project_metric_schedules s WHERE s.owner_id=kr_project_metrics.owner_id AND s.kr_item_id=kr_project_metrics.kr_item_id),0))/target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=NEW.owner_id AND id=NEW.kr_item_id AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id AND active=1);
INSERT INTO kr_metric_observations(id,owner_id,kr_item_id,source,event_kind,current_value,baseline_value,target_value,unit,observed_at,is_estimate)
SELECT lower(hex(randomblob(16))),m.owner_id,m.kr_item_id,'projects','scheduled',m.starting_value+coalesce((SELECT sum(actual_value) FROM project_contributions c WHERE c.owner_id=m.owner_id AND c.kr_item_id=m.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(accrued_value) FROM project_metric_schedules s WHERE s.owner_id=m.owner_id AND s.kr_item_id=m.kr_item_id),0),0,m.target_value,m.unit,strftime('%Y-%m-%dT%H:%M:%fZ','now'),1 FROM kr_project_metrics m WHERE m.owner_id=NEW.owner_id AND m.kr_item_id=NEW.kr_item_id AND m.active=1 AND NOT EXISTS(SELECT 1 FROM workspace_backup_guards); END;

--> statement-breakpoint
CREATE TRIGGER project_metric_schedule_value_update AFTER UPDATE OF accrued_value,mode,amount,start_date,end_date,pauses_json,active ON project_metric_schedules WHEN OLD.accrued_value!=NEW.accrued_value OR OLD.mode!=NEW.mode OR OLD.amount!=NEW.amount OR OLD.start_date!=NEW.start_date OR OLD.end_date IS NOT NEW.end_date OR OLD.pauses_json!=NEW.pauses_json OR OLD.active!=NEW.active BEGIN UPDATE kr_project_metrics SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.kr_item_id;
UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0*(starting_value+coalesce((SELECT sum(actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(accrued_value) FROM project_metric_schedules s WHERE s.owner_id=kr_project_metrics.owner_id AND s.kr_item_id=kr_project_metrics.kr_item_id),0))/target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=NEW.owner_id AND id=NEW.kr_item_id AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id AND active=1);
INSERT INTO kr_metric_observations(id,owner_id,kr_item_id,source,event_kind,current_value,baseline_value,target_value,unit,observed_at,is_estimate)
SELECT lower(hex(randomblob(16))),m.owner_id,m.kr_item_id,'projects','scheduled',m.starting_value+coalesce((SELECT sum(actual_value) FROM project_contributions c WHERE c.owner_id=m.owner_id AND c.kr_item_id=m.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(accrued_value) FROM project_metric_schedules s WHERE s.owner_id=m.owner_id AND s.kr_item_id=m.kr_item_id),0),0,m.target_value,m.unit,strftime('%Y-%m-%dT%H:%M:%fZ','now'),1 FROM kr_project_metrics m WHERE m.owner_id=NEW.owner_id AND m.kr_item_id=NEW.kr_item_id AND m.active=1 AND NOT EXISTS(SELECT 1 FROM workspace_backup_guards); END;

--> statement-breakpoint
CREATE TRIGGER project_metric_schedule_delete AFTER DELETE ON project_metric_schedules BEGIN UPDATE kr_project_metrics SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=OLD.owner_id AND kr_item_id=OLD.kr_item_id;
UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0*(starting_value+coalesce((SELECT sum(actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(accrued_value) FROM project_metric_schedules s WHERE s.owner_id=kr_project_metrics.owner_id AND s.kr_item_id=kr_project_metrics.kr_item_id),0))/target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=OLD.owner_id AND id=OLD.kr_item_id AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id AND active=1);
INSERT INTO kr_metric_observations(id,owner_id,kr_item_id,source,event_kind,current_value,baseline_value,target_value,unit,observed_at,is_estimate)
SELECT lower(hex(randomblob(16))),m.owner_id,m.kr_item_id,'projects','scheduled',m.starting_value+coalesce((SELECT sum(actual_value) FROM project_contributions c WHERE c.owner_id=m.owner_id AND c.kr_item_id=m.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(accrued_value) FROM project_metric_schedules s WHERE s.owner_id=m.owner_id AND s.kr_item_id=m.kr_item_id),0),0,m.target_value,m.unit,strftime('%Y-%m-%dT%H:%M:%fZ','now'),1 FROM kr_project_metrics m WHERE m.owner_id=OLD.owner_id AND m.kr_item_id=OLD.kr_item_id AND m.active=1 AND NOT EXISTS(SELECT 1 FROM workspace_backup_guards); END;

--> statement-breakpoint
CREATE TRIGGER project_metric_observation_estimate AFTER INSERT ON kr_metric_observations WHEN NEW.source='projects' AND NEW.is_estimate=0 AND EXISTS(SELECT 1 FROM project_metric_schedules WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.kr_item_id AND json_array_length(credit_dates_json)>0) BEGIN UPDATE kr_metric_observations SET is_estimate=1 WHERE id=NEW.id; END;

--> statement-breakpoint
CREATE TRIGGER project_metric_schedule_project_suspend AFTER UPDATE OF parent_id,archived_at ON items WHEN NEW.kind='project' AND (NEW.parent_id IS NOT OLD.parent_id OR NEW.archived_at IS NOT NULL) BEGIN UPDATE project_metric_schedules SET active=0,suspended_at=coalesce(suspended_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),version=version+1 WHERE owner_id=NEW.owner_id AND project_id=NEW.id AND active=1; END;

--> statement-breakpoint
CREATE TRIGGER project_metric_schedule_initiative_suspend AFTER UPDATE OF parent_id,archived_at ON items WHEN NEW.kind='initiative' AND (NEW.parent_id IS NOT OLD.parent_id OR NEW.archived_at IS NOT NULL) BEGIN UPDATE project_metric_schedules SET active=0,suspended_at=coalesce(suspended_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),version=version+1 WHERE owner_id=NEW.owner_id AND project_id IN (SELECT id FROM items WHERE owner_id=NEW.owner_id AND parent_id=NEW.id) AND active=1; END;

--> statement-breakpoint
CREATE TRIGGER backup_revision_workspace_metric_calendars_insert AFTER INSERT ON workspace_metric_calendars BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=NEW.owner_id; END;

--> statement-breakpoint
CREATE TRIGGER project_metric_schedule_kr_suspend AFTER UPDATE OF archived_at ON items WHEN NEW.kind='key_result' AND NEW.archived_at IS NOT NULL BEGIN UPDATE project_metric_schedules SET active=0,suspended_at=coalesce(suspended_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),version=version+1 WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.id AND active=1; END;

--> statement-breakpoint
CREATE TRIGGER backup_revision_workspace_metric_calendars_update AFTER UPDATE ON workspace_metric_calendars BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=NEW.owner_id; END;

--> statement-breakpoint
CREATE TRIGGER backup_revision_workspace_metric_calendars_delete AFTER DELETE ON workspace_metric_calendars BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=OLD.owner_id; END;

--> statement-breakpoint
CREATE TRIGGER backup_revision_project_metric_schedules_insert AFTER INSERT ON project_metric_schedules BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=NEW.owner_id; END;

--> statement-breakpoint
CREATE TRIGGER backup_revision_project_metric_schedules_update AFTER UPDATE ON project_metric_schedules BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=NEW.owner_id; END;

--> statement-breakpoint
CREATE TRIGGER backup_revision_project_metric_schedules_delete AFTER DELETE ON project_metric_schedules BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=OLD.owner_id; END;
