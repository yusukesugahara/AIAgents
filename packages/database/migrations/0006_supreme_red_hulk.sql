DELETE FROM "oauth_authorization_states";--> statement-breakpoint
ALTER TABLE "oauth_authorization_states" ADD COLUMN "browser_nonce_hash" text NOT NULL;
