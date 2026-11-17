-- Sanitized OMP agent.db authentication fixture.
--
-- This file is a declaration used by Rust tests to build a temporary SQLite
-- database. It is not a real OMP database, contains no real account and does
-- not prove native account discovery. Token values are synthetic markers used
-- to assert that credentials never leave the adapter.
--
-- The unrelated `session_state` table represents the other OMP state that
-- shares agent.db. Discovery must never read or export it.

CREATE TABLE auth_credentials (
  provider TEXT NOT NULL,
  type TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  api_key TEXT,
  expires_at INTEGER,
  account_id TEXT,
  email TEXT,
  plan TEXT,
  disabled_cause TEXT
);

INSERT INTO auth_credentials
  (provider, type, access_token, refresh_token, api_key, expires_at, account_id, email, plan, disabled_cause)
VALUES
  ('openai-codex', 'oauth', 'fixture-access-token', 'fixture-refresh-token', NULL, 4102444800, 'acct_codex_1', 'ops@example.test', 'plus', NULL),
  ('anthropic', 'oauth', 'fixture-access-token', 'fixture-refresh-token', NULL, 1, 'acct_anthropic_1', NULL, NULL, NULL),
  ('qwen', 'api_key', NULL, NULL, 'fixture-api-key', NULL, NULL, NULL, NULL, NULL),
  ('openai-codex', 'oauth', 'fixture-access-token', 'fixture-refresh-token', NULL, 4102444800, 'acct_codex_old', 'old@example.test', 'plus', 'logged out by user'),
  ('devin', 'oauth', 'fixture-access-token', 'fixture-refresh-token', NULL, 4102444800, 'acct_devin_old', NULL, NULL, 'deduplicated duplicate credential'),
  ('invalid provider!', 'oauth', 'fixture-access-token', 'fixture-refresh-token', NULL, 4102444800, 'acct_invalid', NULL, NULL, NULL);

CREATE TABLE session_state (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL
);

INSERT INTO session_state (id, body)
VALUES ('session-1', 'session-body-must-not-be-read');

CREATE TABLE token_usage (
  provider TEXT NOT NULL,
  token INTEGER NOT NULL
);

INSERT INTO token_usage (provider, token)
VALUES ('openai-codex', 42);
