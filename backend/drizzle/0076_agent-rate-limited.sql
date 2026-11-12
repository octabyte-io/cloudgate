-- The loop signal: a notification flag that opts a channel into "Agent
-- rate limited", off like every other flag so no existing channel starts
-- hearing about Agents, and an index over an Agent's refusals by time, which
-- the row's "Rate-limited N times in the last hour" count and the restart
-- check both read. Partial on outcome = 'refused': those rows are the MCP
-- dispatcher's alone and a sliver of the trail, so the index stays small.
ALTER TABLE "notification" ADD COLUMN "agent_rate_limited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_log_refused_user_created_at_idx" ON "audit_log" USING btree ("user_id","created_at") WHERE "outcome" = 'refused';
