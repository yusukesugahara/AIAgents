CREATE TABLE "job_email_analyses" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"run_id" uuid NOT NULL,
	"google_connection_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"is_job_related" boolean NOT NULL,
	"category" text NOT NULL,
	"needs_reply" boolean NOT NULL,
	"reply_intent" text NOT NULL,
	"company_name" text,
	"contact_name" text,
	"meeting_is_confirmed" boolean NOT NULL,
	"meeting_start_at" timestamp with time zone,
	"meeting_end_at" timestamp with time zone,
	"meeting_timezone" text,
	"meeting_url" text,
	"meeting_url_type" text NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"analysis_json" jsonb NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"schema_name" text NOT NULL,
	"schema_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_email_analyses_category_check" CHECK ("job_email_analyses"."category" IN ('meeting_confirmed', 'scheduling_request', 'application_update', 'document_request', 'assignment', 'offer', 'rejection', 'general', 'not_job_related')),
	CONSTRAINT "job_email_analyses_reply_intent_check" CHECK ("job_email_analyses"."reply_intent" IN ('accept', 'decline', 'acknowledge', 'submit_information', 'request_clarification', 'none')),
	CONSTRAINT "job_email_analyses_url_type_check" CHECK ("job_email_analyses"."meeting_url_type" IN ('web_meeting', 'scheduling_page', 'other', 'none')),
	CONSTRAINT "job_email_analyses_confidence_check" CHECK ("job_email_analyses"."confidence" >= 0 AND "job_email_analyses"."confidence" <= 1),
	CONSTRAINT "job_email_analyses_job_category_check" CHECK ("job_email_analyses"."is_job_related" = ("job_email_analyses"."category" <> 'not_job_related')),
	CONSTRAINT "job_email_analyses_reply_required_check" CHECK ("job_email_analyses"."needs_reply" = ("job_email_analyses"."reply_intent" <> 'none')),
	CONSTRAINT "job_email_analyses_confirmed_category_check" CHECK ("job_email_analyses"."meeting_is_confirmed" = ("job_email_analyses"."category" = 'meeting_confirmed')),
	CONSTRAINT "job_email_analyses_meeting_range_check" CHECK ("job_email_analyses"."meeting_end_at" IS NULL OR ("job_email_analyses"."meeting_start_at" IS NOT NULL AND "job_email_analyses"."meeting_end_at" > "job_email_analyses"."meeting_start_at")),
	CONSTRAINT "job_email_analyses_meeting_timezone_check" CHECK (("job_email_analyses"."meeting_start_at" IS NULL) = ("job_email_analyses"."meeting_timezone" IS NULL)),
	CONSTRAINT "job_email_analyses_meeting_url_check" CHECK (("job_email_analyses"."meeting_url" IS NULL) = ("job_email_analyses"."meeting_url_type" = 'none'))
);
--> statement-breakpoint
ALTER TABLE "review_requests" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "job_email_analyses" ADD CONSTRAINT "job_email_analyses_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_email_analyses" ADD CONSTRAINT "job_email_analyses_google_connection_id_connections_id_fk" FOREIGN KEY ("google_connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_email_analyses_run_id_unique" ON "job_email_analyses" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "job_email_analyses_connection_message_created_idx" ON "job_email_analyses" USING btree ("google_connection_id","gmail_message_id","created_at");--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_requests_run_id_unique" ON "review_requests" USING btree ("run_id");