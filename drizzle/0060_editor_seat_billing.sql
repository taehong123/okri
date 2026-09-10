ALTER TABLE `billing_paypal_subscriptions` ADD `seat_count` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `billing_paypal_subscriptions` ADD `pending_seat_count` integer;
