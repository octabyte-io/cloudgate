CREATE TYPE "public"."notification_type" AS ENUM('slack', 'telegram', 'discord', 'email', 'resend', 'gotify', 'ntfy', 'mattermost', 'pushover', 'custom', 'lark', 'teams');--> statement-breakpoint
CREATE TABLE "custom" (
	"custom_id" text PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"headers" jsonb
);
--> statement-breakpoint
CREATE TABLE "discord" (
	"discord_id" text PRIMARY KEY NOT NULL,
	"webhook_url" text NOT NULL,
	"decoration" boolean
);
--> statement-breakpoint
CREATE TABLE "email" (
	"email_id" text PRIMARY KEY NOT NULL,
	"smtp_server" text NOT NULL,
	"smtp_port" integer NOT NULL,
	"username" text NOT NULL,
	"password" text NOT NULL,
	"from_address" text NOT NULL,
	"to_addresses" text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gotify" (
	"gotify_id" text PRIMARY KEY NOT NULL,
	"server_url" text NOT NULL,
	"app_token" text NOT NULL,
	"priority" integer DEFAULT 5 NOT NULL,
	"decoration" boolean
);
--> statement-breakpoint
CREATE TABLE "lark" (
	"lark_id" text PRIMARY KEY NOT NULL,
	"webhook_url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mattermost" (
	"mattermost_id" text PRIMARY KEY NOT NULL,
	"webhook_url" text NOT NULL,
	"channel" text,
	"username" text
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"notification_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"app_deploy" boolean DEFAULT false NOT NULL,
	"app_build_error" boolean DEFAULT false NOT NULL,
	"database_backup" boolean DEFAULT false NOT NULL,
	"volume_backup" boolean DEFAULT false NOT NULL,
	"instance_restart" boolean DEFAULT false NOT NULL,
	"instance_backup" boolean DEFAULT false NOT NULL,
	"docker_cleanup" boolean DEFAULT false NOT NULL,
	"server_threshold" boolean DEFAULT false NOT NULL,
	"notification_type" "notification_type" NOT NULL,
	"created_at" text NOT NULL,
	"slack_id" text,
	"telegram_id" text,
	"discord_id" text,
	"email_id" text,
	"resend_id" text,
	"gotify_id" text,
	"ntfy_id" text,
	"mattermost_id" text,
	"custom_id" text,
	"lark_id" text,
	"pushover_id" text,
	"teams_id" text,
	"organization_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ntfy" (
	"ntfy_id" text PRIMARY KEY NOT NULL,
	"server_url" text NOT NULL,
	"topic" text NOT NULL,
	"access_token" text,
	"priority" integer DEFAULT 3 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pushover" (
	"pushover_id" text PRIMARY KEY NOT NULL,
	"user_key" text NOT NULL,
	"api_token" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"retry" integer,
	"expire" integer
);
--> statement-breakpoint
CREATE TABLE "resend" (
	"resend_id" text PRIMARY KEY NOT NULL,
	"api_key" text NOT NULL,
	"from_address" text NOT NULL,
	"to_addresses" text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack" (
	"slack_id" text PRIMARY KEY NOT NULL,
	"webhook_url" text NOT NULL,
	"channel" text
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"teams_id" text PRIMARY KEY NOT NULL,
	"webhook_url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram" (
	"telegram_id" text PRIMARY KEY NOT NULL,
	"bot_token" text NOT NULL,
	"chat_id" text NOT NULL,
	"message_thread_id" text
);
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_slack_id_slack_slack_id_fk" FOREIGN KEY ("slack_id") REFERENCES "public"."slack"("slack_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_telegram_id_telegram_telegram_id_fk" FOREIGN KEY ("telegram_id") REFERENCES "public"."telegram"("telegram_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_discord_id_discord_discord_id_fk" FOREIGN KEY ("discord_id") REFERENCES "public"."discord"("discord_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_email_id_email_email_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."email"("email_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_resend_id_resend_resend_id_fk" FOREIGN KEY ("resend_id") REFERENCES "public"."resend"("resend_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_gotify_id_gotify_gotify_id_fk" FOREIGN KEY ("gotify_id") REFERENCES "public"."gotify"("gotify_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_ntfy_id_ntfy_ntfy_id_fk" FOREIGN KEY ("ntfy_id") REFERENCES "public"."ntfy"("ntfy_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_mattermost_id_mattermost_mattermost_id_fk" FOREIGN KEY ("mattermost_id") REFERENCES "public"."mattermost"("mattermost_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_custom_id_custom_custom_id_fk" FOREIGN KEY ("custom_id") REFERENCES "public"."custom"("custom_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_lark_id_lark_lark_id_fk" FOREIGN KEY ("lark_id") REFERENCES "public"."lark"("lark_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_pushover_id_pushover_pushover_id_fk" FOREIGN KEY ("pushover_id") REFERENCES "public"."pushover"("pushover_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_teams_id_teams_teams_id_fk" FOREIGN KEY ("teams_id") REFERENCES "public"."teams"("teams_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;