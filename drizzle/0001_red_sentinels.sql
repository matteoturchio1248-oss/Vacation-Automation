CREATE TABLE `vacation_accrual_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`vacation_year` integer NOT NULL,
	`monthly_rate` real DEFAULT 0 NOT NULL,
	`opening_balance` real DEFAULT 0 NOT NULL,
	`accrual_start_date` text,
	`updated_by` integer,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accrual_profile_user_year_idx` ON `vacation_accrual_profiles` (`user_id`,`vacation_year`);--> statement-breakpoint
CREATE TABLE `vacation_balance_adjustments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`vacation_year` integer NOT NULL,
	`amount_days` real NOT NULL,
	`effective_date` text NOT NULL,
	`note` text NOT NULL,
	`created_by` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `users` ADD `is_master_admin` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `vacation_requests` ADD `last_reminder_at` text;--> statement-breakpoint
ALTER TABLE `vacation_requests` ADD `reminder_count` integer DEFAULT 0 NOT NULL;