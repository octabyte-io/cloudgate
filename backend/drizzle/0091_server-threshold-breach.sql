ALTER TABLE "server" ADD COLUMN "cpu_breached_since" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "memory_breached_since" text;--> statement-breakpoint
ALTER TABLE "web_server_settings" ADD COLUMN "cpu_breached_since" text;--> statement-breakpoint
ALTER TABLE "web_server_settings" ADD COLUMN "memory_breached_since" text;