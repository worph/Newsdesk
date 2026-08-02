CREATE TABLE `config_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`author` text NOT NULL,
	`reason` text,
	`yaml` text NOT NULL,
	`sha256` text NOT NULL,
	`restored_from_id` integer
);
--> statement-breakpoint
CREATE INDEX `config_versions_at_idx` ON `config_versions` (`at`);