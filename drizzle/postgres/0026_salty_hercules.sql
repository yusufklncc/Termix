CREATE TABLE "vpn_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"folder" varchar(255),
	"tags" text,
	"kind" text DEFAULT 'declared' NOT NULL,
	"gateway_type" text DEFAULT 'socks5' NOT NULL,
	"gateway_host" text NOT NULL,
	"gateway_port" integer NOT NULL,
	"gateway_username" text,
	"gateway_password" text,
	"created_at" varchar(255) DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	"updated_at" varchar(255) DEFAULT 'CURRENT_TIMESTAMP' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ssh_data" ADD COLUMN "vpn_profile_id" integer;--> statement-breakpoint
ALTER TABLE "vpn_profiles" ADD CONSTRAINT "vpn_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_data" ADD CONSTRAINT "ssh_data_vpn_profile_id_vpn_profiles_id_fk" FOREIGN KEY ("vpn_profile_id") REFERENCES "public"."vpn_profiles"("id") ON DELETE set null ON UPDATE no action;