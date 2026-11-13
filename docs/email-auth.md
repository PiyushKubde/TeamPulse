# Email and password sign-in

Email/password works **alongside** Google sign-in. Google sign-in behaves exactly as before; organization, invitation,
join-code and role rules are unchanged (no role is ever granted at sign-up).

## Status

| Piece | State |
| --- | --- |
| Code, migration, UI, tests | Done; unit/API tests and browser journeys pass (mail through a local SMTP sink) |
| Real email delivery | **Not configured and not tested.** Without a provider, the app offers Google only and says email sign-up/reset is unavailable |

## Turning it on

Set ONE provider in the app's environment (Embarko: App setup → Environment), then restart:

**SMTP (recommended: a transactional provider: Postmark, Amazon SES, Resend, SendGrid, Brevo, Mailgun, MSG91 Email)**

| Variable | Example |
| --- | --- |
| `MAIL_PROVIDER` | `smtp` |
| `MAIL_FROM` | `no-reply@yourdomain.com`: must be a sender/domain verified with the provider (SPF + DKIM) |
| `MAIL_FROM_NAME` | `KONVO` |
| `SMTP_HOST`, `SMTP_PORT` | from the provider, e.g. `smtp.postmarkapp.com`, `587` |
| `SMTP_SECURE` | `false` for 587 (STARTTLS, enforced), `true` for 465 |
| `SMTP_USER`, `SMTP_PASS` | the provider's SMTP credentials (secret) |

**Or Gmail through ViaSocket** (`MAIL_PROVIDER=viasocket_gmail`): needs the ViaSocket keys, an active KONVO member
who connected Gmail in the Automation Center (`MAIL_VIASOCKET_USER_ID` = their user id) and that connection's id
(`MAIL_VIASOCKET_CONNECTION_ID`). Fine for a pilot; Gmail sending limits apply and mail comes from that person's address.

Optional: `TERMS_URL`, `PRIVACY_URL` (linked from the sign-up checkbox; the app ships no legal text).

`/api/health` shows `email: configured | not_configured`; the server log prints `[auth] … email accepted by <provider>` or
`… FAILED …` for every send (never the link or the token).

### Verify before announcing it

1. Register with a real inbox you control → the verification email arrives (check spam) → confirm with your password.
2. Sign out → Forgot password → the reset email arrives → set a new password → old sessions are signed out.
3. Check the message headers show SPF/DKIM pass for your domain.

## How it works

| Flow | Behaviour |
| --- | --- |
| Register | Name, email, password (+confirm), terms. Policy: 12–128 chars, 3 of 4 character kinds (or 20+ chars), not common, not containing your name/email. Argon2id hash (m=19 MiB, t=2, p=1). Always the same answer, whether or not the email exists. |
| Verify | Link (24 h, single use) **plus the password chosen at sign-up**: someone who registers your email can never get it verified. Then the normal onboarding (create org / invitation / join code). |
| Login | One generic error for unknown email or wrong password; 5 failures lock the account for 15 min; 10 attempts/min per IP; an unverified account gets a fresh link. |
| Forgot / reset | Generic answer; link valid 30 min, once; stored only as SHA-256; a newer link cancels older ones; reset ends every session. |
| Change password | Needs the current password; other sessions end. |
| Google + password | Same verified email → one account. Google with a verified email links to an existing verified account (keeps its `sub`, org, role, history). An *unverified* password sign-up is never merged by email alone: if the real owner signs in with Google, the unproven password is removed. A Google user adds a password only through a link emailed to their address. |

Security: `X-Requested-With` CSRF header on every auth POST, HttpOnly/SameSite=Lax/Secure session cookie (only its hash
stored), per-address limit of 3 auth emails per 15 minutes, audit log entries `auth.*` for every event, no hashes or
tokens in responses or logs, SMTP never downgrades to plaintext.

Database: migration `006_email_password_auth.sql` (users: `google_sub` nullable; `email_verified_at`, `password_hash`,
`password_updated_at`, `failed_logins`, `locked_until`; new `auth_tokens`). Existing users, memberships and sessions
are kept; the migration runs inside a transaction with a foreign-key check.

Tests: `test/email-auth.test.js` (API), `npm run test:e2e:auth` (browser, local SMTP sink).
