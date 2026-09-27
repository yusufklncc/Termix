ALTER TABLE `vpn_profiles` ADD `provider` text;--> statement-breakpoint
ALTER TABLE `vpn_profiles` ADD `server_host` text;--> statement-breakpoint
ALTER TABLE `vpn_profiles` ADD `server_port` integer;--> statement-breakpoint
ALTER TABLE `vpn_profiles` ADD `auth_username` text;--> statement-breakpoint
ALTER TABLE `vpn_profiles` ADD `auth_password` text;--> statement-breakpoint
ALTER TABLE `vpn_profiles` ADD `trusted_fingerprint` text;--> statement-breakpoint
ALTER TABLE `vpn_profiles` ADD `extra_config` text;--> statement-breakpoint
ALTER TABLE `vpn_profiles` ADD `last_state` text;--> statement-breakpoint
ALTER TABLE `vpn_profiles` ADD `last_error` text;