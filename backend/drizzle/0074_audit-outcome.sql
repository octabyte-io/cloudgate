-- An audit row records how the call ended, and the actor's name at the
-- time. Every row written before this was a success (only successful writes
-- were recorded), so the default is also the truth for each existing row.
-- `user_name` stays null on those rows: the name they were written under is
-- not known any more.
ALTER TABLE "audit_log" ADD COLUMN "user_name" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "outcome" text DEFAULT 'succeeded' NOT NULL;
