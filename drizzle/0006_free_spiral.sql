ALTER TABLE `users` ADD `job_title` text;--> statement-breakpoint
ALTER TABLE `users` ADD `compensation_amount_cents` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `compensation_frequency` text;--> statement-breakpoint
ALTER TABLE `users` ADD `phone` text;--> statement-breakpoint
ALTER TABLE `users` ADD `work_location` text;--> statement-breakpoint
ALTER TABLE `users` ADD `employee_notes` text;--> statement-breakpoint
ALTER TABLE `users` ADD `has_portal_access` integer DEFAULT true NOT NULL;