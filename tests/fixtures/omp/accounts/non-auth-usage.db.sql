-- Sanitized non-auth runtime tables that must not be rendered as OAuth logins.
--
-- `token_usage` has a provider label and a numeric usage token, and
-- `auth_events` has an auth-ish name with only a bare token column. Neither is
-- a credential store, so discovery must reject the schema explicitly instead
-- of inventing a signed-in/unknown OAuth row.

CREATE TABLE token_usage (
  provider TEXT NOT NULL,
  token INTEGER NOT NULL
);

INSERT INTO token_usage (provider, token) VALUES ('openai-codex', 42);

CREATE TABLE auth_events (
  provider TEXT NOT NULL,
  token TEXT NOT NULL
);

INSERT INTO auth_events (provider, token) VALUES ('anthropic', 'event-marker');
