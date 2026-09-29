-- NULL preserves the meaning of historical, unclassified daily plans.
ALTER TABLE daily_scrums ADD COLUMN must_do_work_ids_json TEXT;
--> statement-breakpoint
ALTER TABLE daily_submissions ADD COLUMN must_do_work_ids_json TEXT;
