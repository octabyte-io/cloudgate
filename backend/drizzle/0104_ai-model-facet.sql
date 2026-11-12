CREATE TYPE "public"."inference_runtime" AS ENUM('ollama');--> statement-breakpoint
CREATE TABLE "ai_model" (
	"ai_model_id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"runtime" "inference_runtime" NOT NULL,
	"model" text NOT NULL,
	"image_tag" text,
	"upstream_secret" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "ai_model_application_id_unique" UNIQUE("application_id")
);
--> statement-breakpoint
ALTER TABLE "ai_model" ADD CONSTRAINT "ai_model_application_id_application_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("application_id") ON DELETE cascade ON UPDATE no action;