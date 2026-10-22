# Slack ticket automation

Customer names, channels, assignees, execution slots and models are workspace
configuration, never application constants.

## Slack operation and intake coverage

Use `/okri ticket [search]` or `!티켓관리` to operate the queue inside Slack.
Source text is posted first; its thread contains separate proposals classified as
bug fix, improvement, feature, or guidance. Each proposal states the customer's
problem, proposed solution, observable acceptance criteria and open questions,
and asks whether to proceed. Guidance never starts a development runner.
The workspace default model also drives recommendation analysis; the unset
recommendation default is `gpt-6.1-sol`. Provider/budget failures remain pending
instead of silently switching models or discarding the original.

Slack modals edit category, title, scope, priority, product/repository, assignee,
slot, dependencies and completion requester. Buttons create and approve tickets;
replies or modals answer questions. Warning acknowledgement, stop, reanalysis,
completion wording and exact-text sharing also remain in Slack. These operations
write the same workspace-scoped request and revision used by OKRI.
Set the Slack app's Options Load URL to `/api/slack/interactions` for dynamic
member, repository, slot and dependency searches. Existing bot/user scopes suffice.
When Slack omits unsaved modal inputs from a search request, slots are labeled
with their PC, assignee and product across the current workspace. Saving still
requires the selected assignee, product, repository and slot to match.

Customer events are committed before Slack is acknowledged. Versioned message
receipts, expiring processing leases and retries survive failed analysis or
process restarts. Activation saves a future-only start time; recovery reads newer
messages, never silently importing an old backlog. An admin may explicitly import
one source with `import_source` (at most one recommendation, always manual review),
or by sharing its source link in the configured management channel, without
moving that cursor. Only a linked workspace admin can import an old source.
Each independent issue in a message is
committed atomically with its source and recommendation outbox records. Recovery
never automatically approves old work. Request lists and collection receipts are
paginated rather than silently hidden behind the first 200 requests.

The collection view reports per-channel history passes, pending replies, errors,
pending analyses and exclusion reasons, with an operator review/retry action.
Unapproved bots remain auditable without triggering analysis. Coverage extends to
enabled channels the app can read and messages Slack still retains; inaccessible
channels and incomplete reads never count as complete. Ambiguous Slack sends are
matched by a stable correlation id; absence of confirmation never causes a blind
resend. Native mobile APIs and existing records remain compatible.

Short message bursts wait 20 seconds, then a customer-channel lease serializes
analysis across threads. A bounded burst (20 receipts) shares one model call.
Existing issues are matched only within the same workspace, customer channel,
product and repository using concrete entity and symptom/workflow evidence.
Every issue retains its source-thread links. Known issues use compact scope and
latest-fact memory plus new/nearby messages instead of replaying all old text.
Oversized evidence remains in the retry queue for explicit review; it is never
silently truncated and marked complete. Slack retention and read permissions
still limit coverage.

Linked threads are checked incrementally every five minutes (bounded, fair queue;
large queues and provider retries can take longer). Unchanged messages cause no
AI call. Clarifications reach the current isolated runner at its next turn
boundary, are acknowledged after application, and gate completion. Changed scope
cancels the old job and requires operator review and fresh approval. The final
completion check also rereads the linked source hashes. Older runners cannot
silently finish with unacknowledged changes; update their runner script to consume
the additive report response. No new customer text grants tools or permissions.

An admin can grant 1–100 additional analyses until the next UTC midnight through
`analysis_allowance`. This replaces the day's extra allowance rather than stacking
grants, preserves atomic reservations, minute/workspace limits and monetary
budgets, and records the operator and expiry in the audit log.

## Setup

1. Ticket → Ticket automation → Channel settings: load channels, select the
   management channel and customer prefix, and connect matches. Private channels
   appear after their members add the existing OKRI app.
   Trusted relay apps are optional per-channel settings: allowlisted bot user IDs,
   incoming-message prefix and optional content start/end markers. Unknown bots
   and OKRI itself never trigger intake. Configure markers to omit transport
   metadata and delivery reports. Common Korean mobile numbers are removed before
   persistence or summarization. A relay bot is never the completion recipient;
   the operator must select an active human from the original Slack channel.
   First configure Product/repositories: reviewed product specification, canonical
   HTTPS Git repositories, dependency installation roots and PC setup instructions.
   Product revisions accompany every job; edits invalidate earlier approvals.
   PC setup instructions appear only in trusted connection instructions, never
   as instructions supplied by a customer message.
2. Choose each customer's assignee. Automatic slot assignment is the default;
   a specific slot is optional. Per-customer auto approval covers low-risk copy
   and style only. Other requests require review.
3. Execution slots: choose an assignee, PC label, product/repository, customer,
   name prefix and quantity (1–20). The same account can create ten slots on each
   of several PCs. Bulk connection includes only the selected PC's unconnected
   slots, with a separate single-use credential for each slot. Each
   person selects their customer project, generates connection instructions,
   pastes them into their own Codex chat and selects the matching local repository.
   Codes expire in ten minutes and are single-use. Only the owner pairs a slot.
4. Models come from the connected CLI's `model/list`. Apply a slot override,
   workspace default, then that computer's Codex default. Unsupported explicit
   selections stop assignment instead of silently switching models.
5. Review Slack destinations and templates before enabling delivery. Production
   activation must respect the operator's additional Slack approval rules.

## Lifecycle

Customer thread → recommendation → edited and assigned Ticket + child Task →
development approval → execution slot → development → completion review →
exact-text sharing approval → customer-thread notice and completion reaction.

The existing metered summarization call also distinguishes concrete work from
acknowledgements and delivery/status receipts. Non-work produces no recommendation.
When classification is unavailable, plausible requests remain for manual review;
automatic approval requires a positive classification as well as the policy gates.
Explicit manual Ticket forms retain their original behavior.

The queue exposes unassigned, approval pending, answer pending, completion sharing
pending, blocked and failed work. Each request displays its assigned slot.
Automatic assignment uses online slots belonging to the assignee, configured
for that customer and product, reporting the expected Git remote, and supporting
the selected model, ordered by pending work. One device runs one active job.

Explicit prerequisites run before dependents. Eligible jobs use urgent, high,
medium, low order; running jobs are not preempted. Slots working on the same Git
remote exchange approved scope and planned paths. Overlap requires an acknowledged
coordination warning. Deployment order is a review queue: after actual merge or
deployment the operator records the verified Git commit. Dependents verify that
commit exists in their local checkout before starting. The system does not apply
patches, merge branches or deploy automatically.

The worker asks one business question with `OKRI_QUESTION:` and stops. Only a
linked assignee or administrator can answer in the management thread. Resuming
rechecks source, assignment, device membership and policy. Progress is deduplicated
in ten-minute buckets. The existing scheduler runs the queue each minute.

## Security and delivery

Existing routes verify Slack signatures and replay timestamps. Customer text
cannot select local paths, models, tools, tokens or devices. Summarization uses
the existing metered AI budget and full-thread reader. Linked pages and files
are not fetched by this automation.

Manual and automatic approvals both recheck security. Changed source blocks the
request; approval cannot bypass a block. Pickup repeats the checks. Revocation,
membership removal, disabled slots and disconnected channels stop pending pickup.
Older runners cannot claim isolated ticket jobs.

The runner verifies its sandbox before consuming a pairing code. Immediately
before implementation, Codex performs a short, read-only model review. The
device-bound checkpoint rechecks source, workspace, assignee, slot, selected
model and lease. Its verdict is tied to the approved scope and snapshot digest.
Warnings stop the job in `security_review`; only the assignee or administrator
can acknowledge the warning and record a reason. A new review must still pass
the hard boundaries. A changed snapshot or new warning needs another review.
Secret access, exfiltration and permission bypass cannot be forced through.
Completion reports require a successful preflight record for that exact job.

Security history records actor, action, revision, safe reason codes and digests.
It never stores model reasoning, environment values, device tokens or source
code. Known English/Korean credentials, token URLs and private keys are redacted
before persistence and before AI summarization. The UI shows the latest 100
audit entries; older entries remain in the workspace database.

Ticket work uses a temporary copy of local Git-visible files. Environment files,
credential locations, symlinks, databases, data exports and detected secrets are
excluded. Codex has restricted filesystem access to the snapshot, no network, no
MCP servers, no interactive tools and no escalation. Review patches are saved
locally in `.okri-ticket-results/`. Patch application and deployment are separate
operator actions. Completion drafts must not claim an unperformed production rollout.

Windows uses the non-root Docker executor with all host capabilities dropped,
no-new-privileges, CPU/memory/process limits and only the sanitized snapshot plus
read-only CLI authentication mounted. Only the Codex harness can use that
authentication; model tools cannot read it. Apps, plugins, browser tools, MCP
and web search are disabled. Codex's inner permission profiles deny network and
outside reads, with a separate read-only profile for review. A derived Docker
seccomp profile retains the Moby default allowlist and permits only the namespace
operations needed for unprivileged bubblewrap. No privileged mode, SYS_ADMIN,
unconfined seccomp, host home or Docker socket is permitted. Profile source:
https://github.com/moby/profiles/blob/main/seccomp/default.json (Apache-2.0).
Run `node scripts/check-ticket-sandbox.mjs` after building the supplied image to
verify snapshot writes, outside-read denial, network denial and review immutability.
The agent repeats credential-visibility/network checks before connecting.
Native executors must pass the same strict self-check and never fall back to
broader permissions. Local dependencies omitted from the snapshot may need
separate operator verification; the worker must report that limitation.

Pattern checks are an additional signal, not proof that arbitrary text is safe.
Isolation and final exact-message approval remain required boundaries.

Workspace-scoped revisions and atomic batches prevent duplicate item/job writes.
Foreign-key guards remain enabled. Source identity deduplicates repeated events.
Uncertain Slack writes are never blindly retried; the queue flags them for operator
verification against the actual thread before manual correction.
Final publication freezes the approved requester and exact escaped text until
delivery. The operator may cancel only while the outbox is still pending.
Stopping a job revokes its lease; the worker stops its container and saves a
partial local review patch on its next progress check (normally within 30 seconds).

Node and Go dependencies are prepared once per product/repository, lockfile, installation
roots and executor image, behind a cross-process cache lock. The preparer receives
only sanitized source and no authentication or device token, runs npm ci with
installation scripts disabled, then mounts dependency directories read-only into
development containers. The image includes Node and Go; configured paths detect
package-lock.json or go.mod/go.sum. Go modules are downloaded without credentials
and mounted read-only; development disables module downloads and uses a local
temporary build cache. Unsupported installation requirements are reported for
operator review. This allows ten slots to share dependencies without ten installs.

Migration 0073 adds isolated tables only. Historical migrations and mobile v1
fixtures are unchanged; keep new rows on code rollback. Run focused lifecycle and
security tests, mobile contract checks, the normal build and mocked browser checks
with one worker before deploying through the existing GitHub main/self-hosted flow.
