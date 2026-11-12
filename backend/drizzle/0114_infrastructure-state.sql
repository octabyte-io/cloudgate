CREATE SCHEMA "infrastructure_state";
--> statement-breakpoint
CREATE SEQUENCE "infrastructure_state"."global_states_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "infrastructure_state_record" (
	"infrastructure_state_id" text PRIMARY KEY NOT NULL,
	"application_id" text,
	"environment_network_id" text,
	"tofu_version" text,
	"provider_version" text,
	"readable" boolean DEFAULT true NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "infrastructure_state_record_one_owner" CHECK (num_nonnulls("infrastructure_state_record"."application_id", "infrastructure_state_record"."environment_network_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "infrastructure_state"."states" (
	"id" bigint PRIMARY KEY DEFAULT nextval('infrastructure_state.global_states_id_seq') NOT NULL,
	"name" text,
	"data" text,
	CONSTRAINT "states_name_key" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "infrastructure_state_record" ADD CONSTRAINT "infrastructure_state_record_application_id_application_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "infrastructure_state_record_application_unique" ON "infrastructure_state_record" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "infrastructure_state_record_environment_network_unique" ON "infrastructure_state_record" USING btree ("environment_network_id");--> statement-breakpoint
CREATE UNIQUE INDEX "states_by_name" ON "infrastructure_state"."states" USING btree ("name");