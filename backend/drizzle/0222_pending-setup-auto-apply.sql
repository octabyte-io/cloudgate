CREATE TYPE "public"."pending_setup_auto_apply" AS ENUM('waiting', 'applying', 'applied', 'refused');--> statement-breakpoint
ALTER TABLE "pending_setup" ADD COLUMN "auto_apply_by" text;--> statement-breakpoint
ALTER TABLE "pending_setup" ADD COLUMN "auto_apply_state" "pending_setup_auto_apply";--> statement-breakpoint
ALTER TABLE "pending_setup" ADD COLUMN "auto_apply_message" text;--> statement-breakpoint
ALTER TABLE "pending_setup" ADD CONSTRAINT "pending_setup_auto_apply_by_user_id_fk" FOREIGN KEY ("auto_apply_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;