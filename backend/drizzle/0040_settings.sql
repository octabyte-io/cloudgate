CREATE TABLE "web_server_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"server_ip" text,
	"certificate_type" "certificate_type" DEFAULT 'none' NOT NULL,
	"https" boolean DEFAULT false NOT NULL,
	"host" text,
	"lets_encrypt_email" text,
	"ssh_private_key" text,
	"enable_docker_cleanup" boolean DEFAULT true NOT NULL,
	"log_cleanup_cron" text DEFAULT '0 0 * * *',
	"metrics_config" jsonb DEFAULT '{"server":{"type":"Cloudgate","refreshRate":60,"port":4500,"token":"","retentionDays":2,"cronJob":"","urlCallback":"","thresholds":{"cpu":0,"memory":0}},"containers":{"refreshRate":60,"services":{"include":[],"exclude":[]}}}'::jsonb NOT NULL,
	"builds_concurrency" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
