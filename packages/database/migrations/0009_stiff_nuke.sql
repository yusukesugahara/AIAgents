CREATE TABLE "job_email_drafts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"google_connection_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"idempotency_key" text NOT NULL,
	"gmail_draft_id" text,
	"gmail_draft_message_id" text,
	"reply_body_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "job_email_drafts_status_check" CHECK ("job_email_drafts"."status" IN ('creating', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "oauth_authorization_states" ADD COLUMN "authorization_purpose" text DEFAULT 'gmail_read' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_email_drafts" ADD CONSTRAINT "job_email_drafts_google_connection_id_connections_id_fk" FOREIGN KEY ("google_connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_email_drafts" ADD CONSTRAINT "job_email_drafts_job_id_agent_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_email_drafts" ADD CONSTRAINT "job_email_drafts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_email_drafts_connection_message_unique" ON "job_email_drafts" USING btree ("google_connection_id","gmail_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_email_drafts_idempotency_key_unique" ON "job_email_drafts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "job_email_drafts_gmail_draft_id_unique" ON "job_email_drafts" USING btree ("gmail_draft_id");--> statement-breakpoint
DELETE FROM "agent_settings"
WHERE "id" IN (
	SELECT "id"
	FROM (
		SELECT
			"id",
			ROW_NUMBER() OVER (
				PARTITION BY "user_id", "agent_id"
				ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
			) AS "row_number"
		FROM "agent_settings"
	) AS "duplicate_settings"
	WHERE "row_number" > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "agent_settings_user_id_agent_id_unique" ON "agent_settings" USING btree ("user_id","agent_id");
