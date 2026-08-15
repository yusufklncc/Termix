ALTER TABLE `ssh_data` ADD `enable_stream` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `stream_url` text;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `stream_path` text;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `stream_credential_id` int;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `stream_user` text;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `stream_password` text;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD `stream_auth_type` text;--> statement-breakpoint
ALTER TABLE `ssh_data` ADD CONSTRAINT `ssh_data_stream_credential_id_ssh_credentials_id_fk` FOREIGN KEY (`stream_credential_id`) REFERENCES `ssh_credentials`(`id`) ON DELETE set null ON UPDATE no action;