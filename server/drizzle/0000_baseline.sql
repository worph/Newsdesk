CREATE TABLE `charter` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`text` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`author` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`publication_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`version_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`version_id`) REFERENCES `draft_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chat_messages_pub_idx` ON `chat_messages` (`publication_id`);--> statement-breakpoint
CREATE TABLE `dossier_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`filing_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`via` text NOT NULL,
	`query` text,
	`ok` integer NOT NULL,
	`chars` integer,
	`fetched_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`filing_id`) REFERENCES `filings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dossier_sources_filing_idx` ON `dossier_sources` (`filing_id`);--> statement-breakpoint
CREATE TABLE `draft_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`publication_id` text NOT NULL,
	`slots` text NOT NULL,
	`origin` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `draft_versions_pub_idx` ON `draft_versions` (`publication_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`level` text NOT NULL,
	`actor` text NOT NULL,
	`code` text NOT NULL,
	`story_id` text,
	`publication_id` text,
	`message` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `events_at_idx` ON `events` (`at`);--> statement-breakpoint
CREATE INDEX `events_level_idx` ON `events` (`level`);--> statement-breakpoint
CREATE TABLE `filings` (
	`id` text PRIMARY KEY NOT NULL,
	`stringer_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`considered` text,
	`dossier` text,
	`reported_at` text,
	`refs` text,
	`filed_at` text,
	`received_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`status` text NOT NULL,
	`outcome` text,
	FOREIGN KEY (`stringer_id`) REFERENCES `stringers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `filings_status_idx` ON `filings` (`status`);--> statement-breakpoint
CREATE INDEX `filings_stringer_idx` ON `filings` (`stringer_id`);--> statement-breakpoint
CREATE TABLE `inference_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`purpose` text NOT NULL,
	`ref_id` text,
	`duration_ms` integer,
	`ok` integer NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_after` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_status_runafter_idx` ON `jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE TABLE `mcp_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`auth` text,
	`catalogue` text,
	`discovered_at` text,
	`status` text
);
--> statement-breakpoint
CREATE TABLE `outlets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`role` text DEFAULT 'publish' NOT NULL,
	`driver` text DEFAULT 'mcp' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`voice_id` text,
	`endpoint_id` text,
	`tool` text,
	`destination_key` text,
	`args_spec` text NOT NULL,
	FOREIGN KEY (`voice_id`) REFERENCES `voices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`endpoint_id`) REFERENCES `mcp_endpoints`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `publications` (
	`id` text PRIMARY KEY NOT NULL,
	`story_id` text NOT NULL,
	`outlet_id` text NOT NULL,
	`status` text NOT NULL,
	`origin` text NOT NULL,
	`placement_reason` text,
	`angle` text,
	`slots` text,
	`payload` text,
	`external_id` text,
	`external_url` text,
	`error` text,
	`approved_at` text,
	`published_at` text,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`outlet_id`) REFERENCES `outlets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publications_story_outlet_idx` ON `publications` (`story_id`,`outlet_id`);--> statement-breakpoint
CREATE INDEX `publications_status_idx` ON `publications` (`status`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`keys` text NOT NULL,
	`ua` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stories` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`body` text,
	`url` text,
	`status` text NOT NULL,
	`dedup_verdict` text NOT NULL,
	`dedup_reason` text,
	`related_story_id` text,
	`compared_ids` text,
	`label` text,
	`drop_reason` text,
	`hold_reason` text,
	`proposed_placements` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stories_status_idx` ON `stories` (`status`);--> statement-breakpoint
CREATE INDEX `stories_created_idx` ON `stories` (`created_at`);--> statement-breakpoint
CREATE TABLE `story_filings` (
	`story_id` text NOT NULL,
	`filing_id` text NOT NULL,
	PRIMARY KEY(`story_id`, `filing_id`),
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`filing_id`) REFERENCES `filings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `stringers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`hint` text,
	`watermark` text,
	`last_snapshot` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `voices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`tone` text NOT NULL,
	`audience` text NOT NULL,
	`rules` text,
	`examples` text
);
