ALTER TABLE "vpn_profiles" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "vpn_profiles" ADD COLUMN "server_host" text;--> statement-breakpoint
ALTER TABLE "vpn_profiles" ADD COLUMN "server_port" integer;--> statement-breakpoint
ALTER TABLE "vpn_profiles" ADD COLUMN "auth_username" text;--> statement-breakpoint
ALTER TABLE "vpn_profiles" ADD COLUMN "auth_password" text;--> statement-breakpoint
ALTER TABLE "vpn_profiles" ADD COLUMN "trusted_fingerprint" text;--> statement-breakpoint
ALTER TABLE "vpn_profiles" ADD COLUMN "extra_config" text;--> statement-breakpoint
ALTER TABLE "vpn_profiles" ADD COLUMN "last_state" text;--> statement-breakpoint
ALTER TABLE "vpn_profiles" ADD COLUMN "last_error" text;