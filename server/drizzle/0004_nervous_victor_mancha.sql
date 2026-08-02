CREATE TABLE `assist_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` integer NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`status` text NOT NULL,
	`diagnosis` text,
	`confidence` text,
	`bundle_sha` text,
	`rejected` text,
	`error` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assist_sessions_event_idx` ON `assist_sessions` (`event_id`);--> statement-breakpoint
CREATE TABLE `remedies` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`risk` text DEFAULT 'safe' NOT NULL,
	`title` text NOT NULL,
	`rationale` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'PROPOSED' NOT NULL,
	`applied_at` text,
	`applied_event_id` integer,
	`error` text,
	FOREIGN KEY (`session_id`) REFERENCES `assist_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`applied_event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `remedies_session_idx` ON `remedies` (`session_id`);--> statement-breakpoint
CREATE INDEX `remedies_status_idx` ON `remedies` (`status`);