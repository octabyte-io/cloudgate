CREATE TABLE "existing_database" (
	"existing_database_id" text PRIMARY KEY NOT NULL,
	"postgres_id" text NOT NULL,
	"cloud_account_id" text NOT NULL,
	"region" text NOT NULL,
	"identifier" text NOT NULL,
	"made_reachable" boolean DEFAULT false NOT NULL,
	"address" jsonb,
	CONSTRAINT "existing_database_postgres_id_unique" UNIQUE("postgres_id")
);
--> statement-breakpoint
ALTER TABLE "existing_database" ADD CONSTRAINT "existing_database_postgres_id_postgres_postgres_id_fk" FOREIGN KEY ("postgres_id") REFERENCES "public"."postgres"("postgres_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "existing_database" ADD CONSTRAINT "existing_database_cloud_account_id_cloud_account_cloud_account_id_fk" FOREIGN KEY ("cloud_account_id") REFERENCES "public"."cloud_account"("cloud_account_id") ON DELETE no action ON UPDATE no action;