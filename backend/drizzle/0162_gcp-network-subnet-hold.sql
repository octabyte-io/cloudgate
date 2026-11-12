ALTER TABLE "environment_network" ADD COLUMN "hold_next_try_at" text;--> statement-breakpoint
ALTER TABLE "environment_network" ADD COLUMN "hold_tries_left" integer;