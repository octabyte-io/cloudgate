CREATE TYPE "public"."ai_usage_outcome" AS ENUM('ok', 'runtime-error', 'client-aborted', 'refused');--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"ai_usage_id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"agent_user_id" text,
	"agent_name" text NOT NULL,
	"apikey_id" text NOT NULL,
	"model" text NOT NULL,
	"endpoint" text NOT NULL,
	"streamed" boolean NOT NULL,
	"prompt_tokens" integer NOT NULL,
	"prompt_tokens_estimated" boolean NOT NULL,
	"completion_tokens" integer NOT NULL,
	"completion_tokens_estimated" boolean NOT NULL,
	"started_at" text NOT NULL,
	"ended_at" text NOT NULL,
	"outcome" "ai_usage_outcome" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_application_id_application_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_agent_user_id_user_id_fk" FOREIGN KEY ("agent_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_application_started_idx" ON "ai_usage" USING btree ("application_id","started_at");