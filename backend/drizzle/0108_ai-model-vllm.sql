ALTER TYPE "public"."inference_runtime" ADD VALUE 'vllm';--> statement-breakpoint
ALTER TABLE "ai_model" ADD COLUMN "hf_token" text;