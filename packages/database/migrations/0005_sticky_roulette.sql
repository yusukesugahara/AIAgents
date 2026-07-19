CREATE TABLE "oauth_authorization_states" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"state_hash" text NOT NULL,
	"encrypted_code_verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_authorization_states_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
CREATE INDEX "oauth_authorization_states_expires_at_idx" ON "oauth_authorization_states" USING btree ("expires_at");--> statement-breakpoint
WITH ranked_connections AS (
		SELECT id, ROW_NUMBER() OVER (
			PARTITION BY user_id, type, google_email
			ORDER BY
				(status = 'connected' AND encrypted_refresh_token IS NOT NULL) DESC,
				(encrypted_refresh_token IS NOT NULL) DESC,
				(status = 'connected') DESC,
				updated_at DESC,
				id DESC
		) AS row_number
	FROM "connections"
)
DELETE FROM "connections"
USING ranked_connections
WHERE "connections".id = ranked_connections.id
	AND ranked_connections.row_number > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "connections_user_id_type_google_email_unique" ON "connections" USING btree ("user_id","type","google_email");
