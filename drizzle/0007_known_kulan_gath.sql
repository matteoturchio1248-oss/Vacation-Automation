ALTER TABLE `vacation_requests` ADD `employment_type_snapshot` text;--> statement-breakpoint
ALTER TABLE `vacation_requests` ADD `hr_finalized` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `vacation_requests` ADD `hr_finalized_by` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `vacation_requests` ADD `hr_finalized_at` text;--> statement-breakpoint
ALTER TABLE `vacation_requests` ADD `payroll_saved_by` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `vacation_requests` ADD `payroll_saved_at` text;