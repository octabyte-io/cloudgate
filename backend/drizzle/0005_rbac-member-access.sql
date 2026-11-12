ALTER TABLE "member" ADD COLUMN "accessed_projects" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "accessed_services" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "accessed_environments" text[] DEFAULT '{}'::text[] NOT NULL;