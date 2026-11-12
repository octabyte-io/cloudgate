CREATE TABLE "container_metric" (
	"container_metric_id" text PRIMARY KEY NOT NULL,
	"timestamp" text NOT NULL,
	"container_id" text NOT NULL,
	"container_name" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"server_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_metric" (
	"server_metric_id" text PRIMARY KEY NOT NULL,
	"timestamp" text NOT NULL,
	"cpu" double precision NOT NULL,
	"cpu_model" text NOT NULL,
	"cpu_cores" integer NOT NULL,
	"cpu_physical_cores" integer NOT NULL,
	"cpu_speed" double precision NOT NULL,
	"os" text NOT NULL,
	"distro" text NOT NULL,
	"kernel" text NOT NULL,
	"arch" text NOT NULL,
	"mem_used" double precision NOT NULL,
	"mem_used_gb" double precision NOT NULL,
	"mem_total" double precision NOT NULL,
	"uptime" bigint NOT NULL,
	"disk_used" double precision NOT NULL,
	"total_disk" double precision NOT NULL,
	"network_in" double precision NOT NULL,
	"network_out" double precision NOT NULL,
	"created_at" text NOT NULL,
	"server_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "container_metric" ADD CONSTRAINT "container_metric_server_id_server_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("server_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_metric" ADD CONSTRAINT "server_metric_server_id_server_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("server_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "container_metric_server_timestamp_idx" ON "container_metric" USING btree ("server_id","timestamp");--> statement-breakpoint
CREATE INDEX "container_metric_server_name_idx" ON "container_metric" USING btree ("server_id","container_name");--> statement-breakpoint
CREATE INDEX "server_metric_server_timestamp_idx" ON "server_metric" USING btree ("server_id","timestamp");