CREATE TYPE "public"."billing_plan" AS ENUM('legacy', 'hobby', 'startup');--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"plan" "billing_plan",
	"status" text,
	"servers_quantity" integer DEFAULT 0 NOT NULL,
	"send_invoice_notifications" boolean DEFAULT false NOT NULL,
	"is_enterprise_cloud" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3),
	CONSTRAINT "subscription_organizationId_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;