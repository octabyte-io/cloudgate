ALTER TABLE "mariadb" ALTER COLUMN "docker_image" SET DEFAULT 'mariadb:11';--> statement-breakpoint
-- `mariadb:6` was never a published tag, so every row still carrying it was
-- created from the old default and could never pull, let alone deploy.
UPDATE "mariadb" SET "docker_image" = 'mariadb:11' WHERE "docker_image" = 'mariadb:6';
