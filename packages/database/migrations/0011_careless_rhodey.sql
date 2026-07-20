ALTER TABLE "agent_run_steps" ADD COLUMN "sequence" integer;--> statement-breakpoint
WITH "ordered_steps" AS (
	SELECT "id", row_number() OVER (
		PARTITION BY "run_id" ORDER BY "started_at", "id"
	)::integer * 10 AS "sequence"
	FROM "agent_run_steps"
)
UPDATE "agent_run_steps"
SET "sequence" = "ordered_steps"."sequence"
FROM "ordered_steps"
WHERE "agent_run_steps"."id" = "ordered_steps"."id";--> statement-breakpoint
ALTER TABLE "agent_run_steps" ALTER COLUMN "sequence" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_steps_run_id_sequence_unique" ON "agent_run_steps" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_steps_run_id_step_name_unique" ON "agent_run_steps" USING btree ("run_id","step_name");
