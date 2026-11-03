CREATE TABLE `integration_viewer_mapping` (
	`integration_id` text NOT NULL,
	`user_id` text NOT NULL,
	`external_user_id` text NOT NULL,
	PRIMARY KEY(`integration_id`, `user_id`),
	FOREIGN KEY (`integration_id`) REFERENCES `integration`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `integration` ADD `viewer_scoping` text DEFAULT 'off' NOT NULL;