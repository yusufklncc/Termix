CREATE TABLE `vpn_profiles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`folder` varchar(255),
	`tags` text,
	`kind` text NOT NULL DEFAULT ('declared'),
	`gateway_type` text NOT NULL DEFAULT ('socks5'),
	`gateway_host` text NOT NULL,
	`gateway_port` int NOT NULL,
	`gateway_username` text,
	`gateway_password` text,
	`created_at` varchar(255) NOT NULL DEFAULT 'CURRENT_TIMESTAMP',
	`updated_at` varchar(255) NOT NULL DEFAULT 'CURRENT_TIMESTAMP',
	CONSTRAINT `vpn_profiles_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `vpn_profile_id` int;--> statement-breakpoint
ALTER TABLE `vpn_profiles` ADD CONSTRAINT `vpn_profiles_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD CONSTRAINT `ssh_data_vpn_profile_id_vpn_profiles_id_fk` FOREIGN KEY (`vpn_profile_id`) REFERENCES `vpn_profiles`(`id`) ON DELETE set null ON UPDATE no action;