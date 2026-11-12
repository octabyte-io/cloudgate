-- A Deployment names the Preview deployment it built. The link qualifies
-- an application-parented row and is not a parent (ADR-0017 is unamended), so
-- it nulls when the preview goes and the row stays in its parent's history.
-- The composite key is what holds "only beside that preview's own parent":
-- the UNIQUE it references is created first, because a foreign key needs its
-- target key to exist, and the one-column SET NULL key is created before it,
-- so on a preview's delete its action runs before the composite key's check
-- and leaves that pair half null, which MATCH SIMPLE does not check.
ALTER TABLE "deployment" ADD COLUMN "preview_deployment_id" text;--> statement-breakpoint
ALTER TABLE "preview_deployment" ADD CONSTRAINT "preview_deployment_id_application_id_unique" UNIQUE("preview_deployment_id","application_id");--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_preview_deployment_id_preview_deployment_preview_deployment_id_fk" FOREIGN KEY ("preview_deployment_id") REFERENCES "public"."preview_deployment"("preview_deployment_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_preview_belongs_to_its_application" FOREIGN KEY ("preview_deployment_id","application_id") REFERENCES "public"."preview_deployment"("preview_deployment_id","application_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_preview_qualifies_an_application" CHECK ("preview_deployment_id" IS NULL OR "application_id" IS NOT NULL);
