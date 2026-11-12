CREATE TABLE "redirect" (
	"redirect_id" text PRIMARY KEY NOT NULL,
	"regex" text NOT NULL,
	"replacement" text NOT NULL,
	"permanent" boolean DEFAULT false NOT NULL,
	"unique_config_key" serial NOT NULL,
	"created_at" text NOT NULL,
	"application_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "redirect" ADD CONSTRAINT "redirect_application_id_application_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("application_id") ON DELETE cascade ON UPDATE no action;