ALTER TYPE "public"."plan_source" ADD VALUE 'deploy';--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "review_plan_id" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_review_plan_id_plan_plan_id_fk" FOREIGN KEY ("review_plan_id") REFERENCES "public"."plan"("plan_id") ON DELETE set null ON UPDATE no action;