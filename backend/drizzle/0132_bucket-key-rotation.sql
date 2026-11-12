ALTER TABLE "bucket" ADD COLUMN "key_rotation" jsonb;--> statement-breakpoint
ALTER TABLE "bucket" ADD COLUMN "rotation_keys" text;