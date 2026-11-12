CREATE TABLE "rollback" (
	"rollback_id" text PRIMARY KEY NOT NULL,
	"deployment_id" text NOT NULL,
	"version" serial NOT NULL,
	"image" text,
	"full_context" json,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "rollback_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rollback" ADD CONSTRAINT "rollback_deployment_id_deployment_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployment"("deployment_id") ON DELETE cascade ON UPDATE no action;