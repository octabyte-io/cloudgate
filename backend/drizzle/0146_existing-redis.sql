ALTER TABLE "existing_database" ALTER COLUMN "postgres_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "existing_database" ADD COLUMN "redis_id" text;--> statement-breakpoint
ALTER TABLE "existing_database" ADD COLUMN "tls" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "existing_database" ADD CONSTRAINT "existing_database_redis_id_redis_redis_id_fk" FOREIGN KEY ("redis_id") REFERENCES "public"."redis"("redis_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "existing_database" ADD CONSTRAINT "existing_database_redis_id_unique" UNIQUE("redis_id");--> statement-breakpoint
ALTER TABLE "existing_database" ADD CONSTRAINT "existing_database_one_service" CHECK (("existing_database"."postgres_id" IS NULL) <> ("existing_database"."redis_id" IS NULL));