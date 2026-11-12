ALTER TABLE "mysql" ALTER COLUMN "docker_image" SET DEFAULT 'mysql:8.4';--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "config_plan_id" text;--> statement-breakpoint
ALTER TABLE "mysql" ADD CONSTRAINT "mysql_config_plan_id_plan_plan_id_fk" FOREIGN KEY ("config_plan_id") REFERENCES "public"."plan"("plan_id") ON DELETE set null ON UPDATE no action;