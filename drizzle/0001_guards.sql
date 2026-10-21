-- Защиты целостности на уровне базы (BR-03, DOC-09, AUD-01, STORE-07, BR-06).

-- 1. Подписанная версия неизменяема: хеш, объект и размер нельзя изменить после state = 'signed'.
CREATE OR REPLACE FUNCTION kzppa_guard_signed_version() RETURNS trigger AS $$
BEGIN
  IF OLD.state IN ('signed', 'archived') THEN
    IF NEW.sha256 IS DISTINCT FROM OLD.sha256
       OR NEW.blob_id IS DISTINCT FROM OLD.blob_id
       OR NEW.size IS DISTINCT FROM OLD.size
       OR NEW.document_id IS DISTINCT FROM OLD.document_id
       OR NEW.version IS DISTINCT FROM OLD.version THEN
      RAISE EXCEPTION 'Подписанная версия % неизменяема: создайте новую версию', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state NOT IN ('signed', 'archived') THEN
      RAISE EXCEPTION 'Подписанную версию % нельзя вернуть в состояние %', OLD.id, NEW.state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER document_versions_signed_guard
  BEFORE UPDATE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION kzppa_guard_signed_version();
--> statement-breakpoint

-- 2. Версии документов и объекты содержимого не удаляются физически (только мягкое удаление).
CREATE OR REPLACE FUNCTION kzppa_forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Физическое удаление из % запрещено (STORE-07). Используйте обратимое удаление с основанием.', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER document_versions_no_delete BEFORE DELETE ON document_versions FOR EACH ROW EXECUTE FUNCTION kzppa_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER blobs_no_delete BEFORE DELETE ON blobs FOR EACH ROW EXECUTE FUNCTION kzppa_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER messages_no_delete BEFORE DELETE ON messages FOR EACH ROW EXECUTE FUNCTION kzppa_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER attachments_no_delete BEFORE DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION kzppa_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER votes_no_delete BEFORE DELETE ON votes FOR EACH ROW EXECUTE FUNCTION kzppa_forbid_delete();
--> statement-breakpoint

-- 3. Журнал аудита — только дозапись.
CREATE OR REPLACE FUNCTION kzppa_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Журнал аудита нельзя изменять или удалять (AUD-01)' USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION kzppa_audit_append_only();
--> statement-breakpoint

-- 4. Голос неизменяем после подачи (FLOW-06).
CREATE OR REPLACE FUNCTION kzppa_vote_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Поданный голос нельзя изменить' USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER votes_no_update BEFORE UPDATE ON votes FOR EACH ROW EXECUTE FUNCTION kzppa_vote_immutable();
--> statement-breakpoint

-- 5. Протокол закрытого цикла не переписывается (FLOW-07).
CREATE OR REPLACE FUNCTION kzppa_guard_closed_cycle() RETURNS trigger AS $$
BEGIN
  IF OLD.protocol_hash IS NOT NULL AND (
       NEW.protocol_hash IS DISTINCT FROM OLD.protocol_hash
    OR NEW.tally IS DISTINCT FROM OLD.tally
    OR NEW.eligible_snapshot IS DISTINCT FROM OLD.eligible_snapshot
    OR NEW.draft_version_id IS DISTINCT FROM OLD.draft_version_id) THEN
    RAISE EXCEPTION 'Протокол цикла % зафиксирован; результат нового рассмотрения оформляется новым циклом', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER cycles_protocol_guard BEFORE UPDATE ON cycles FOR EACH ROW EXECUTE FUNCTION kzppa_guard_closed_cycle();
--> statement-breakpoint

-- 6. Манифест QR-карточки после подписи не меняется (DOC-12); обновляется только статус проверки.
CREATE OR REPLACE FUNCTION kzppa_guard_qr() RETURNS trigger AS $$
BEGIN
  IF NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.manifest_hash IS DISTINCT FROM OLD.manifest_hash
     OR NEW.token IS DISTINCT FROM OLD.token OR NEW.document_version_id IS DISTINCT FROM OLD.document_version_id THEN
    RAISE EXCEPTION 'Манифест QR-карточки неизменяем: изменение фактов требует новой версии и подписи'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.pdf_sha256 IS NOT NULL AND NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256 THEN
    RAISE EXCEPTION 'Хеш итогового PDF уже зафиксирован' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER qr_cards_guard BEFORE UPDATE ON qr_cards FOR EACH ROW EXECUTE FUNCTION kzppa_guard_qr();
--> statement-breakpoint

-- 7. Отправленное исходящее не возвращается в черновик (STATE-03).
CREATE OR REPLACE FUNCTION kzppa_guard_sent_outgoing() RETURNS trigger AS $$
BEGIN
  IF OLD.state IN ('sent', 'bounced') AND NEW.state NOT IN ('sent', 'bounced') THEN
    RAISE EXCEPTION 'Отправленное письмо нельзя вернуть в состояние %', NEW.state USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('sent', 'bounced') AND (NEW.package_hash IS DISTINCT FROM OLD.package_hash
     OR NEW.body_text IS DISTINCT FROM OLD.body_text OR NEW.to_addrs IS DISTINCT FROM OLD.to_addrs) THEN
    RAISE EXCEPTION 'Содержимое отправленного письма неизменяемо' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER outgoings_sent_guard BEFORE UPDATE ON outgoings FOR EACH ROW EXECUTE FUNCTION kzppa_guard_sent_outgoing();
--> statement-breakpoint

-- 8. RLS включена на всех таблицах: доступ идёт только с сервера платформы через роль-владельца.
--    Клиентские ключи Supabase (anon) не получают прямого доступа к данным дел.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '__drizzle%' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
