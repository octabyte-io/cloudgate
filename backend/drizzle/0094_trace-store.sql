CREATE TABLE "trace_store" (
	"trace_store_id" text PRIMARY KEY NOT NULL,
	"service_type" "service_type" NOT NULL,
	"application_id" text,
	"compose_id" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"retention_days" integer DEFAULT 3 NOT NULL,
	"credential" text NOT NULL,
	"query_credential" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "trace_store_application_id_unique" UNIQUE("application_id"),
	CONSTRAINT "trace_store_compose_id_unique" UNIQUE("compose_id"),
	CONSTRAINT "trace_store_parent_matches_service_type" CHECK (num_nonnulls("application_id", "compose_id") = 1
    AND (CASE "service_type"
           WHEN 'application' THEN "application_id"
           WHEN 'compose'     THEN "compose_id"
         END) IS NOT NULL),
	CONSTRAINT "trace_store_retention_allowed" CHECK ("retention_days" IN (1, 3, 7))
);
--> statement-breakpoint
ALTER TABLE "trace_store" ADD CONSTRAINT "trace_store_application_id_application_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_store" ADD CONSTRAINT "trace_store_compose_id_compose_compose_id_fk" FOREIGN KEY ("compose_id") REFERENCES "public"."compose"("compose_id") ON DELETE cascade ON UPDATE no action;