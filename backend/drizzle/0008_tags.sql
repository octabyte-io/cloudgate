CREATE TABLE "project_tag" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"tag_id" text NOT NULL,
	CONSTRAINT "unique_project_tag" UNIQUE("project_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"tag_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" text NOT NULL,
	"organization_id" text NOT NULL,
	CONSTRAINT "unique_org_tag_name" UNIQUE("organization_id","name")
);
--> statement-breakpoint
ALTER TABLE "project_tag" ADD CONSTRAINT "project_tag_project_id_project_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tag" ADD CONSTRAINT "project_tag_tag_id_tag_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("tag_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;