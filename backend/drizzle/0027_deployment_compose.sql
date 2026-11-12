ALTER TABLE "deployment" ALTER COLUMN "application_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "compose_id" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_compose_id_compose_compose_id_fk" FOREIGN KEY ("compose_id") REFERENCES "public"."compose"("compose_id") ON DELETE cascade ON UPDATE no action;