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

These confirm POST /callcontrol/{dn}/makecall with {destination}; participant answer,
drop and transferto. Answer requires direct_control=true on extension participants.
Drop/transfer are signaling actions and do not depend on uaCSTA; status and ownership
are still validated. No documented hold/resume operation exists in this contract.

## User mapping

Mongo users gain optional threeCxDn. Existing records remain unmapped, with no migration.
Admin/super admin can edit the field via the existing Users form and POST /api/users or
PUT /api/users/:username. Only empty, 901 or 913 are accepted. Existing target-role rules
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
authorized release. Local tests use synthetic device fixtures only. DN-level makecall,
participant actions, DN mapping and the normalizer remain unchanged.

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
