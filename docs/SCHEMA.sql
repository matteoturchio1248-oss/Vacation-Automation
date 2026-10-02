-- Fresh database only. Generated from ordered migrations at 4a71bad3805f9419c74f221fa828daa606d25cee

-- 0000_slimy_mysterio

CREATE TABLE `departments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`manager_user_id` integer,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `departments_name_unique` ON `departments` (`name`);--> statement-breakpoint
CREATE TABLE `notification_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` integer,
	`recipients` text NOT NULL,
	`subject` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `vacation_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`full_name` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`role` text DEFAULT 'employee' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`employment_type` text DEFAULT 'hourly' NOT NULL,
	`department_id` integer,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `vacation_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`employee_id` integer NOT NULL,
	`department_id` integer NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`total_days` text NOT NULL,
	`vacation_pay_requested` integer DEFAULT false NOT NULL,
	`vacation_pay_amount_cents` integer,
	`employee_notes` text,
	`employee_acknowledged_at` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decision_by` integer,
	`decision_notes` text,
	`decided_at` text,
	`payroll_processed` integer DEFAULT false NOT NULL,
	`payroll_date` text,
	`payroll_amount_paid_cents` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decision_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);



-- 0001_red_sentinels

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


-- 0002_reflective_sasquatch

ALTER TABLE `notification_log` ADD `html_body` text;--> statement-breakpoint
ALTER TABLE `notification_log` ADD `attempt_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_log` ADD `last_attempt_at` text;


-- 0003_faulty_major_mapleleaf

CREATE TABLE `personal_reminders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_user_id` integer NOT NULL,
	`related_employee_id` integer,
	`title` text NOT NULL,
	`details` text,
	`category` text DEFAULT 'custom' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`due_date` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`source_type` text,
	`source_id` integer,
	`completed_at` text,
	`created_by` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`related_employee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reminder_source_owner_idx` ON `personal_reminders` (`owner_user_id`,`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow_type` text NOT NULL,
	`employee_id` integer NOT NULL,
	`title` text NOT NULL,
	`target_date` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`started_by` integer NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`employee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`started_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workflow_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`title` text NOT NULL,
	`details` text,
	`branch_label` text,
	`sort_order` integer NOT NULL,
	`due_date` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`completed_by` integer,
	`completed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`completed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `users` ADD `work_schedule` text;


-- 0004_flashy_secret_warriors

ALTER TABLE `personal_reminders` ADD `last_notified_at` text;


-- 0005_serious_dreadnoughts

ALTER TABLE `users` ADD `hire_date` text;--> statement-breakpoint
ALTER TABLE `users` ADD `termination_date` text;--> statement-breakpoint
ALTER TABLE `users` ADD `leave_start_date` text;--> statement-breakpoint
ALTER TABLE `users` ADD `leave_end_date` text;


-- 0006_free_spiral

ALTER TABLE `users` ADD `job_title` text;--> statement-breakpoint
ALTER TABLE `users` ADD `compensation_amount_cents` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `compensation_frequency` text;--> statement-breakpoint
ALTER TABLE `users` ADD `phone` text;--> statement-breakpoint
ALTER TABLE `users` ADD `work_location` text;--> statement-breakpoint
ALTER TABLE `users` ADD `employee_notes` text;--> statement-breakpoint
ALTER TABLE `users` ADD `has_portal_access` integer DEFAULT true NOT NULL;


-- 0007_known_kulan_gath

ALTER TABLE `vacation_requests` ADD `employment_type_snapshot` text;--> statement-breakpoint
ALTER TABLE `vacation_requests` ADD `hr_finalized` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `vacation_requests` ADD `hr_finalized_by` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `vacation_requests` ADD `hr_finalized_at` text;--> statement-breakpoint
ALTER TABLE `vacation_requests` ADD `payroll_saved_by` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `vacation_requests` ADD `payroll_saved_at` text;


-- 0008_faulty_albert_cleary

CREATE TABLE `approval_maps` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`graph_json` text NOT NULL,
	`write_token` text NOT NULL,
	`updated_by` integer NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `approval_routes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`map_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` integer NOT NULL,
	`target_kind` text,
	`target_id` integer,
	FOREIGN KEY (`map_id`) REFERENCES `approval_maps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approval_route_source_idx` ON `approval_routes` (`map_id`,`source_kind`,`source_id`);
