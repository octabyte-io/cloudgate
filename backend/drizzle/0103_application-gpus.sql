-- Whole GPUs reserved per running copy of an Application. 0 for every
-- existing row: nothing reserved a GPU before. Cloudgate's, never the Project
-- config's (ADR-0029).
ALTER TABLE "application" ADD COLUMN "gpus" integer DEFAULT 0 NOT NULL;
