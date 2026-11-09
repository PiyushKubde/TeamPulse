-- foreign_keys: off
-- Email/password sign-in alongside Google. users.google_sub becomes optional (a password-only account has none);
-- every existing row, id and Google subject is kept, so existing users and sessions are unaffected.

CREATE TABLE users_new (
  id                  TEXT PRIMARY KEY,
  google_sub          TEXT UNIQUE,
  email               TEXT NOT NULL,
  email_verified      INTEGER NOT NULL DEFAULT 0,
  email_verified_at   TEXT,
  name                TEXT NOT NULL,
  picture_url         TEXT,
  phone               TEXT,
  password_hash       TEXT,
  password_updated_at TEXT,
  failed_logins       INTEGER NOT NULL DEFAULT 0,
  locked_until        TEXT,
  last_login_at       TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
INSERT INTO users_new (id, google_sub, email, email_verified, email_verified_at, name, picture_url, phone, last_login_at, created_at, updated_at)
  SELECT id, google_sub, email, email_verified, CASE WHEN email_verified = 1 THEN updated_at END, name, picture_url, phone, last_login_at, created_at, updated_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE INDEX users_email ON users(lower(email));

-- Single-use, expiring tokens. Only the SHA-256 of a token is stored; the token itself exists only in the email link.
CREATE TABLE auth_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('verify_email','reset_password','link_password')),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX auth_tokens_user ON auth_tokens(user_id, purpose, used_at);
