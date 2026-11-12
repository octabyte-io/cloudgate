CREATE TABLE "dns_challenge" (
	"dns_challenge_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"credentials" text NOT NULL,
	"server_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "dns_challenge_server_id_unique" UNIQUE("server_id")
);
--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "preview_dns_challenge" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "dns_challenge" ADD CONSTRAINT "dns_challenge_server_id_server_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("server_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dns_challenge_local_unique" ON "dns_challenge" USING btree ("server_id") WHERE "dns_challenge"."server_id" is null;