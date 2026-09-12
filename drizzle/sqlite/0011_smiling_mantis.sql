ALTER TABLE `ssh_data` ADD `enable_stream` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `stream_url` text;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `stream_path` text;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `stream_mode` text;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `stream_publisher` text;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `stream_credential_id` integer REFERENCES ssh_credentials(id);--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `stream_user` text;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `stream_password` text;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `stream_auth_type` text;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `rdp_render_engine` text;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `rdp_enable_printing` integer DEFAULT false;