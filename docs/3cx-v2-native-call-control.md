# 3CX V2 native call control (local implementation, not activated by this change)

## Architecture and boundaries

The existing monitor keeps the single PBX WebSocket, normalization, checkpoint/outbox,
native call IDs and completed/no_answer business handler. Its only additions are an
ephemeral live projection and optional shared OAuth cache. No mutative methods were
added to ThreeCxMonitor. ThreeCxController is the separate, audited action transport.
No audio, WebRTC, XAPI, configuration/routing/trunk/DID/queue/user/Zoho changes occur.

Official contract reviewed:
- https://www.3cx.com/docs/call-control-api-endpoints/
- https://github.com/3cx/call-control-sdk-ts/blob/master/src/types.ts

These confirm POST /callcontrol/{dn}/devices/{deviceid}/makecall with {destination, timeout}; participant answer,
drop and transferto. Answer requires direct_control=true on extension participants.
Drop/transfer are signaling actions and do not depend on uaCSTA; status and ownership
are still validated. No documented hold/resume operation exists in this contract.

## User mapping

Mongo users gain optional threeCxDn. Existing records remain unmapped, with no migration.
Admin/super admin can edit the field via the existing Users form and POST /api/users or
PUT /api/users/:username. Only empty or a configured operator extension is accepted:
THREECX_AGENT_DNS (comma separated, default 901,913; queues 910-912 and receptionists
920-922 are always refused). The monitor reads every listed DN at startup, so a DN must be
readable by the 3CX API application before it is added. GET /api/3cx/extensions returns the
configured operators and transfer targets for the Users form and the call cards. Existing target-role rules
remain in force. Values are never derived from names; no actual user mappings were set.
Each action and SSE tick re-reads the persisted mapping using the authenticated user's
identity. Changing/removing a mapping takes effect without trusting cached frontend data.
Unmapped users cannot use call control, including admins. No supervisor cross-DN actions.

## Public Leadium endpoints (all require the existing Bearer session)

| Method | Path | Input / result |
| --- | --- | --- |
| GET | /api/3cx/session | Own threeCxDn and available only |
| GET | /api/3cx/events | SSE: calls snapshot, heartbeat, session_expired |
| POST | /api/3cx/call | {phone}; returns accepted and native callId if supplied by PBX |
| POST | /api/3cx/calls/:callId/answer | {} |
| POST | /api/3cx/calls/:callId/hangup | {}; maps to drop, including ringing reject |
| POST | /api/3cx/calls/:callId/transfer | {target}; 901/913/910/911/912, excluding own DN |
| POST | /api/3cx/calls/:callId/hold or /resume | Explicit 422 unsupported; no PBX operation |

The client cannot choose a DN or participant. Extra command body fields are rejected.
Numbers must be external numeric telephone numbers (7–15 digits, optional +/00 and
ordinary spacing); short codes, service strings, URIs and arbitrary extensions are rejected.
Production dialing policies/trunk restrictions remain managed by 3CX, unchanged here.

## Real time and matching

Browser fetches SSE with Authorization header (no tokens in query strings), through
the gateway. The gateway polls the call-service's in-memory projection every 1.5s,
without additional PBX reads or a second PBX WebSocket. It rechecks the session and
persisted DN throughout the stream and aborts on disconnect/revocation.
Only active, sufficiently observed agent legs are projected. IVRs/queues are not agent
answers. The initial external customer number/direction and native callId are retained.

Customer lookup uses normalized exact phone variants, including Italian +39/local
forms. A unique matching practice supplies name/id; ambiguous matches do not choose
an arbitrary practice. Admin-only closed/ready practice metadata is withheld from
operators. Lookup failure does not block the phone popup. Matches are cached for 15s
per stream; existing practice access checks still apply when opening a practice.

SSE emits full own-DN snapshots, including status/capabilities/identity/times. The global
layout provider replaces/deduplicates by callId, updates connected/hold status, and
removes ended calls when no longer active. Transport loss clears stale controls and
reconnects with capped exponential backoff. A new inbound call reopens a collapsed panel.
No intermediate live state is newly persisted. Existing final persistence is unchanged.

## Security and operations

- THREECX_ENABLED retains its existing default false. When false no PBX connection or
  action is possible; no environment variables were changed by this tranche.
- Runtime OAuth is shared between monitor and controller, cached with expiry and a
  single in-flight refresh. Credentials stay server-side. Provider messages/bodies are
  never forwarded; auth failures/timeouts map to fixed, readable messages.
- The monitor must be connected before the internal action route accepts a command.
- A known call, own DN, unique active participant and fresh participant GET are required
  for actions. Native participant ID/callId are rechecked to protect against ID reuse.
- Answer is capability-gated; transfer requires Connected and a fixed allowed target.
- Identical requests share a promise while in flight and retain their result/error for
  5s. A DN serializes pending commands; different commands can follow completed ones.
  Rate limit is 12 commands/minute/DN. Mutations are never automatically retried.
- Action attempts and success/failure append userId, threeCxDn, action, native callId
  when known, server timestamp and result to Mongo threecxActions (or local NDJSON beside
  JSON_DB_FILE). No phone, provider payload, credentials or tokens enter action audit.
  Audit must be writable before issuing any PBX mutation. If the completion audit fails
  after PBX acceptance, the result is uncertain: inspect the live call, do not blindly retry.
- Internal live/action routes require a random process-scoped capability, not browser
  identity headers. The current dev-stack runs services/gateway in one process. Separate
  service processes require a deliberate authenticated transport design, not exposing ports.
- Idempotency/rate limiting and live projection are process-local. Keep the existing single
  application process/replica topology. Multi-replica active control needs distributed action
  locks and a shared live feed before scaling. Durable final-event dedup remains unchanged.
- No PBX mutations or production calls were performed for implementation/tests.

## UI and manual outcomes

Practice detail/list, quick detail drawer and the Chat phone action call the backend,
with no dependency on FaceTime/tel/3CX URI handlers. The global panel shows starting,
accepted or readable error state; pending submissions are locked synchronously.
Audio stays on the operator's 3CX device. The popup provides practice link, answer when
supported, reject/end, connected transfer, and a collapsible panel for small screens.
Unsupported answer displays 'Rispondi dal dispositivo 3CX'. Hold is visible as observed
status, with no invented hold/resume buttons. Commercial outcomes remain explicit via
'Registra esito' in the existing practice activity timeline header, outside the hero;
a failed command never changes practice state.

## Local verification and manual UAT

Backend default test suite includes controller and real gateway/SSE tests. Monitor tests
cover the existing Wivr -> Wqueue -> Wextension correlation and V2 live projection.
Frontend tests cover SSE framing/UTF-8, card capabilities, unknown caller and Calls admin
diagnostics. frontend/scripts/threecx-v2.browser.cjs runs isolated local gateway/SSE,
customer lookup and controller with a synthetic PBX; the real tenant is never contacted.
Use an existing Playwright runtime via PLAYWRIGHT_MODULE and optionally
PLAYWRIGHT_CHROMIUM_EXECUTABLE. Temporary screenshots/fixtures stay outside the repository.

Before any production activation/UAT (not performed here):
1. Review the commit separately from pre-existing report/CSV/Leadboard work.
2. Set the two actual Leadium users' DN mapping explicitly in Users (no name inference).
3. Confirm registered 3CX device behavior and action permissions without changing PBX setup.
4. Chrome Windows and actual Chrome macOS: dial a consented test phone once; verify device
   rings, browser remains in CRM, audio remains 3CX and native final log is unchanged.
5. Inbound DID -> IVR -> queues -> each agent: own popup only, correct customer/practice,
   unknown and duplicate/ambiguous phone matching, navigate pages without losing popup.
6. Test answer with direct_control true/false, reject/end, connected transfer to allowed
   agents/queues, and observe hold from the physical device. No API hold/resume is offered.
7. Verify audit, 5s dedup, session/mapping revocation, provider failure, reconnect, no stale
   controls and no duplicate final logs. Verify normal CRM/Chat operations while unavailable.
8. Inspect live admin diagnostics; observedDnTypes remains available and unchanged.

Native macOS and physical device/PBX actions require manual UAT. Browser automation on
Windows cannot certify actual Mac device integration or tenant mutation support.

## Final pre-commit audit

### Device-specific makecall and current-participant hangup

Call initiation uses only server-observed devices from the monitor's existing DN snapshots,
scoped to actor DN 901/913. Raw IDs stay in an ephemeral server-only control cache and never
enter diagnostics, SSE, action audit or browser responses. The cache is unavailable before
observation, on disconnection, with malformed data or after 30 seconds without refresh.
Unknown data returns 503; confirmed zero devices returns 409; multiple devices returns 409.
Exactly one device selects POST /callcontrol/{dn}/devices/{encodedDeviceId}/makecall with
{destination: normalizedPhone, timeout: 30}; there is no DN-level fallback and no client ID input.
The official guide labels the timeout field inconsistently in its table (timeoutSec) and
JSON example (timeout); this implementation follows the JSON example and requested contract.

HTTP 200/202 are acknowledgements; finalstatus must equal Success when present. Native callid
and returned participant ID are retained server-side when supplied; only callId is returned
to the browser. Acknowledgement does not prove the mobile client or external phone rang;
real-device outbound UAT remains necessary after a separately authorized release.

Hangup requires an own-DN live call or a short-lived (10-minute) own-DN makecall reference.
It re-reads the DN and selects the sole current participant for that native callid, then GETs
the participant and verifies DN/id/callid/status before drop. Dialing is accepted for hangup
only. Cached initiator IDs never override the current snapshot. Missing/malformed/ambiguous
state fails closed. A missing call in a valid snapshot, or a 404 confirmed by another snapshot,
returns accepted/alreadyEnded for a known own call. An active handover after 404 returns a
safe retry message instead of incorrectly reporting completion. Unknown/other-DN IDs remain
forbidden. Gateway errors use a fixed allowlist and never pass through arbitrary provider text.

### Monitor startup failure classification and checkpoint recovery

The device-diagnostics commit does not change claim, OAuth or WebSocket setup. In that
version lastConnectedAt is assigned before initial reconciliation; a null value therefore
does not establish a device-parsing failure. The former generic catch cannot distinguish
claim, authentication and handshake failures, so the actual production cause remains
unconfirmed until the classified diagnostic is available on that instance.

Only fixed local messages/codes reach lastError:

| Code | Message |
| --- | --- |
| checkpoint_claim_failed | 3CX checkpoint unavailable |
| authentication_failed | 3CX authentication failed |
| websocket_connect_failed | 3CX WebSocket connection failed |
| initial_reconcile_failed | 3CX initial reconcile failed |
| checkpoint_save_failed | 3CX checkpoint unavailable |
| monitor_transport_failed | 3CX monitoring transport failed |

No provider error/body, URL, stack or credential is interpolated. Device projection is
best-effort: missing/malformed data or a sanitizer exception omits the DN and does not
interrupt participants. Initial snapshot failure still closes/retries the transport safely.

The lease remains 45 seconds, owner-conditional and atomically acquired in Mongo. An old
unexpired owner cannot be forcibly evicted; graceful shutdown releases it, while a crash
requires expiry and backoff before takeover. Lease ownership is now renewed/checked before
opening the socket and before each PBX read so a long multi-DN snapshot does not depend
on one final save. Expired owners cannot renew/save, and releasing an old owner cannot
evict its successor. Cleanup attempts release even when checkpoint save fails. This fixes
pre-existing cleanup/long-snapshot risks without clearing checkpoints or outbox history.
Local JSON's short filesystem lock still fails closed if abandoned by a crash; it is a
development fallback, not a reason to steal a production Mongo lease or delete data.

### Device registration diagnostics (no makecall behavior change)

Admin GET /api/3cx/diagnostics and the existing Calls admin panel expose observedDevices
for 901/913 only, plus the JSON deviceCount map. Data is taken solely from the devices
array in already-read GET /callcontrol/{dn} snapshots. The official endpoint contract
documents the same device entries as GET /callcontrol/{dn}/devices; no extra PBX reads
or mutative calls are added. A confirmed [] means zero; an absent/malformed devices field
is unknown and the DN is omitted, never reported as zero. Normal reconciliation refreshes
the projection. Reading diagnostics itself performs no PBX request.

Only deviceIdMasked and userAgent are retained per device. Device IDs become HMAC-based
pseudonyms with a private random key, stable within the monitor instance and changed on
restart; no raw ID fragments are exposed or usable for control. Ordinary user-agent labels
are retained; suspicious auth, identity, phone/address/control/markup strings are redacted.
Missing user agents are empty; other device/provider fields and participants are excluded.
Disabled monitoring returns empty maps. Missing data in older API responses is supported
by the UI. Diagnostics access remains admin/super-admin; operators remain denied.

These changes do not prove which devices are actually registered on the tenant or prove
the cause of a failed outbound ring. Collect the new diagnostics after a separately
authorized release. Local tests use synthetic device fixtures only. That diagnostics-only
change kept DN-level makecall, participant actions, DN mapping and the normalizer unchanged;
the subsequent device-specific action change is documented above.

The activity outcome button is placed in the existing timeline header, outside the practice
hero. Local browser checks cover its placement, hit testing and opening/closing the existing
outcome modal on desktop and mobile. A mobile overlap with the floating panel was reproduced
and fixed by reserving its measured height as bottom scroll space. The ResizeObserver and
temporary CSS property are removed when the panel goes away.

Two reproducible SSE cleanup bugs were found and fixed during audit:
- A client disconnect during the initial asynchronous DN lookup could be missed before
  the close listener was installed. It is now installed before that lookup and removed
  on every exit. An already disconnected client cannot start the polling loop.
- A browser SSE parse error released the reader lock without cancelling the open response.
  The reader is now explicitly cancelled in finally before reconnecting.

Regression tests reproduced each failure before the fix. The dedicated server SSE suite
covers early disconnect, active-stream cleanup, inflight read abort, session expiration
and mapping revocation. The frontend suite covers reader cancellation on malformed SSE.
There are no new PBX action paths in the monitor and no classification changes in V2.
The pre-existing report/CSV/Leadboard working tree remains excluded; it must not be staged
as part of this tranche. The single-process/replica and physical-device UAT limits above
remain applicable.

### Outbound attempt diagnostics (makecall observability)

Every makecall attempt gets a random 8-hex reference (`attemptId`), returned to the browser and
shown in the live panel ("rif."). The controller keeps the last 25 attempts in memory and logs one
sanitized `[3cx] makecall` line each. Admin GET /api/3cx/diagnostics exposes them as
`recentCallAttempts` (Calls admin panel). The call-service answers /3cx/diagnostics only with the
internal capability the admin-gated gateway route attaches; direct calls get 403.

Each row: outcome (`accepted` = PBX acknowledgement only; `rejected_before_pbx`; `rejected_by_pbx`;
`pbx_unreachable`), code, HTTP status, sanitized finalstatus, device count, selected device as the
same HMAC pseudonym used by observedDevices, destination format/digit count/last two digits,
masked callId and a `correlation`:

| correlation | meaning |
| --- | --- |
| callid | monitor trace for the native callid returned by makecall, same DN |
| callid_other_dn | that callid seen only on another agent DN: uncertain |
| probable_no_callid | no callid returned; exactly one trace on the DN within 60 s: a guess |
| ambiguous_no_callid | several traces in the window: none attributed |
| pending | < 60 s, nothing yet |
| not_observed | nothing seen by this process; not proof that 3CX placed no call |
| not_applicable | the request never reached the PBX or was refused |

Traces hold `peer:status` steps of the 901/913 legs (`makecall_callback:Ringing`,
`external:Connected`, `ended`; legs on another agent DN are prefixed, e.g. `901/…`). No number,
name or provider payload. Trunk legs are not monitored: the 3CX call log remains the authority on
whether the external number was dialed. The live card omits the callback phase (the `MakeCall`
peer is not a customer number).

Limits: attempts and traces are in memory (lost on restart, per process). The monitor runs where
the Mongo lease is held; with more than one replica an attempt and its trace may live in different
processes and correlate as not_observed. Keep one backend replica.

Command timeouts: the gateway waits 25 s for /3cx/control (controller worst case OAuth 10 s +
PBX 10 s), so it no longer reports an unknown outcome while the PBX may still place the call.
Identical requests within 5 s share one result; there is no automatic retry. On a 5xx the panel
asks the operator to check the device before retrying.

Release note: the committed baseline (e3e2a08) used DN-level makecall. This tranche uses
device-level makecall (POST /callcontrol/{dn}/devices/{deviceid}/makecall, body {destination,
timeout}); the 3CX TS SDK only types the DN-level body, the device route is the one listed in the
official endpoint guide. Community reports (not 3CX staff) describe makecall as ringing the
originating extension/device first and dialing the destination only after it answers; this is
consistent with the field report but unproven for this tenant.

### Device selection per attempt

GET /api/3cx/devices returns, for the caller's own persisted DN only, the currently registered
devices as {device: HMAC pseudonym, label, userAgent (sanitized)}; null when the monitor is not
ready. The panel asks for a fresh list on every dial: none -> precise message, no request; one ->
used; several -> the operator picks (e.g. "Client web 3CX" / "App 3CX Android"), or cancels. POST
/api/3cx/call accepts {phone, device}; the controller resolves the pseudonym only against the DN's
current registrations (stale, foreign or raw IDs: 409/400, nothing sent). Without a device and
with several registrations it refuses (409). No device is ever chosen by position, no preference
is stored and nothing is retried automatically. Pseudonyms change when the backend restarts.

### Trust boundary for identities forwarded by the gateway

The gateway strips `__creator`, `__contactActor`, `__paymentActor` from every browser body and
re-adds only what the session proves, together with the process-scoped `x-leadium-internal`
capability (common/internalCapability.ts, same mechanism as the call-control capability). The
lead service drops those fields from any request without it, so direct callers are anonymous:
phone correction 403, payment write 401, creation deduplication treated as non-admin.
Internal services can be bound to loopback with `INTERNAL_SERVICE_HOST=127.0.0.1` (gateway still
listens on 0.0.0.0); default unchanged.
