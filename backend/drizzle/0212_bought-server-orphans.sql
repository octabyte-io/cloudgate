CREATE TABLE "bought_server_orphan" (
	"provider_server_id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"location" text NOT NULL,
	"labels" jsonb NOT NULL,
	"volume_ids" integer[] NOT NULL,
	"primary_ip_ids" integer[] NOT NULL,
	"machine_created_at" timestamp (3) NOT NULL,
	"found_at" timestamp (3) NOT NULL,
	"seen_at" timestamp (3) NOT NULL
);
