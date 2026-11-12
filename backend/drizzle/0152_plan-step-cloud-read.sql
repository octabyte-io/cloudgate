-- A cloud plan step's `aws` read is `cloudRead`, and a cloud web
-- create's `cloud.size.fargate` is the neutral `cloud.size.pair`. A stored
-- plan written before is rewritten so it reads, and an open one applies, as
-- one written after. Every plan, not only open ones, so a settled plan shows
-- its cloud lines too; a step without either field is left as it is.
UPDATE "plan" SET "steps" = (
  SELECT jsonb_agg(renamed.step ORDER BY renamed.at)
  FROM (
    SELECT s.at,
      CASE WHEN sized.step ? 'aws'
        THEN (sized.step - 'aws') || jsonb_build_object('cloudRead', sized.step -> 'aws')
        ELSE sized.step
      END AS step
    FROM jsonb_array_elements("plan"."steps") WITH ORDINALITY AS s(step, at)
    CROSS JOIN LATERAL (
      SELECT CASE WHEN (s.step #> '{cloud,size}') ? 'fargate'
        THEN jsonb_set(
          s.step,
          '{cloud,size}',
          ((s.step #> '{cloud,size}') - 'fargate')
            || jsonb_build_object('pair', jsonb_build_object('runsOn', 'Fargate', 'wording', s.step #> '{cloud,size,fargate}'))
        )
        ELSE s.step
      END AS step
    ) AS sized
  ) AS renamed
)
WHERE jsonb_path_exists("steps", '$[*] ? (exists(@.aws) || exists(@.cloud.size.fargate))');
