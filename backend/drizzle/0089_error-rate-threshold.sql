CREATE TABLE "error_rate_threshold" (
	"error_rate_threshold_id" text PRIMARY KEY NOT NULL,
	"service_type" "service_type" NOT NULL,
	"application_id" text,
	"compose_id" text,
	"percentage" double precision DEFAULT 5 NOT NULL,
	"window_minutes" integer DEFAULT 5 NOT NULL,
	"min_requests" integer DEFAULT 20 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "error_rate_threshold_application_id_unique" UNIQUE("application_id"),
	CONSTRAINT "error_rate_threshold_compose_id_unique" UNIQUE("compose_id"),
	CONSTRAINT "error_rate_threshold_parent_matches_service_type" CHECK (num_nonnulls("application_id", "compose_id") = 1
    AND (CASE "service_type"
           WHEN 'application' THEN "application_id"
           WHEN 'compose'     THEN "compose_id"
         END) IS NOT NULL),
	CONSTRAINT "error_rate_threshold_window_allowed" CHECK ("window_minutes" IN (1, 5, 15, 30))
);
--> statement-breakpoint
ALTER TABLE "incident" DROP CONSTRAINT "incident_exactly_one_owner";--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "error_rate_threshold_id" text;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "opening_error_rate" double precision;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "opening_requests" integer;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "worst_error_rate" double precision;--> statement-breakpoint
ALTER TABLE "error_rate_threshold" ADD CONSTRAINT "error_rate_threshold_application_id_application_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_rate_threshold" ADD CONSTRAINT "error_rate_threshold_compose_id_compose_compose_id_fk" FOREIGN KEY ("compose_id") REFERENCES "public"."compose"("compose_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_error_rate_threshold_id_error_rate_threshold_error_rate_threshold_id_fk" FOREIGN KEY ("error_rate_threshold_id") REFERENCES "public"."error_rate_threshold"("error_rate_threshold_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_one_open_per_error_rate_threshold" ON "incident" USING btree ("error_rate_threshold_id") WHERE "incident"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "incident_error_rate_threshold_opened_at_idx" ON "incident" USING btree ("error_rate_threshold_id","opened_at");--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_threshold_has_rates" CHECK (("error_rate_threshold_id" IS NULL) = ("opening_error_rate" IS NULL)
    AND ("error_rate_threshold_id" IS NULL) = ("opening_requests" IS NULL)
    AND ("error_rate_threshold_id" IS NULL) = ("worst_error_rate" IS NULL));--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_exactly_one_owner" CHECK (num_nonnulls("uptime_check_id", "error_rate_threshold_id") = 1);