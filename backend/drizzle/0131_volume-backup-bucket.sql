ALTER TABLE "volume_backup" DROP CONSTRAINT "volume_backup_parent_matches_service_type";--> statement-breakpoint
ALTER TABLE "volume_backup" ADD COLUMN "bucket_id" text;--> statement-breakpoint
ALTER TABLE "volume_backup" ADD CONSTRAINT "volume_backup_bucket_id_bucket_bucket_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."bucket"("bucket_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_backup" ADD CONSTRAINT "volume_backup_parent_matches_service_type" CHECK (num_nonnulls("application_id", "compose_id", "libsql_id", "mariadb_id", "mongo_id", "mysql_id", "postgres_id", "redis_id", "bucket_id") = 1
    AND (CASE "service_type"::text
           WHEN 'application' THEN "application_id"
           WHEN 'compose'     THEN "compose_id"
           WHEN 'libsql'      THEN "libsql_id"
           WHEN 'mariadb'     THEN "mariadb_id"
           WHEN 'mongo'       THEN "mongo_id"
           WHEN 'mysql'       THEN "mysql_id"
           WHEN 'postgres'    THEN "postgres_id"
           WHEN 'redis'       THEN "redis_id"
           WHEN 'bucket'      THEN "bucket_id"
         END) IS NOT NULL);