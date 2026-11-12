ALTER TABLE "container_metric" ALTER COLUMN "server_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "server_metric" ALTER COLUMN "server_id" DROP NOT NULL;