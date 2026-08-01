ALTER TABLE `outlets` ADD `cadence` text;--> statement-breakpoint
ALTER TABLE `publications` ADD `scheduled_for` text;--> statement-breakpoint
ALTER TABLE `publications` ADD `urgency` text;--> statement-breakpoint
CREATE INDEX `publications_scheduled_idx` ON `publications` (`scheduled_for`);