CREATE TABLE "job_calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"google_connection_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"idempotency_key" text NOT NULL,
	"google_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "job_calendar_events_status_check" CHECK ("job_calendar_events"."status" IN ('creating', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "job_calendar_events" ADD CONSTRAINT "job_calendar_events_google_connection_id_connections_id_fk" FOREIGN KEY ("google_connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_calendar_events" ADD CONSTRAINT "job_calendar_events_job_id_agent_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_calendar_events" ADD CONSTRAINT "job_calendar_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_calendar_events_connection_message_unique" ON "job_calendar_events" USING btree ("google_connection_id","gmail_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_calendar_events_idempotency_key_unique" ON "job_calendar_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "job_calendar_events_google_event_id_unique" ON "job_calendar_events" USING btree ("google_event_id");