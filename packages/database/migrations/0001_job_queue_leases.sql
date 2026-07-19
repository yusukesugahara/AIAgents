ALTER TABLE "agent_jobs" DROP CONSTRAINT "agent_jobs_idempotency_key_unique";--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "trigger_type" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_jobs_agent_id_idempotency_key_unique" ON "agent_jobs" USING btree ("agent_id","idempotency_key");
