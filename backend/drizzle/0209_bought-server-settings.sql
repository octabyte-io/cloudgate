CREATE TABLE "bought_server_settings" (
	"id" text PRIMARY KEY DEFAULT 'instance' NOT NULL,
	"markup_percent" integer DEFAULT 20 NOT NULL,
	"margin_floor_percent" integer DEFAULT 10 NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "bought_server_settings_single_row" CHECK ("bought_server_settings"."id" = 'instance'),
	CONSTRAINT "bought_server_settings_markup" CHECK ("bought_server_settings"."markup_percent" >= 0),
	CONSTRAINT "bought_server_settings_margin_floor" CHECK ("bought_server_settings"."margin_floor_percent" between 0 and 100)
);
