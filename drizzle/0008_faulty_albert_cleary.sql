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