CREATE TABLE "ai_usage_daily" (
	"ai_usage_daily_id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"apikey_id" text NOT NULL,
	"agent_user_id" text,
	"agent_name" text NOT NULL,
	"model" text NOT NULL,
	"day" text NOT NULL,
	"prompt_tokens_reported" bigint NOT NULL,
	"prompt_tokens_estimated" bigint NOT NULL,
	"completion_tokens_reported" bigint NOT NULL,
	"completion_tokens_estimated" bigint NOT NULL,
	"calls_ok" integer NOT NULL,
	"calls_runtime_error" integer NOT NULL,
	"calls_client_aborted" integer NOT NULL,
	"calls_refused" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage_daily" ADD CONSTRAINT "ai_usage_daily_application_id_application_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_daily" ADD CONSTRAINT "ai_usage_daily_agent_user_id_user_id_fk" FOREIGN KEY ("agent_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_daily_application_day_key_model_idx" ON "ai_usage_daily" USING btree ("application_id","day","apikey_id","model");