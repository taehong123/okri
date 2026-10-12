ALTER TABLE daily_scrums ADD COLUMN calendar_events_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(calendar_events_json) AND json_type(calendar_events_json) = 'array' AND json_array_length(calendar_events_json) <= 20);
--> statement-breakpoint
ALTER TABLE daily_submissions ADD COLUMN calendar_events_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(calendar_events_json) AND json_type(calendar_events_json) = 'array' AND json_array_length(calendar_events_json) <= 20);
