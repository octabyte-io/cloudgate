-- A custom webhook authenticates with a header, so `headers` is a credential
-- and moves to the `enc:v1:` text format the other channels use.
-- jsonb -> text is an assignment cast, so existing rows keep their JSON as
-- plaintext: ADR 0006 passes an unprefixed value through on read and
-- re-encrypts it on the next write, so there is nothing to backfill here.
ALTER TABLE "custom" ALTER COLUMN "headers" SET DATA TYPE text;
