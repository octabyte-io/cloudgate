CREATE TABLE "template_catalogue" (
	"source_url" text PRIMARY KEY NOT NULL,
	"release" text,
	"body" text NOT NULL,
	"fetched_at" text NOT NULL,
	"checked_at" text NOT NULL,
	"problem" text
);
