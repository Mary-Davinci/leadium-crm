# 3CX Call Control monitoring in Leadium

This is an event observer, independent of Zoho's CRM integration. It neither selects a CRM
template nor uses ReportCall, XAPI, call actions, media, chat, routing or configuration APIs.
The existing `POST /api/3cx/webhook` and browser bridge remain available for compatibility.

## Configuration and authentication

Server-only variables: `THREECX_ENABLED`, `THREECX_BASE_URL`, `THREECX_CLIENT_ID`,
`THREECX_API_KEY`. The enabled flag defaults to false and only the exact string `true`
starts the listener. Disabled means no token request, socket, PBX reads or checkpoint access;
even the credential value is not read by the monitor. `configured` checks the presence of the
configuration (an empty/invalid key is still rejected before a token request).

The base URL must be an HTTPS origin without credentials, query, fragment or path.
The intended origin is `https://davinciformazione.my3cx.it:5001`, client ID `leadiumcrm`.
No deployment variable is changed by this implementation. The key must never be sent to
the frontend or included in logs, exception messages, diagnostics or checkpoint data.

Authentication is `POST /connect/token`, form URL encoded:
`grant_type=client_credentials`, `client_id`, `client_secret` (the API key).
Only a bearer token is used for subsequent reads and the WebSocket upgrade; it stays in memory.
The connection is renewed before token expiry. There is no XAPI request or additional scope.

## Read-only endpoint allowlist

- `POST /connect/token` — authentication only, not a call action.
- `GET /callcontrol/ws` — WebSocket notifications, bearer header, no query-string token.
- `GET /callcontrol/{dn}` — snapshot and entity type.
- `GET /callcontrol/{dn}/participants/{id}` — full participant state.

`dn` is hardcoded to **901, 913, 910, 911, 912**. Even if the principal sees extra entities,
their notifications cannot trigger reads or call processing. A root notification reconciles
only those five DNs. No WebSocket application requests are sent; protocol ping/pong only.
TLS certificate validation remains enabled. Redirects are rejected, HTTP and handshake timeouts
are 10 seconds, internal delivery timeout 15 seconds. Reconnect/auth failures use exponential
backoff (1–60 seconds plus jitter). Heartbeat is 15 seconds; reconciliation is 10 seconds.

## Actual event contract and correlation

The official service example uses:

```json
{"sequence":42,"event":{"event_type":0,"entity":"/callcontrol/901/participants/5120"}}
```

`event_type=0` means re-read the entity; `1` removes the participant. Other event kinds
do not contain an outcome and are not interpreted as calls. Notifications contain no call
snapshot. The monitor fetches the participant with `id`, `dn`, `status`, `callid`, `legid`,
`party_dn`, `party_caller_id`, `party_dn_type`, `originated_by_dn`. Native numeric `callid`
groups legs across monitored DNs; `dn/id` identifies a participant. No synthetic call ID is made.

`Dialing` / originator matching the DN implies outbound; `Ringing` implies inbound, except
the `MakeCall` pseudo-party. Direction first observed is retained across queue handovers.
Already connected snapshots have no reliable direction/history and are treated conservatively.
Outbound prefers the external `party_dn`, inbound the external `party_caller_id`.
Only plausible external telephone numbers are accepted; internal peers, short DNs and
MakeCall pseudo-parties cannot become customers. This also excludes all five monitored DNs.
If an API-originated call never exposes its destination, no customer number is invented.

The authoritative DN `type` distinguishes Extension from Queue/RingGroup/RoutePoint.
Only an Extension reaching Connected/Hold/Held establishes an observed agent answer.
A connected queue alone is not a human answer. The answering extension is preferred as agent.
Once all known legs end, a 3-second grace period and fresh allowlisted snapshots accommodate
handover before finalizing. A call continuing entirely outside the monitored set is not visible;
the listener does not claim global PBX completion beyond this observation boundary.

## Final event and existing business processing

One durable final payload goes to the existing `POST /internal/call-events`:

```json
{
  "eventType":"call_control_final",
  "callId":"123456",
  "from":"+393331234567",
  "agent":"913",
  "direction":"inbound",
  "startedAt":"2026-10-16T10:00:00.000Z",
  "answeredAt":"2026-10-16T10:00:05.000Z",
  "endedAt":"2026-10-16T10:01:40.000Z",
  "durationSeconds":95,
  "disposition":"completed",
  "note":"3CX Call Control: tempi osservati dal listener; durata dalla prima risposta osservata."
}
```

Times are **listener observations**, not exact historical PBX timestamps; duration is elapsed
time after the first observed answer (including holds). A missed call has zero conversation
duration and no answeredAt. The participant contract does not expose historical timestamps.
An incomplete observation, sequence gap, lost participant before its first read or socket
outage marks the call uncertain: its checkpoint is retained as a quarantined final with
`event:null`, and it produces no guessed business outcome. Calls starting and ending entirely
during downtime cannot be recovered by these active-state endpoints.

Mapping: observed agent answer → `completed`; fully observed disappearance without answer →
`no_answer`. The documented participant statuses do not distinguish busy: the monitor does
not emit `busy`. Unknown statuses are quarantined, not coerced. No interested, not_interested,
callback, quote_sent or quote_required is inferred. Existing workflow/timeline logic handles
the event; only additive direction/answeredAt metadata is stored by the existing handler.

## Persistence, retry and shutdown

The Mongo collections `threecxMonitor` and `threecxFinalCalls` hold an expiring leader lease,
active observations and durable final/outbox records. `_id` ensures one checkpoint/lease per
PBX and one final record per PBX/native call ID. Only the lease holder may save or deliver.
No existing collections are migrated or cleared. Local JSON mode uses an atomic checkpoint
replacement and a short file lock, with the same expiring owner lease. An abandoned local
`.lock` fails closed; inspect it before restarting a development fixture.

The outbox is written before delivery. Lost acknowledgements retry the identical native
call ID; the existing handler uses `leadId + 3cx_<callId>` to ignore sequential duplicates.
The listener's lease serializes its own deliveries across replicas. The legacy webhook still
has its original read-before-write behavior: a concurrent independent webhook with the same
call ID is not covered by an atomic business-layer transaction. Do not feed the same calls
simultaneously from a second primary connector. Do not send commercial outcome amendments
under an already finalized call ID.

SIGTERM/SIGINT abort pending HTTP, terminate the socket, await queued checkpoint work, preserve
the outbox and release the lease. This is wired for both the standalone service and dev-stack.
No PBX hangup or participant operation occurs during shutdown.

Native ID uniqueness across PBX restarts must be confirmed on the actual tenant before enabling;
the implementation deliberately does not append synthetic IDs to hide possible ID reuse.
Mongo persistence (or a durable local JSON volume) is required across service restarts. Retention
of final IDs and quarantined records should be planned against actual call volume.

## Diagnostics

`GET /api/3cx/diagnostics` is authenticated and admin/super_admin-only; the internal endpoint
is `/3cx/diagnostics` on call-service. Like the existing webhook services, internal service ports
must not be publicly exposed. Response keys only:

`enabled`, `configured`, `connected`, `lastConnectedAt`, `lastEventAt`, `lastCallId`, `lastError`.

The ID is partially masked. Errors are fixed strings; raw provider errors/bodies, tokens, keys,
telephone numbers and URLs are never included. No credentials are returned by `/health`.

## External validation before enabling (not performed by implementation)

Keep THREECX_ENABLED=false until an explicitly authorized rollout. Verify token permission,
TLS reachability and entity types with the configured service principal, without enabling XAPI
or changing Zoho. Check inbound/outbound calls on 901/913/910, queue handovers on 911/912,
unanswered calls, holds, native ID stability, reconnect and service restart. Compare observed
times with PBX records; check unmatched or quarantined cases. Do not assume exact PBX timings
or busy cause information exists. No real tenant access, deployment or activation is required
to run the mock regression tests.

## Sources verified for the implementation

- https://www.3cx.com/docs/call-control-api/
- https://www.3cx.com/docs/call-control-api-endpoints/
- https://github.com/3cx/call-control-service-example (`src/auth.ts`, `src/types.ts`, `src/call-monitor.ts`)

The official examples also contain mutating call actions. Those APIs and action helpers are
deliberately not imported or used in Leadium.
