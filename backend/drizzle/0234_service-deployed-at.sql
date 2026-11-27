ALTER TABLE "bucket" ADD COLUMN "deployed_at" text;--> statement-breakpoint
ALTER TABLE "libsql" ADD COLUMN "deployed_at" text;--> statement-breakpoint
ALTER TABLE "mariadb" ADD COLUMN "deployed_at" text;--> statement-breakpoint
ALTER TABLE "mongo" ADD COLUMN "deployed_at" text;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "deployed_at" text;--> statement-breakpoint
ALTER TABLE "postgres" ADD COLUMN "deployed_at" text;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "deployed_at" text;--> statement-breakpoint
UPDATE "bucket" SET "deployed_at" = "created_at" WHERE "application_status" <> 'idle';--> statement-breakpoint
UPDATE "libsql" SET "deployed_at" = "created_at" WHERE "application_status" <> 'idle';--> statement-breakpoint
UPDATE "mariadb" SET "deployed_at" = "created_at" WHERE "application_status" <> 'idle';--> statement-breakpoint
UPDATE "mongo" SET "deployed_at" = "created_at" WHERE "application_status" <> 'idle';--> statement-breakpoint
UPDATE "mysql" SET "deployed_at" = "created_at" WHERE "application_status" <> 'idle';--> statement-breakpoint
UPDATE "postgres" SET "deployed_at" = "created_at" WHERE "application_status" <> 'idle';--> statement-breakpoint
UPDATE "redis" SET "deployed_at" = "created_at" WHERE "application_status" <> 'idle';