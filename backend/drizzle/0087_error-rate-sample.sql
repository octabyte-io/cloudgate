CREATE TABLE "error_rate_sample" (
	"error_rate_sample_id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"collected_at" text NOT NULL,
	"requests" integer NOT NULL,
	"errors" integer NOT NULL,
	"slow" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "error_rate_sample" ADD CONSTRAINT "error_rate_sample_domain_id_domain_domain_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domain"("domain_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "error_rate_sample_domain_collected_at_idx" ON "error_rate_sample" USING btree ("domain_id","collected_at");--> statement-breakpoint
CREATE INDEX "error_rate_sample_collected_at_idx" ON "error_rate_sample" USING btree ("collected_at");