ALTER TABLE "agent_jobs" ADD COLUMN "last_error_code" text;--> statement-breakpoint
UPDATE "agent_jobs"
SET "last_error_code" = 'JOB_EXECUTION_FAILED'
WHERE "last_error" IS NOT NULL
  AND "last_error_code" IS NULL;--> statement-breakpoint
WITH "abandoned_runs" AS (
  UPDATE "agent_runs" AS "runs"
  SET "status" = 'failed', "completed_at" = NOW()
  FROM "agent_jobs" AS "jobs"
  WHERE "runs"."job_id" = "jobs"."id"
    AND "runs"."status" = 'running'
    AND "jobs"."status" <> 'processing'
  RETURNING "runs"."id", "runs"."job_id"
)
INSERT INTO "agent_errors" ("run_id", "job_id", "code", "message", "occurred_at")
SELECT
  "id",
  "job_id",
  'RUN_PERSISTENCE_FAILED',
  'Run was left running when the Job execution ended',
  NOW()
FROM "abandoned_runs";
