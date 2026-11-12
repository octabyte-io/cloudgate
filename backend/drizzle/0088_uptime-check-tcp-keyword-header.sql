ALTER TABLE "uptime_check" ADD COLUMN "port" integer;--> statement-breakpoint
ALTER TABLE "uptime_check" ADD COLUMN "keyword" text;--> statement-breakpoint
ALTER TABLE "uptime_check" ADD COLUMN "header_name" text;--> statement-breakpoint
ALTER TABLE "uptime_check" ADD COLUMN "header_value" text;--> statement-breakpoint
ALTER TABLE "uptime_check" ADD CONSTRAINT "uptime_check_tcp_has_port" CHECK ("kind" <> 'tcp' OR ("port" IS NOT NULL AND "domain_id" IS NULL AND "keyword" IS NULL AND "header_name" IS NULL AND "header_value" IS NULL));--> statement-breakpoint
ALTER TABLE "uptime_check" ADD CONSTRAINT "uptime_check_header_value_has_name" CHECK ("header_value" IS NULL OR "header_name" IS NOT NULL);