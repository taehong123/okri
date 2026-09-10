# OKRI store release runbook

## Candidate scope

- Bundle/package ID: `ai.okri.app`
- Version: `1.0.0`; EAS remotely increments store build numbers.
- iOS: iPhone only for the first release. iPad is added only after separate layout,
  screenshot, text-size and VoiceOver verification.
- Android: phone and tablet layouts supported by the same responsive native UI.
- Native account creation uses Google and, on iOS, Sign in with Apple. Billing and
  subscription purchase are web-only and are not linked or promoted inside v1.
- Account deletion is available in `More > Settings > Delete account` and at
  `https://okri.ai/account-deletion?lang=en`.

## Review answers

- Login is required because all work belongs to an authenticated workspace.
- Reviewers can use their own Google account or Sign in with Apple. A new account
  receives an empty personal workspace; no invitation, payment or special role is
  needed to inspect and create OKRs, Projects, Tasks, Routines and a Daily update.
- The app does not track users, display ads, use an advertising identifier, read
  contacts/media, record audio, or request location. It sends user-created work
  content, account identity and workspace operations to `https://okri.ai` over TLS.
- The app uses standard HTTPS encryption only and declares
  `ITSAppUsesNonExemptEncryption=false`.
- Support: `taehong0613@gmail.com`; privacy: `https://okri.ai/privacy`; terms:
  `https://okri.ai/terms`; deletion: `https://okri.ai/account-deletion?lang=en`.

## Apple feedback webhook

After the App Store Connect app record exists, create one webhook in
`Users and Access > Integrations > Webhooks`:

- Name: `OKRI review feedback`
- URL: `https://okri.ai/api/store-feedback/apple`
- Secret: the same value stored as `APPLE_STORE_WEBHOOK_SECRET` in Sites.
- App: OKRI
- Events: App version state, build upload state, beta build state, TestFlight crash
  feedback and TestFlight screenshot feedback.

The endpoint verifies `x-apple-signature`, stores only delivery metadata and sends
only rejection, invalid-binary, failed-processing and tester-feedback events to
Slack. Normal progress events are acknowledged but ignored.

## Google Play feedback bridge

Google Play Console does not provide the same app-review webhook. Its review and
policy notices arrive by email. Create a Google Apps Script owned by the Play
account, paste `scripts/google-play-review-alert.gs`, then set Script properties:

- `OKRI_STORE_FEEDBACK_URL=https://okri.ai/api/store-feedback/google-play`
- `OKRI_STORE_FEEDBACK_SECRET`: the same value as `GOOGLE_PLAY_FEEDBACK_SECRET`
  in Sites.

Run `installGooglePlayReviewTrigger` once and grant Gmail/URL Fetch permission.
The script checks every five minutes. The server accepts only Google sender domains
and Google Play/Play Console subjects, signs every request, deduplicates message IDs,
and alerts only actionable review/policy messages.

## Slack target

- Workspace: `kuiver` (`T0ALNKB6HEZ`)
- Channel: `#talk-dev` (`C0AQ7SQC9P0`)
- Mention: 박태홍 (`U0ALQ0TAN6A`)

The OKRI Slack app must be connected to the workspace and invited to `#talk-dev`.
Production variables contain the IDs; no Slack token or webhook is committed.

## Submission gate

1. Deploy migrations and additive native APIs before the first build.
2. Build Android and iOS from the same clean commit with the production profile.
3. Install the exact signed artifacts on one physical Android phone and iPhone.
4. Complete every check in `docs/MOBILE_RELEASE_POLICY.md` and record the real IDs,
   hashes, devices and results in `mobile/release/device-verification.json`.
5. Upload Android to Internal testing and iOS to TestFlight. Resolve pre-review
   processing warnings before selecting the same builds for public review.
6. Fill store privacy, content-rating, app-access and reviewer notes from
   `mobile/release/review-readiness.json`; never infer answers from screenshots.
7. Public review submission remains a deliberate, human-confirmed action.
