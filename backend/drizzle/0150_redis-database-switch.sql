ALTER TABLE "database_switch" ADD COLUMN "kind" text DEFAULT 'postgres' NOT NULL;--> statement-breakpoint
ALTER TABLE "database_switch" ADD COLUMN "tls" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "database_switch" ADD COLUMN "auth_token" text;