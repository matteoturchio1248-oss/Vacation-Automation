ALTER TABLE `notification_log` ADD `html_body` text;--> statement-breakpoint
ALTER TABLE `notification_log` ADD `attempt_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_log` ADD `last_attempt_at` text;