CREATE TABLE `vpn_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`folder` text,
	`tags` text,
	`kind` text DEFAULT 'declared' NOT NULL,
	`gateway_type` text DEFAULT 'socks5' NOT NULL,
	`gateway_host` text NOT NULL,
	`gateway_port` integer NOT NULL,
	`gateway_username` text,
	`gateway_password` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	`updated_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `vpn_profile_id` integer REFERENCES vpn_profiles(id);