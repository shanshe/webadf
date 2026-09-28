ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "nfc_write_kind" text DEFAULT 'disk' NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "preload_sha256" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "preload_state" text;
