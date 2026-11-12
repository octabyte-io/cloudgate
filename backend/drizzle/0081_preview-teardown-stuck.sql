-- The notification flag that opts a channel into "Preview teardown
-- stuck": the Requested-preview expiry sweep has retried a Server's teardowns
-- for fifteen minutes. Off like every other flag, so no existing channel
-- starts hearing about it.
ALTER TABLE "notification" ADD COLUMN "preview_teardown_stuck" boolean DEFAULT false NOT NULL;
