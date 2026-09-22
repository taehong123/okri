CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`external_customer_id` text,
	`name` text NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`source_type` text DEFAULT 'manual' NOT NULL,
	`source_name` text,
	`source_url` text,
	`source_updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_by_user_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_clients_owner_external` ON `clients` (`owner_id`,`external_customer_id`) WHERE `external_customer_id` IS NOT NULL AND `external_customer_id` <> '';
--> statement-breakpoint
CREATE INDEX `idx_clients_owner_name` ON `clients` (`owner_id`,`name`);
--> statement-breakpoint
CREATE TABLE `client_products` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`client_id` text NOT NULL,
	`external_product_id` text,
	`name` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_client_products_client_external` ON `client_products` (`client_id`,`external_product_id`) WHERE `external_product_id` IS NOT NULL AND `external_product_id` <> '';
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_client_products_client_name` ON `client_products` (`client_id`,`name`);
--> statement-breakpoint
CREATE INDEX `idx_client_products_owner_client` ON `client_products` (`owner_id`,`client_id`);
--> statement-breakpoint
CREATE TABLE `ticket_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`client_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ticket_clients_ticket` ON `ticket_clients` (`owner_id`,`ticket_id`);
--> statement-breakpoint
CREATE INDEX `idx_ticket_clients_client` ON `ticket_clients` (`owner_id`,`client_id`);
--> statement-breakpoint
CREATE TABLE `ticket_client_products` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`product_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `client_products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ticket_client_products_unique` ON `ticket_client_products` (`owner_id`,`ticket_id`,`product_id`);
--> statement-breakpoint
CREATE INDEX `idx_ticket_client_products_ticket` ON `ticket_client_products` (`owner_id`,`ticket_id`);
--> statement-breakpoint
CREATE INDEX `idx_ticket_client_products_product` ON `ticket_client_products` (`product_id`);
--> statement-breakpoint
CREATE TABLE `integration_client_upserts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_integration_client_upserts_key` ON `integration_client_upserts` (`owner_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_integration_client_upserts_created` ON `integration_client_upserts` (`owner_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `integration_client_rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`bucket_key` text NOT NULL,
	`window_start` text NOT NULL,
	`request_count` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_integration_client_rate_limit_bucket` ON `integration_client_rate_limits` (`owner_id`,`bucket_key`,`window_start`);
--> statement-breakpoint
CREATE INDEX `idx_integration_client_rate_limit_updated` ON `integration_client_rate_limits` (`updated_at`);
--> statement-breakpoint
CREATE TRIGGER backup_revision_clients_insert AFTER INSERT ON clients
BEGIN
  INSERT INTO workspace_backup_state (owner_id, revision) VALUES (NEW.owner_id, 1)
  ON CONFLICT(owner_id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_clients_update AFTER UPDATE ON clients
BEGIN
  INSERT INTO workspace_backup_state (owner_id, revision) VALUES (NEW.owner_id, 1)
  ON CONFLICT(owner_id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_clients_delete AFTER DELETE ON clients
BEGIN
  INSERT INTO workspace_backup_state (owner_id, revision) VALUES (OLD.owner_id, 1)
  ON CONFLICT(owner_id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_client_products_insert AFTER INSERT ON client_products
BEGIN
  INSERT INTO workspace_backup_state (owner_id, revision) VALUES (NEW.owner_id, 1)
  ON CONFLICT(owner_id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_client_products_update AFTER UPDATE ON client_products
BEGIN
  INSERT INTO workspace_backup_state (owner_id, revision) VALUES (NEW.owner_id, 1)
  ON CONFLICT(owner_id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_client_products_delete AFTER DELETE ON client_products
BEGIN
  INSERT INTO workspace_backup_state (owner_id, revision) VALUES (OLD.owner_id, 1)
  ON CONFLICT(owner_id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_ticket_clients_insert AFTER INSERT ON ticket_clients
BEGIN
  INSERT INTO workspace_backup_state (owner_id, revision) VALUES (NEW.owner_id, 1)
  ON CONFLICT(owner_id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_ticket_clients_update AFTER UPDATE ON ticket_clients
BEGIN
  INSERT INTO workspace_backup_state (owner_id, revision) VALUES (NEW.owner_id, 1)
  ON CONFLICT(owner_id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_ticket_clients_delete AFTER DELETE ON ticket_clients
BEGIN
  INSERT INTO workspace_backup_state (owner_id, revision) VALUES (OLD.owner_id, 1)
  ON CONFLICT(owner_id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_ticket_client_products_insert AFTER INSERT ON ticket_client_products
BEGIN
  INSERT INTO workspace_backup_state (owner_id, revision) VALUES (NEW.owner_id, 1)
  ON CONFLICT(owner_id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_ticket_client_products_update AFTER UPDATE ON ticket_client_products
BEGIN
  INSERT INTO workspace_backup_state (owner_id, revision) VALUES (NEW.owner_id, 1)
  ON CONFLICT(owner_id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_ticket_client_products_delete AFTER DELETE ON ticket_client_products
BEGIN
  INSERT INTO workspace_backup_state (owner_id, revision) VALUES (OLD.owner_id, 1)
  ON CONFLICT(owner_id) DO UPDATE SET revision = revision + 1;
END;
