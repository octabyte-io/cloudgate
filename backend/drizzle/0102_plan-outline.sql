-- What the config a plan was made from listed (Config names, kinds, managed:
-- console), read as the next plan's previous so that only a Service the config
-- in effect described is ever destroyed (US34). No text and no values: a
-- repository-kept copy is still never stored (ADR-0029).
ALTER TABLE "plan" ADD COLUMN "outline" jsonb;
