CREATE TYPE "public"."bought_server_line_kind" AS ENUM('server', 'backups', 'storage');--> statement-breakpoint
CREATE TYPE "public"."bought_server_stage" AS ENUM('waiting_for_payment', 'creating', 'setting_up', 'ready', 'changing', 'deleting', 'deleted', 'failed');--> statement-breakpoint
CREATE TABLE "bought_server" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"server_id" text,
	"name" text NOT NULL,
	"stage" "bought_server_stage" DEFAULT 'waiting_for_payment' NOT NULL,
	"server_type" text NOT NULL,
	"location" text NOT NULL,
	"backups" boolean DEFAULT false NOT NULL,
	"storage_gb" integer,
	"ssh_key_id" text,
	"provider_server_id" bigint,
	"provider_volume_id" bigint,
	"provider_primary_ipv4_id" bigint,
	"provider_primary_ipv6_id" bigint,
	"create_tries" integer DEFAULT 0 NOT NULL,
	"purchase_invoice_id" text,
	"purchase_paid_at" timestamp (3),
	"change_target" jsonb,
	"change_tries" integer DEFAULT 0 NOT NULL,
	"change_invoice_id" text,
	"terms_accepted_by" text NOT NULL,
	"terms_accepted_at" timestamp (3) NOT NULL,
	"powered_off_at" timestamp (3),
	"powered_off_reason" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "bought_server_server_id_unique" UNIQUE("server_id")
);
--> statement-breakpoint
CREATE TABLE "bought_server_line" (
	"id" text PRIMARY KEY NOT NULL,
	"bought_server_id" text NOT NULL,
	"kind" "bought_server_line_kind" NOT NULL,
	"stripe_price_id" text NOT NULL,
	"stripe_subscription_item_id" text,
	"monthly_cents" integer NOT NULL,
	"sold_at" timestamp (3) DEFAULT now() NOT NULL,
	"next_monthly_cents" integer,
	"next_price_from" timestamp (3),
	CONSTRAINT "bought_server_line_bought_server_id_kind_unique" UNIQUE("bought_server_id","kind")
);
--> statement-breakpoint
ALTER TABLE "bought_server" ADD CONSTRAINT "bought_server_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bought_server" ADD CONSTRAINT "bought_server_server_id_server_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("server_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bought_server" ADD CONSTRAINT "bought_server_ssh_key_id_ssh_key_ssh_key_id_fk" FOREIGN KEY ("ssh_key_id") REFERENCES "public"."ssh_key"("ssh_key_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bought_server_line" ADD CONSTRAINT "bought_server_line_bought_server_id_bought_server_id_fk" FOREIGN KEY ("bought_server_id") REFERENCES "public"."bought_server"("id") ON DELETE cascade ON UPDATE no action;