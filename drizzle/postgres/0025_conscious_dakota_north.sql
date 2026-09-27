ALTER TABLE "ssh_data" ADD COLUMN "enable_stream" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ssh_data" ADD COLUMN "stream_url" text;--> statement-breakpoint
ALTER TABLE "ssh_data" ADD COLUMN "stream_path" text;--> statement-breakpoint
ALTER TABLE "ssh_data" ADD COLUMN "stream_mode" text;--> statement-breakpoint
ALTER TABLE "ssh_data" ADD COLUMN "stream_publisher" text;--> statement-breakpoint
ALTER TABLE "ssh_data" ADD COLUMN "stream_credential_id" integer;--> statement-breakpoint
ALTER TABLE "ssh_data" ADD COLUMN "stream_user" text;--> statement-breakpoint
ALTER TABLE "ssh_data" ADD COLUMN "stream_password" text;--> statement-breakpoint
ALTER TABLE "ssh_data" ADD COLUMN "stream_auth_type" text;--> statement-breakpoint
ALTER TABLE "ssh_data" ADD COLUMN "rdp_render_engine" text;--> statement-breakpoint
ALTER TABLE "ssh_data" ADD COLUMN "rdp_enable_printing" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "ssh_data" ADD CONSTRAINT "ssh_data_stream_credential_id_ssh_credentials_id_fk" FOREIGN KEY ("stream_credential_id") REFERENCES "public"."ssh_credentials"("id") ON DELETE set null ON UPDATE no action;