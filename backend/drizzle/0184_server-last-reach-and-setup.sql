ALTER TABLE "server" ADD COLUMN "reach_checked_at" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "reach_ok" boolean;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "reach_message" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "setup_ran_at" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "setup_ok" boolean;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "setup_message" text;