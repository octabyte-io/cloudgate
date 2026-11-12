ALTER TABLE "bought_server" ADD COLUMN "disk_gb" integer;--> statement-breakpoint
ALTER TABLE "bought_server" ADD COLUMN "deletion_credited" boolean DEFAULT true NOT NULL;