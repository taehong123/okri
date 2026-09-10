# OKRI web and mobile release contract

Status: store-binary-only production updates. Expo packages are used as local
React Native framework tooling, but OKRI does not use an Expo account, EAS Build,
EAS Submit or EAS Update. Android is signed locally or in GitHub Actions. iOS is
compiled and signed by Xcode on a GitHub-hosted macOS runner.

## Product promise

- Web and server improvements can ship continuously after compatibility checks.
- Android and iOS remain independent clients of the same authorized business data.
  A web UI change does not silently become a native UI change.
- Every product change is classified in `mobile/release/parity.md` as shared API,
  native parity, web-only or deliberately deferred.
- Tuesday 10:00 KST CI creates a source-bound candidate. The target store cadence
  is every 14 days after device checks; store review time is outside OKRI control.
- Security or data-integrity fixes can produce an earlier binary, but no workflow
  publishes an untested build or automatically releases it to all users.

## Supported installed versions

An installed platform version remains supported until all are true:

1. Its first newer version has been fully available in that store for 180 days.
2. At least two distinct newer versions are fully available in that store.
3. At least 30 days have elapsed after a user-visible retirement notice.

The latest two fully available versions therefore remain supported regardless of
age. Android and iOS clocks are separate. Internal testing, TestFlight, partial
rollout and review approval are not full availability.

`lib/mobile/releases.json` is an append-only factual ledger. Record a store URL,
build number and availability date only after checking the live listing. The
public policy endpoint is advisory: malformed, offline or unpublished data never
logs the user out, erases a draft, or points to an untrusted update URL.

## API and data compatibility

- Business calls use `/api/mobile/v1/`; native authentication keeps the existing
  `/api/native/*` PKCE, Apple, session and deletion contract.
- v1 handlers retain authorization, workspace membership, seat limits, validation,
  transactions, Project/Routine peer structure and daily idempotency.
- Field names, enum meanings, date/time-zone semantics and completion behavior are
  stable. Unknown critical values fail visibly instead of being coerced.
- Additive backend support deploys before a dependent app. The previous production
  server binary must also accept the new client during rollback.
- Frozen consumer fixtures are never regenerated to hide a breaking change. Add
  `/api/mobile/v2/` when v1 cannot express a change safely.
- Database changes use expand, backfill, verify, contract. Existing migration SQL
  remains hash-locked and LF-only; old columns remain readable through the client
  support window. Packaging errors never justify weakening database guards.

## Update lanes

1. **Web/server**: continuous deployment after old-client contract tests.
2. **Android store binary**: local Gradle release AAB signed with the stable upload
   key. First upload is manual; later internal-track uploads may use a restricted
   Google Play service account.
3. **iOS store binary**: Xcode archive on GitHub macOS using the App Store Connect
   API key and automatic signing, then upload to TestFlight.

There is no JavaScript OTA lane. Copy, translations, assets, feature code, SDKs,
permissions, authentication and payments all reach installed mobile users through
a reviewed store binary. `mobile/app.config.ts` keeps remote updates disabled.

## Key custody

- Android upload key: keep one encrypted offline backup and GitHub environment
  secrets `OKRI_ANDROID_KEYSTORE_BASE64`, `OKRI_ANDROID_STORE_PASSWORD`,
  `OKRI_ANDROID_KEY_ALIAS`, and `OKRI_ANDROID_KEY_PASSWORD`.
- App Store Connect: use a least-privilege API key stored as `ASC_KEY_ID`,
  `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY`, and `APPLE_TEAM_ID` in the protected GitHub
  `mobile-production` environment. Never place a `.p8` file in Git.
- Google automation, once enabled, uses `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` with
  only the permissions required for the OKRI app and internal releases.
- GitHub `mobile-production` requires a reviewer, disallows self-approval where the
  plan supports it, and accepts deployments only from `main`.
- Losing an upload or distribution key can block releases. Rotate through the
  store-supported process; never replace a key just to make a build pass.

## Candidate and artifact provenance

- `mobile/scripts/candidate.mjs` records the exact source commit and digest.
- `build:android` and `build:ios` refuse dirty source trees and check the live v1
  policy endpoint. iOS also confirms production Apple sign-in is enabled.
- Every build writes a manifest containing platform, semantic version, store build
  number, source commit, source digest and SHA-256 of the signed AAB or IPA.
- Build numbers only increase. Never rebuild a different binary under a number that
  has already reached Play Console or App Store Connect.
- `device-verification.json` is created only after testing that exact SHA on a
  physical device. Browser previews and simulators are not physical evidence.

Required physical checks: Google login, Apple login on iOS, cancel/back behavior,
daily submission, workspace isolation, role restrictions, account deletion with a
designated test account, cold and offline start, 200% system text, TalkBack or
VoiceOver, safe areas, privacy declarations, dependency advisories and previous
client compatibility. Evidence expires after 14 days or any executable input
change.

## Store progression

1. Build the exact signed artifact from committed `main`.
2. Test Android through internal testing and iOS through TestFlight.
3. Record physical-device evidence bound to the artifact SHA.
4. Complete metadata, app access, privacy/data safety, content rating, export and
   reviewer notes from `mobile/release/review-readiness.json`.
5. Submit closed testing or App Review only after explicit human confirmation.
6. Start public rollout in stages, observe crashes, login, API errors and daily
   submission failures, then deliberately advance the rollout.
7. Record full availability independently for Android and iOS.

The new personal Google Play account currently shows the production-access gate:
at least 12 opted-in closed testers for 14 consecutive days. Internal testing and
store setup can proceed immediately; public production cannot bypass that gate.
Recheck the Console because Google can change account-specific requirements.

## Rollback and incidents

- Freeze rollout on authentication isolation, data loss or duplicate-write risk.
- Halt a staged store rollout immediately. Installed binaries cannot be remotely
  downgraded, so retain compatible server APIs and ship a corrected build number.
- Roll back server code only with a compatible database schema. Prefer an additive
  forward fix to a destructive schema rollback.
- Never log bearer tokens, daily content or customer records for release metrics.
  Use app version/build, artifact digest and store diagnostics.
- Apple and Google review feedback alerts mention the configured maintainer in the
  Slack development channel, but alerts never auto-change code or store status.

## Before each release

- Run root compatibility/full tests, native type checks and unit tests, both JS
  bundle exports, and the one-worker mocked browser suite.
- Recheck current Apple App Review, Google Play policy, target SDK, privacy and
  billing requirements from official store documentation.
- Verify account deletion at `https://okri.ai/account-deletion`, support links,
  privacy policy, authentication redirects and store listing translations.
- Compare web changes since the previous mobile release and update parity notes.

No technical setup can guarantee store approval, but this process blocks the common
causes of rejection before submission and keeps frequent web work compatible with
older installed clients.
