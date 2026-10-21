CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"cycle_id" uuid,
	"kind" text DEFAULT 'initial' NOT NULL,
	"executor_id" uuid NOT NULL,
	"prepared_by" uuid,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone,
	"deadline" date,
	"extended_until" date,
	"extension_basis" text,
	"task" text NOT NULL,
	"lang" text NOT NULL,
	"state" text DEFAULT 'assigned_by_chair' NOT NULL,
	"letter_subject" text,
	"letter_text" text,
	"letter_html" text,
	"letter_hash" text,
	"workspace_link" text,
	"material_version_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval" jsonb,
	"access_result" jsonb,
	"outgoing_id" uuid,
	"sent_at" timestamp with time zone,
	"sent_provider_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"part_id" text NOT NULL,
	"provider_attachment_id" text,
	"filename" text NOT NULL,
	"display_name" text,
	"mime_type" text NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"sha256" text,
	"inline" boolean DEFAULT false NOT NULL,
	"parent_part_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"exclusion" jsonb,
	"blob_id" uuid,
	"document_version_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_type" text NOT NULL,
	"actor_label" text,
	"role" text,
	"action" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text,
	"object_version" integer,
	"case_id" uuid,
	"result" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"basis" text,
	"correlation_id" text,
	"external_ids" jsonb,
	"prev_hash" text,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"mime_type" text,
	"storage_key" text NOT NULL,
	"verified_at" timestamp with time zone,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"cycle_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"number" integer NOT NULL,
	"rka_number" text,
	"rka_date" date,
	"received_at" timestamp with time zone,
	"collegium" text,
	"collegium_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"collegium_source" text,
	"collegium_manual" boolean DEFAULT false NOT NULL,
	"applicant" text NOT NULL,
	"applicant_aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"summary" text,
	"summary_source" text,
	"summary_machine" boolean DEFAULT false NOT NULL,
	"summary_manual" boolean DEFAULT false NOT NULL,
	"lang" text,
	"lang_confirmed" boolean DEFAULT false NOT NULL,
	"conclusion_lang" text,
	"state" text DEFAULT 'registered' NOT NULL,
	"current_cycle_id" uuid,
	"executor_id" uuid,
	"chair_id" uuid,
	"secretary_id" uuid,
	"result_code" text,
	"result_at" timestamp with time zone,
	"measures" text,
	"closed_basis" text,
	"initial_message_id" uuid,
	"drive_folder_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "command_log" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"command" text NOT NULL,
	"actor_id" uuid,
	"result" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"parent_cycle_id" uuid,
	"supplementary" boolean DEFAULT false NOT NULL,
	"basis" text,
	"state" text DEFAULT 'preparation' NOT NULL,
	"draft_version_id" uuid,
	"frozen_manifest" jsonb,
	"eligible_snapshot" jsonb,
	"recused" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quorum_rule" jsonb,
	"decision_rule" jsonb,
	"preapproved_by" uuid,
	"preapproved_at" timestamp with time zone,
	"discussion_notified_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"closes_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"early_close_basis" text,
	"tally" jsonb,
	"protocol_version_id" uuid,
	"protocol_hash" text,
	"final_route" text,
	"final_version_id" uuid,
	"final_received_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"conclusion_number" text,
	"conclusion_date" date,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_links" (
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"linked_by" uuid,
	"basis" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_links_document_id_case_id_pk" PRIMARY KEY("document_id","case_id")
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"state" text DEFAULT 'working' NOT NULL,
	"blob_id" uuid,
	"sha256" text,
	"size" bigint,
	"format" text,
	"filename" text,
	"author_id" uuid,
	"source_message_id" uuid,
	"source_attachment_id" uuid,
	"created_from" uuid,
	"replaces" uuid,
	"signs_version_id" uuid,
	"generator" jsonb,
	"approval" jsonb,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"quarantine" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_basis" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"cycle_id" uuid,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"lang" text,
	"confidential" boolean DEFAULT true NOT NULL,
	"area" text DEFAULT 'root' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text DEFAULT 'gmail' NOT NULL,
	"email" text NOT NULL,
	"state" text DEFAULT 'disabled' NOT NULL,
	"refresh_token_enc" text,
	"scopes" text,
	"history_id" text,
	"watch_expiration" timestamp with time zone,
	"initial_sync_from" date,
	"initial_sync_cursor" text,
	"initial_sync_done" boolean DEFAULT false NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"internet_message_id" text,
	"thread_id" text,
	"direction" text NOT NULL,
	"sent_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_addr" text NOT NULL,
	"from_name" text,
	"to_addrs" text[] DEFAULT '{}'::text[] NOT NULL,
	"cc_addrs" text[] DEFAULT '{}'::text[] NOT NULL,
	"reply_to" text,
	"subject" text DEFAULT '' NOT NULL,
	"body_text" text,
	"body_html" text,
	"raw_blob_id" uuid,
	"label_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_check" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"intake_state" text DEFAULT 'discovered' NOT NULL,
	"intake_kind" text,
	"match" jsonb,
	"case_id" uuid,
	"attached_by" uuid,
	"attach_basis" text,
	"lang" text,
	"added_late" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"name_kk" text,
	"short_name" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Almaty' NOT NULL,
	"official_sender" text NOT NULL,
	"rka_address" text NOT NULL,
	"rka_addressee" text DEFAULT 'Председателю Республиканской коллегии адвокатов' NOT NULL,
	"outgoing_prefix" text,
	"outgoing_year_in_number" boolean DEFAULT false NOT NULL,
	"quorum_rule" jsonb NOT NULL,
	"decision_rule" jsonb NOT NULL,
	"policies" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"aggregate_version" integer,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "outgoings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"cycle_id" uuid,
	"kind" text NOT NULL,
	"number_case" integer,
	"repeat_index" integer,
	"number_display" text,
	"outgoing_date" date,
	"lang" text,
	"from_addr" text NOT NULL,
	"to_addrs" text[] NOT NULL,
	"cc_addrs" text[] DEFAULT '{}'::text[] NOT NULL,
	"bcc_addrs" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"body_html" text,
	"manifest" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"package_hash" text,
	"approval" jsonb,
	"state" text DEFAULT 'project' NOT NULL,
	"provider_draft_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"provider_message_id" text,
	"provider_thread_id" text,
	"internet_message_id" text,
	"sent_at" timestamp with time zone,
	"reconcile" jsonb,
	"rejected_reason" text,
	"cancelled_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qr_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"token" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_hash" text NOT NULL,
	"pdf_sha256" text,
	"signature_status" jsonb,
	"status_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sign_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"document_sha256" text NOT NULL,
	"assigned_signer_id" uuid NOT NULL,
	"actual_signer" jsonb,
	"provider" text DEFAULT 'sigex' NOT NULL,
	"procedure_id" text,
	"urls" jsonb,
	"expire_at" timestamp with time zone,
	"state" text DEFAULT 'created' NOT NULL,
	"registration_id" text,
	"signature_blob_id" uuid,
	"signature_type" text,
	"received_at" timestamp with time zone,
	"verification" jsonb,
	"provider_responses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"case_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"assignee_role" text DEFAULT 'secretary' NOT NULL,
	"assignee_id" uuid,
	"object_type" text,
	"object_id" uuid,
	"state" text DEFAULT 'open' NOT NULL,
	"due_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"dedup_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"lang" text NOT NULL,
	"version" integer NOT NULL,
	"body" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"auth_user_id" uuid,
	"full_name" text NOT NULL,
	"full_name_kk" text,
	"first_name" text,
	"patronymic" text,
	"address_kk" text,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"collegium" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vote_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"token" text NOT NULL,
	"sent_at" timestamp with time zone,
	"delivery_state" text DEFAULT 'pending' NOT NULL,
	"opened_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"choice" text NOT NULL,
	"comment" text,
	"special_opinion" text,
	"draft_version_id" uuid NOT NULL,
	"cast_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_executor_id_users_id_fk" FOREIGN KEY ("executor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_members" ADD CONSTRAINT "case_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_members" ADD CONSTRAINT "case_members_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_members" ADD CONSTRAINT "case_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_log" ADD CONSTRAINT "command_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_roles" ADD CONSTRAINT "org_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_roles" ADD CONSTRAINT "org_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outgoings" ADD CONSTRAINT "outgoings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outgoings" ADD CONSTRAINT "outgoings_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_cards" ADD CONSTRAINT "qr_cards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_cards" ADD CONSTRAINT "qr_cards_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_cards" ADD CONSTRAINT "qr_cards_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_sessions" ADD CONSTRAINT "sign_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_sessions" ADD CONSTRAINT "sign_sessions_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_sessions" ADD CONSTRAINT "sign_sessions_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vote_invitations" ADD CONSTRAINT "vote_invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vote_invitations" ADD CONSTRAINT "vote_invitations_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vote_invitations" ADD CONSTRAINT "vote_invitations_member_id_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_member_id_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignments_case" ON "assignments" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_message_part" ON "attachments" USING btree ("message_id","part_id");--> statement-breakpoint
CREATE INDEX "audit_case" ON "audit_events" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "audit_at" ON "audit_events" USING btree ("organization_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "blobs_org_sha" ON "blobs" USING btree ("organization_id","sha256");--> statement-breakpoint
CREATE INDEX "case_members_case" ON "case_members" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "case_members_user" ON "case_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cases_org_year_number" ON "cases" USING btree ("organization_id","year","number");--> statement-breakpoint
CREATE INDEX "cases_rka" ON "cases" USING btree ("organization_id","rka_number");--> statement-breakpoint
CREATE UNIQUE INDEX "cycles_case_number" ON "cycles" USING btree ("case_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_versions_doc_ver" ON "document_versions" USING btree ("document_id","version");--> statement-breakpoint
CREATE INDEX "documents_case" ON "documents" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_accounts_org_email" ON "mail_accounts" USING btree ("organization_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_account_provider" ON "messages" USING btree ("account_id","provider_message_id");--> statement-breakpoint
CREATE INDEX "messages_case" ON "messages" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "messages_thread" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "messages_intake" ON "messages" USING btree ("organization_id","intake_state");--> statement-breakpoint
CREATE UNIQUE INDEX "org_roles_user_role" ON "org_roles" USING btree ("user_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_idem" ON "outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "outbox_due" ON "outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outgoings_idem" ON "outgoings" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "outgoings_number" ON "outgoings" USING btree ("organization_id","number_case","repeat_index") WHERE kind = 'rka_package' and number_case is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "qr_cards_token" ON "qr_cards" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "qr_cards_version" ON "qr_cards" USING btree ("document_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sign_sessions_idem" ON "sign_sessions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_dedup" ON "tasks" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "tasks_open" ON "tasks" USING btree ("organization_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_kind_lang_ver" ON "templates" USING btree ("organization_id","kind","lang","version");--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_email" ON "users" USING btree ("organization_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "vote_inv_token" ON "vote_invitations" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "vote_inv_cycle_member" ON "vote_invitations" USING btree ("cycle_id","member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "votes_cycle_member" ON "votes" USING btree ("cycle_id","member_id");