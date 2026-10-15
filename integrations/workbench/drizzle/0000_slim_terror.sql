CREATE TABLE `evo_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`job` text NOT NULL,
	`connection` text NOT NULL,
	`case_id` text NOT NULL,
	`repeat_no` integer NOT NULL,
	`status` text NOT NULL,
	`lease` text,
	`lease_until` integer,
	`input` text NOT NULL,
	`result` text,
	`result_hash` text,
	`created` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `evo_attempts_queue` ON `evo_attempts` (`project`,`connection`,`status`);--> statement-breakpoint
CREATE INDEX `evo_attempts_job` ON `evo_attempts` (`project`,`job`);--> statement-breakpoint
CREATE TABLE `evo_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`kind` text NOT NULL,
	`created` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`project`) REFERENCES `evo_projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `evo_objects_project` ON `evo_objects` (`project`,`kind`);--> statement-breakpoint
CREATE TABLE `evo_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`created` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `evo_projects_owner` ON `evo_projects` (`owner`);--> statement-breakpoint
CREATE TABLE `evo_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`connection` text NOT NULL,
	`digest` text NOT NULL,
	`created` text NOT NULL,
	`revoked` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project`) REFERENCES `evo_projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evo_tokens_digest` ON `evo_tokens` (`digest`);