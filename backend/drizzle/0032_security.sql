CREATE TABLE "security" (
	"security_id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password" text NOT NULL,
	"created_at" text NOT NULL,
	"application_id" text NOT NULL,
	CONSTRAINT "security_username_application_id_unique" UNIQUE("username","application_id")
);
--> statement-breakpoint
ALTER TABLE "security" ADD CONSTRAINT "security_application_id_application_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("application_id") ON DELETE cascade ON UPDATE no action;