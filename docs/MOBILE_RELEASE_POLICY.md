# OKRI web and mobile release contract

Status: implemented repository controls; store accounts, hosted native API,
CI environment protection and first physical-device receipts must be activated
before the first public app release. A passing local check is not a deployment.

## Product promise

- Web changes can ship when web and installed-client compatibility tests pass.
- Android and iOS are independent clients of the same authorized business data.
  A new web screen is NOT automatically a new native screen.
- Every product request is implemented on web first where appropriate and reviewed
  for native parity. Shared rules/copy reach native on its next verified release.
  Native UI work is explicitly included or deferred in the release notes.
- Weekly Tuesday 10:00 KST: CI validates sources and creates an immutable candidate.
  GitHub may delay scheduled runs. Target store cadence is every 14 days, not a
  guarantee of Apple/Google review time. Security incidents can release sooner.
- Public store release follows physical-device verification and store review.
  No scheduled job silently submits an untested build or buys an Expo plan.

## Support window

Each platform retains a version until ALL are true:

1. Its first newer version has been fully available in that store for 180 days.
2. At least two distinct newer versions are fully available in that store.
3. At least 30 days have elapsed after the announced retirement notice.

The latest two versions therefore remain supported regardless of age. A delayed
iOS approval does not start an iOS support clock when Android launches. Internal
testing, TestFlight and a partial rollout do not count as full availability.
Availability must include the supported countries and devices. Do not recommend
an upgrade that removes support for the recipient's OS.

`lib/mobile/releases.json` is an append-only factual ledger: no hypothetical
versions, fabricated store IDs, or release dates copied from build creation time.
Record store URLs only after checking actual listings. Validate retirement with
`npm run test:mobile-contract`. Publish notices in app release notes/support
communications; writing announcedAt alone does not deliver a user notice.

The policy endpoint is public, contains no user data and is advisory. It never
forces logout, blocks account deletion, reloads a form or erases a draft.
Malformed/offline/unpublished policy offers no update link. Retiring support
does not itself disable v1 or its writes. Removing an API is a separate reviewed
server change after all its clients retire. A critical security incident can
revoke affected sessions using existing auth controls; do not misuse version
headers as authentication or invent a blanket force-update switch.

## API and database compatibility

- Native business calls use `/api/mobile/v1/`. Auth keeps the already-defined
  `/api/native/*` PKCE/Apple/session/account contract. Never fall back to
  versionless web APIs after an error.
- `lib/mobile/v1-contract.ts` owns the wire shapes. Handlers share domain
  authorization, workspace membership, seat limits, validation and transactions.
  They do not proxy through the network or grant cookie/MCP access.
- Preserve field names, types, nullability, enum meanings, date/time-zone semantics,
  task completion meaning and Project/Routine peer relationships. Additive changes
  are allowed only when old clients still behave correctly. Never coerce an
  unknown status to todo/done. A missing critical read field fails visibly.
- The adapter maps the web current-member marker to the native current user.
  It does not expose other members' account IDs.
- Committed commands return stable acknowledgements, preventing a web response
  change from making users repeat an already-saved creation. Daily task creation
  and submission retain stable request IDs and existing idempotency. Neither the
  transport nor query mutations automatically retry writes. A lost network
  response can still be ambiguous for non-idempotent item creation: check the
  refreshed list before repeating it. Do not claim exactly-once generic writes.
- Freeze old consumer fixtures for each released client. Never regenerate them
  just to make a breaking change pass. If v1 cannot express a change, add v2 with
  an adapter for old clients and dual read/write behavior where needed.
- Migrations use expand/backfill/verify/contract. Keep old columns readable until
  clients and rollback builds no longer need them. No destructive down migration
  in a production rollback. Existing SQL is hash-locked; new potentially destructive
  SQL needs a source-bound review in `mobile/release/migration-reviews.json`.
  The SQL check is a conservative review trigger, not a proof of semantic safety.
  Existing DB guard, idempotency and authorization tests remain mandatory.
- `npm run build` runs mobile contract, native session and migration gates first.
  Do not deploy by bypassing npm's prebuild. The same checks run on PRs and main.

## Update lanes

1. **Web/server**: ship independently after old-client checks. Deploy additive
   backend support BEFORE publishing a dependent app. Keep the immediately
   previous server binary compatible with newly published clients.
2. **Store binary (default)**: features, native SDK/plugins, permissions,
   authentication, payments, native privacy declarations, scheme or signing
   changes go through App Store/Google Play review. SDK updates need new binaries.
3. **Optional signed OTA**: disabled by default in update-policy.json. Enable only
   after confirming the account's EAS signing entitlement/cost, generating and
   securely storing the key, committing its public certificate, and shipping
   signed-OTA-enabled binaries. No additional paid plan is provisioned here.
   Restrict OTA to reviewed fixes/copy/assets within the existing reviewed app;
   never use it to introduce functionality or evade store review.

Expo runtime `fingerprint` automatically separates incompatible native runtimes.
Preview and production channels are different. Use the production environment
to build/test a production candidate; a preview fingerprint is not assumed equal.
Updates use embedded/cache fallback with zero startup wait. Downloaded compatible
updates apply at the next cold start; no forced reload while writing. Local
storage migrations must tolerate the previous/embedded JS version after rollback.
The current app does not promise offline editing or durable unsaved drafts.

OTA promotion republishes the exact physically tested group, at 10% initially.
Check crashes, launch success, auth, workspace isolation and daily submit failures
before increasing to 25%, then 100%. Never auto-promote merely because time passed
or there were no reports. If the cohort is too small, extend testing, not the
confidence claim. Keep the previous good group/runtime recorded in the receipt.

## Release operations

Setup once:

1. Link the actual Expo organization and project. Set `EXPO_OWNER` and
   `EXPO_PUBLIC_EAS_PROJECT_ID` as repository/environment variables; set
   `EXPO_TOKEN` as a scoped secret. Keep production values consistent in EAS.
2. Configure GitHub `mobile-production` environment: required reviewer, no
   self-approval, deployment only from main. Require the
   `OKRI mobile compatibility / compatibility` check in main's protection rules.
   YAML cannot configure or prove these GitHub account-level settings.
3. Configure store credentials, Apple sign-in secrets and verified redirect/deep
   links. Deploy the additive native-session migration and v1 routes before builds.
4. For optional OTA, commit ONLY `mobile/release/update-certificate.pem`; keep the
   private key outside Git, in a restricted secret. Key rotation requires a new
   runtime/binary and continued updates for the old trust chain during its support.

For each release:

- Run root compatibility/full tests, both native type checks/bundle exports and
  the single-worker mocked browser suite. Browser export is not a device test.
- CI's `mobile/artifacts/candidate.json` records the exact source commit and
  digest, changed native/shared/server files and the parity review requirement.
  Set OKRI_PREVIOUS_MOBILE_COMMIT to the preceding mobile release when preparing
  a change report; without it the candidate inventories all relevant sources.
- `npm run build:android --prefix mobile` / `build:ios` creates production builds.
  Builds require a clean source state, real EAS project and reachable native API.
- Verify the exact signed artifact on a physical device for each platform. Create
  `mobile/release/device-verification.json` using the schema enforced by
  release-lib.mjs: source commit/digest, reviewer, time, per-platform EAS build ID,
  artifact SHA-256, runtime, device/OS and individual checks. Do not fill this
  record with simulator-only results or invented IDs. Receipts are attestations
  that require actual inspection of the referenced EAS artifacts, not independent
  proof just because their IDs parse.
- Required checks include old-client/new-server compatibility, Google/Apple login,
  daily submission, workspace isolation, account deletion, offline cold start,
  rollback, 200% text, screen reader, privacy and dependency review. Evidence
  expires after 14 days and is invalid if executable source inputs change.
- `submit:android` and `submit:ios` use the exact tested build ID, never --latest.
  Android goes to internal/draft; iOS upload goes to App Store Connect/TestFlight.
  These commands are NOT public store release. Complete each store's review and
  phased rollout, then record full availability separately for that platform.
- Optional `update:android` / `update:ios` requires a tested OTA group, matching
  runtime, store-policy review and the signing key; unconfigured OTA is blocked.

## Rollback and incident response

- Freeze promotions immediately on auth isolation/data loss/duplicate-write risk.
- For a partial OTA use EAS `update:revert-update-rollout`; for a full rollout
  republish the known-good group for the SAME runtime/channel or use the tested
  rollback-to-embedded path. No cross-runtime rollback.
- Halt staged store rollout. Already installed binaries cannot be remotely
  downgraded; ship a corrected store build while retaining compatible server APIs.
- Roll back server code only with a verified compatible database schema. Prefer
  an additive forward fix to destructive schema rollback. Backups are not a
  substitute for tenancy guards or API compatibility.
- Never log bearer tokens, daily contents or customer records for release metrics.
  Use existing service/EAS/store diagnostics and version/runtime IDs. No new
  user tracking SDK is introduced by this policy.

## Policy sources (reviewed 2026-09-08)

- [Expo SDK 57 Updates](https://docs.expo.dev/versions/v57.0.0/sdk/updates/)
- [Runtime compatibility](https://docs.expo.dev/eas-update/runtime-versions/)
- [Rollouts](https://docs.expo.dev/eas-update/rollouts/) and [rollbacks](https://docs.expo.dev/eas-update/rollbacks/)
- [EAS update signing and plan requirements](https://docs.expo.dev/eas-update/code-signing/)
- [Apple review guidelines 2.5.2](https://developer.apple.com/app-store/review/guidelines/#software-requirements)
- [Google Play device and network abuse policy](https://support.google.com/googleplay/android-developer/answer/16559646)

Store and Expo policies can change. Recheck before enabling OTA and before each
material authentication, privacy or payment change. No technical setup can
guarantee zero bugs or future store approval.
