-- Service health's three rows: an Uptime check,
-- the Probes it records (pruned after seven days by their own job) and the
-- Incidents a run of down Probes opens, at most one open per check by a
-- partial unique index. Everything cascades from the owning Service (and an
-- HTTP check from its Domain), so a Delete leaves nothing behind and announces
-- nothing. Plus the notification flag that opts a channel into "Service
-- incidents", off like every other flag.
CREATE TYPE "public"."incident_close_reason" AS ENUM('recovered', 'service-stopped', 'turned-off');--> statement-breakpoint
CREATE TYPE "public"."probe_verdict" AS ENUM('up', 'down');--> statement-breakpoint
CREATE TYPE "public"."uptime_check_kind" AS ENUM('http', 'tcp');--> statement-breakpoint
CREATE TABLE "incident" (
	"incident_id" text PRIMARY KEY NOT NULL,
	"uptime_check_id" text,
	"opened_at" text NOT NULL,
	"closed_at" text,
	"opening_error" text,
	"close_reason" "incident_close_reason",
	CONSTRAINT "incident_exactly_one_owner" CHECK (num_nonnulls("uptime_check_id") = 1),
	CONSTRAINT "incident_closed_has_reason" CHECK (("closed_at" IS NULL) = ("close_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "probe" (
	"probe_id" text PRIMARY KEY NOT NULL,
	"uptime_check_id" text NOT NULL,
	"probed_at" text NOT NULL,
	"verdict" "probe_verdict" NOT NULL,
	"latency_ms" integer,
	"error_class" text
);
--> statement-breakpoint
CREATE TABLE "uptime_check" (
	"uptime_check_id" text PRIMARY KEY NOT NULL,
	"service_type" "service_type" NOT NULL,
	"application_id" text,
	"compose_id" text,
	"libsql_id" text,
	"mariadb_id" text,
	"mongo_id" text,
	"mysql_id" text,
	"postgres_id" text,
	"redis_id" text,
	"kind" "uptime_check_kind" NOT NULL,
	"domain_id" text,
	"interval_seconds" integer DEFAULT 60 NOT NULL,
	"timeout_seconds" integer DEFAULT 10 NOT NULL,
	"expected_statuses" text[] DEFAULT ARRAY['2xx']::text[] NOT NULL,
	"down_after" integer DEFAULT 3 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "uptime_check_parent_matches_service_type" CHECK (num_nonnulls("application_id", "compose_id", "libsql_id", "mariadb_id", "mongo_id", "mysql_id", "postgres_id", "redis_id") = 1
    AND (CASE "service_type"
           WHEN 'application' THEN "application_id"
           WHEN 'compose'     THEN "compose_id"
           WHEN 'libsql'      THEN "libsql_id"
           WHEN 'mariadb'     THEN "mariadb_id"
           WHEN 'mongo'       THEN "mongo_id"
           WHEN 'mysql'       THEN "mysql_id"
           WHEN 'postgres'    THEN "postgres_id"
           WHEN 'redis'       THEN "redis_id"
         END) IS NOT NULL),
	CONSTRAINT "uptime_check_http_has_domain" CHECK ("kind" <> 'http' OR "domain_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "service_incident" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_uptime_check_id_uptime_check_uptime_check_id_fk" FOREIGN KEY ("uptime_check_id") REFERENCES "public"."uptime_check"("uptime_check_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe" ADD CONSTRAINT "probe_uptime_check_id_uptime_check_uptime_check_id_fk" FOREIGN KEY ("uptime_check_id") REFERENCES "public"."uptime_check"("uptime_check_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_check" ADD CONSTRAINT "uptime_check_application_id_application_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_check" ADD CONSTRAINT "uptime_check_compose_id_compose_compose_id_fk" FOREIGN KEY ("compose_id") REFERENCES "public"."compose"("compose_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_check" ADD CONSTRAINT "uptime_check_libsql_id_libsql_libsql_id_fk" FOREIGN KEY ("libsql_id") REFERENCES "public"."libsql"("libsql_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_check" ADD CONSTRAINT "uptime_check_mariadb_id_mariadb_mariadb_id_fk" FOREIGN KEY ("mariadb_id") REFERENCES "public"."mariadb"("mariadb_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_check" ADD CONSTRAINT "uptime_check_mongo_id_mongo_mongo_id_fk" FOREIGN KEY ("mongo_id") REFERENCES "public"."mongo"("mongo_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_check" ADD CONSTRAINT "uptime_check_mysql_id_mysql_mysql_id_fk" FOREIGN KEY ("mysql_id") REFERENCES "public"."mysql"("mysql_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_check" ADD CONSTRAINT "uptime_check_postgres_id_postgres_postgres_id_fk" FOREIGN KEY ("postgres_id") REFERENCES "public"."postgres"("postgres_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_check" ADD CONSTRAINT "uptime_check_redis_id_redis_redis_id_fk" FOREIGN KEY ("redis_id") REFERENCES "public"."redis"("redis_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uptime_check" ADD CONSTRAINT "uptime_check_domain_id_domain_domain_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domain"("domain_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_one_open_per_uptime_check" ON "incident" USING btree ("uptime_check_id") WHERE "incident"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "incident_uptime_check_opened_at_idx" ON "incident" USING btree ("uptime_check_id","opened_at");--> statement-breakpoint
CREATE INDEX "probe_uptime_check_probed_at_idx" ON "probe" USING btree ("uptime_check_id","probed_at");--> statement-breakpoint
CREATE INDEX "probe_probed_at_idx" ON "probe" USING btree ("probed_at");