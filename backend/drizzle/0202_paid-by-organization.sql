ALTER TABLE "subscription" ADD COLUMN "first_attached_at" timestamp (3);--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "paid_by_organization_id" text;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_paid_by_organization_id_organization_id_fk" FOREIGN KEY ("paid_by_organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_owner_id_idx" ON "organization" USING btree ("owner_id");