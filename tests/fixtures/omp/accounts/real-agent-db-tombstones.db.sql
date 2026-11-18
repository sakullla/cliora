-- Sanitized OMP 18.20.2 auth_credentials shape with tombstones.
--
-- OMP's active list is `WHERE disabled_cause IS NULL`. /logout, deduplication
-- and failed refresh paths leave rows with a non-NULL disabled_cause while the
-- JSON data keeps access/refresh material. These rows must not become signed-in
-- logins or duplicate a provider.

CREATE TABLE auth_credentials (
  provider TEXT NOT NULL,
  credential_type TEXT NOT NULL,
  data TEXT NOT NULL,
  disabled_cause TEXT,
  updated_at INTEGER NOT NULL
);

INSERT INTO auth_credentials
  (provider, credential_type, data, disabled_cause, updated_at)
VALUES
  ('openai-codex', 'oauth',
   '{"type":"oauth","access":"fixture-access-token","refresh":"fixture-refresh-token","expires":4102444800,"accountId":"acct_codex_1","email":"ops@example.test","plan":"plus"}',
   NULL, 1),
  ('openai-codex', 'oauth',
   '{"type":"oauth","access":"fixture-old-access","refresh":"fixture-old-refresh","expires":4102444800,"accountId":"acct_codex_old","email":"old@example.test"}',
   'logged out by user', 2),
  ('devin', 'oauth',
   '{"type":"oauth","access":"fixture-old-access","refresh":"fixture-old-refresh","expires":4102444800,"accountId":"acct_devin_old"}',
   'refresh failed', 3);
