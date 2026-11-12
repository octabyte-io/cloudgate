ALTER TABLE "subscription" ADD COLUMN "bought_servers_payment_failed_at" timestamp (3);--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "bought_servers_failed_invoice_id" text;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "bought_servers_day_before_sent_at" timestamp (3);--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "bought_servers_deleted_sent_at" timestamp (3);