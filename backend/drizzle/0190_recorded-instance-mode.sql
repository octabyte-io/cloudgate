-- The Instance's recorded mode (ADR-0049): one row, written by the first
-- start and compared against HOSTED_MODE by every later one; only the hand-run
-- set-instance-mode command changes it. Left empty here, so an upgraded
-- instance records the mode it next starts in.
CREATE TABLE "recorded_instance_mode" (
	"id" text PRIMARY KEY DEFAULT 'instance' NOT NULL,
	"mode" text NOT NULL,
	"recorded_at" timestamp (3) DEFAULT now() NOT NULL,
	"changed_at" timestamp (3),
	CONSTRAINT "recorded_instance_mode_single_row" CHECK ("recorded_instance_mode"."id" = 'instance'),
	CONSTRAINT "recorded_instance_mode_mode" CHECK ("recorded_instance_mode"."mode" in ('hosted', 'self-hosted'))
);
