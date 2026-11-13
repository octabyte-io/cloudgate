ALTER TABLE "application" ADD COLUMN "drop_uploaded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Until a plan could write a folder source's build path (ADR-0080), only an
-- upload wrote `drop_build_path`, so every row holding one has had an upload.
UPDATE "application" SET "drop_uploaded" = true WHERE "drop_build_path" IS NOT NULL;
