# MOBY-D ⇄ Moby Cloud sync protocol v1

One Moby, two doors (the TUI on the Mac, the Telegram bot). Both write to one shared diary (D1). Webhooks are the fast nudge; the diary is the truth.

## Parties

| Side         | Runs                                 | Sends to                                            | Receives at                                                                          |
| ------------ | ------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| MOBY-D (Mac) | `cloud-sync` plugin                  | `POST https://moby-cloud.<acct>.workers.dev/events` | `POST https://mobyd.techsmartinc.com/events` (Cloudflare Tunnel, Access: owner only) |
| Moby Cloud   | `moby-cloud` Worker + Durable Object | the Tunnel URL above                                | its `/events` route                                                                  |

## Envelope (every event, both directions)

```json
{
  "event_id": "01J...ULID",
  "type": "job.state | heartbeat | decision | memory.index | session.turn | approval | proposal",
  "job_id": "01J... or null",
  "state": "proposed|approved|denied|running|done|failed|null",
  "payload": {},
  "ts": "2026-10-11T07:00:00Z",
  "from": "mac|cloud"
}
```

Headers: `X-Moby-Signature: sha256=<HMAC-SHA256(body, MOBYD_SYNC_SECRET)>`, `X-Moby-Event-Id: <event_id>`.

## Rules

1. **Signed.** Receiver recomputes the HMAC; mismatch → 401, event dropped, logged.
2. **Idempotent.** `event_id` is the primary key in `events`. A duplicate → 200, no-op.
3. **Diary is truth.** Receiver writes to D1 first, acts second. A lost webhook is recovered by `SELECT * FROM events WHERE id > :last_seen AND from != :me ORDER BY id`. Both sides poll this every 60 s as a safety net.
4. **Mac asleep.** Cloud → Mac webhooks that fail go to Queue `mobyd-events`; MOBY-D drains it on reconnect. No heartbeat for 5 min → watchdog alerts Commander.
5. **The cloud suggests, never commands.** A `proposal` from the cloud still passes NEMO + policy on the Mac. Approval state is set only by an `approval` event tied to Commander's Telegram id.
6. **Memory is one-way.** `memory.index` events point at `mobyd-shared` entries. Helix never receives any of this.

## Sessions: pick up where you left off

Table `sessions` holds Commander's working context. Written on **every turn** from either door; read by the other door **before** it responds.

- `last_turns`: last 20 turns, capped at 12k chars (older turns are summarized into `open_task`).
- `updated_by` ∈ {mac, cloud}; `updated_at` wins on conflict; conflicts are logged in `events` as `session.conflict`, never silently merged.
- Target: a turn on the Mac is visible in Telegram within 2 s and vice versa.
- If the Mac is asleep, the cloud keeps the record current; the Mac reconciles on wake before taking any action.

## Acceptance (M2)

- One read-only job round-trips: Telegram → proposal → approve → MOBY-D runs `check_disk` → result in Telegram and D1, 10/10.
- Start a task in the TUI, continue it in Telegram: no context lost.
- Drop a webhook on purpose: the poll recovers it within 60 s.
