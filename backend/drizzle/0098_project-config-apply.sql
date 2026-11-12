-- Applying a Plan: the text a plan was made from (an edited YAML is
-- stored only when its plan is applied) and the stored text it was made
-- against, each step's result, and on every Service a plan writes the plan
-- that last wrote its config-owned fields.
--
-- drizzle-kit's own, except that `base_text_hash` is backfilled before it
-- becomes NOT NULL.
ALTER TABLE "application" ADD COLUMN "config_plan_id" text;--> statement-breakpoint
ALTER TABLE "postgres" ADD COLUMN "config_plan_id" text;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "config_plan_id" text;--> statement-breakpoint
ALTER TABLE "plan" ADD COLUMN "text" text;--> statement-breakpoint
ALTER TABLE "plan" ADD COLUMN "base_text_hash" text;--> statement-breakpoint
-- A plan made before this planned the stored text itself, so the text it was
-- made against is the one it read.
UPDATE "plan" SET "base_text_hash" = "text_hash";--> statement-breakpoint
ALTER TABLE "plan" ALTER COLUMN "base_text_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "plan" ADD COLUMN "results" jsonb;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_config_plan_id_plan_plan_id_fk" FOREIGN KEY ("config_plan_id") REFERENCES "public"."plan"("plan_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postgres" ADD CONSTRAINT "postgres_config_plan_id_plan_plan_id_fk" FOREIGN KEY ("config_plan_id") REFERENCES "public"."plan"("plan_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redis" ADD CONSTRAINT "redis_config_plan_id_plan_plan_id_fk" FOREIGN KEY ("config_plan_id") REFERENCES "public"."plan"("plan_id") ON DELETE set null ON UPDATE no action;