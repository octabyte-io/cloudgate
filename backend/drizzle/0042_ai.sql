CREATE TABLE "ai" (
	"ai_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"api_url" text NOT NULL,
	"api_key" text NOT NULL,
	"model" text NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai" ADD CONSTRAINT "ai_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;