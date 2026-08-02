CREATE TABLE `browser_engines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`api_base` text NOT NULL,
	`viewer` text DEFAULT 'novnc' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `publish_traces` (
	`id` text PRIMARY KEY NOT NULL,
	`publication_id` text NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`phase` text NOT NULL,
	`action` text NOT NULL,
	`selector` text,
	`url` text,
	`ok` integer NOT NULL,
	`detail` text,
	`screenshot_path` text,
	FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `publish_traces_pub_idx` ON `publish_traces` (`publication_id`);--> statement-breakpoint
ALTER TABLE `outlets` ADD `engine_id` text REFERENCES browser_engines(id);--> statement-breakpoint
ALTER TABLE `outlets` ADD `recipe` text;--> statement-breakpoint
ALTER TABLE `publications` ADD `staged_at` text;--> statement-breakpoint
ALTER TABLE `publications` ADD `evidence` text;