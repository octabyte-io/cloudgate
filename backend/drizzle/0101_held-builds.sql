ALTER TYPE "public"."deployment_status" ADD VALUE 'held';--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "held_by_plan_id" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_held_by_plan_id_plan_plan_id_fk" FOREIGN KEY ("held_by_plan_id") REFERENCES "public"."plan"("plan_id") ON DELETE set null ON UPDATE no action;