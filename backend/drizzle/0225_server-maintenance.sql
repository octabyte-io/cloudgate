ALTER TABLE "server" ADD COLUMN "maintenance_since" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "maintenance_started_by" text;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_maintenance_started_by_user_id_fk" FOREIGN KEY ("maintenance_started_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;