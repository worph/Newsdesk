-- Editorial vocabulary: personas → voices (with `voice` → `tone`), sources →
-- stringers, and the stored role names the pipeline writes. SQLite carries
-- foreign keys and index definitions through RENAME, so only the index whose
-- *name* changed is rebuilt.
ALTER TABLE `personas` RENAME TO `voices`;--> statement-breakpoint
ALTER TABLE `voices` RENAME COLUMN `voice` TO `tone`;--> statement-breakpoint
ALTER TABLE `targets` RENAME COLUMN `persona_id` TO `voice_id`;--> statement-breakpoint
ALTER TABLE `sources` RENAME TO `stringers`;--> statement-breakpoint
ALTER TABLE `submissions` RENAME COLUMN `source_id` TO `stringer_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `submissions_source_idx`;--> statement-breakpoint
CREATE INDEX `submissions_stringer_idx` ON `submissions` (`stringer_id`);--> statement-breakpoint
UPDATE `stringers` SET `kind` = 'tip' WHERE `kind` = 'idea';--> statement-breakpoint
UPDATE `submissions` SET `kind` = 'tip' WHERE `kind` = 'idea';--> statement-breakpoint
UPDATE `publications` SET `origin` = 'managing-editor' WHERE `origin` = 'director';--> statement-breakpoint
UPDATE `draft_versions` SET `origin` = 'copy-desk' WHERE `origin` = 'assistant';--> statement-breakpoint
UPDATE `inference_calls` SET `purpose` = 'managing-editor' WHERE `purpose` = 'director';--> statement-breakpoint
UPDATE `inference_calls` SET `purpose` = 'copy-desk' WHERE `purpose` = 'assistant';--> statement-breakpoint
UPDATE `jobs` SET `kind` = 'assign' WHERE `kind` = 'direct';
