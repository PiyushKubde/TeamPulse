# Communication sources for task intake

Task intake reads messages from a communication source and turns each into a **pending** task request (never an assigned or approved task).
Sources are a registry (`server/automations/sources/`): Gmail (a label), Slack (a channel), Microsoft Teams (a Team and one of its channels).
Adding a source (for example Outlook or Google Chat) is one module and one registry line; the common pipeline (`server/automations/intake.js`) does not change.

## Architecture rule

KONVO owns its organizations, teams, users, permissions and workflows. viaSocket is only the infrastructure for connecting external apps and delivering their events.
KONVO therefore never invents an identity on viaSocket: a connection lives under the KONVO user who made it (their own user id), and every rule about who may use it is KONVO's own and enforced on the server.
Organization-level shared connections are not implemented; if they are added later they must be a KONVO concept (KONVO records the sharing and enforces who may use it), not a viaSocket organization identity.

## Connections and permissions

- A manager connects their own Gmail, Slack or Microsoft Teams account (Connected apps) and sets up intake on it for the teams they manage.
- Another person's connection or intake is never visible or usable (404), including for an admin. An admin has no manager authority unless assigned to manage a team, and then only for that team.
- Employees cannot create or manage intake.
- Pausing, resuming and deleting is for the intake's owner (an admin may pause). Disconnecting a connection pauses every dependent intake before it is revoked.
- One subscription per connection and target: a second would deliver every event twice.
- An expired connection is reported to its owner with reconnect guidance; no new intake can be created on it.

Every intake records: organization, connection id, owner, source app, target, destination team, trigger key and version, status and counters.

## Safety

Incoming message text is untrusted data: it only becomes the text of a pending request and is never sent to an AI or an automation as an instruction.
Non-task messages are not stored (run logs keep only the reason they were ignored); Slack's existing 24-hour retention for ignored text is unchanged.
Microsoft Entra ID users are never mapped to KONVO users automatically; Teams messages can only become pending requests.

## Migration

`012_intake_sources.sql` lets `intake_subscriptions.app` also be `teams` (table rebuild; every row copied unchanged). It runs at startup in one transaction and rolls back on any error.
Back up the database file with its `-wal` and `-shm` files before deploying. The previous build keeps working on a database with 012 applied (it only never writes `teams`), so rolling back the code needs no schema change.
