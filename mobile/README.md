# OKRI Native

React Native + Expo SDK 57 companion for iOS and Android. This is not a WebView wrapper.
The website remains a separate application. Shared theme tokens and translations
are imported from the repository's `lib` directory.

## Implemented

- Assigned tasks, completion, due dates and overdue status.
- Projects, native create/edit forms, assignment and parent selection.
- Independent Routines with their own tasks and daily completion.
- Daily drafts, project/routine grouping, inline task creation and explicit submit.
- OKR tree with objective/child creation and a read-only schedule view.
- Workspace switching, five languages, six themes and bundled Pretendard.
- System-browser Google login with PKCE and secure native token storage.
- Native Apple sign-in, enabled only after server credentials are configured.
- Recent-auth account deletion with an atomic guard against deleting shared teams.

## Local verification

Use Node 24. Install both repository and mobile dependencies with `npm ci`.
Run these commands from `mobile`:

```sh
npm run typecheck
npm test
npx expo-doctor
npx expo export --platform all --max-workers 1
npm run preview:export
npm run preview:serve
```

The preview at `http://127.0.0.1:3199` is a React Native Web rendering with fictional
data and intercepted writes. It cannot contact the production API. Parameters:
`?lang=ko&theme=dark`, or `?login&lang=en`. It is not an APK, IPA or store screenshot.
Use `node ../node_modules/@playwright/test/cli.js test --config playwright.config.mjs`
for single-worker browser checks. Install the root Playwright Chromium browser first.

## Release sequence

1. Authenticate Expo/EAS and select the actual Apple/Google developer organizations.
2. Confirm `ai.okri.app` in both stores. Link the real EAS project using `eas init`.
   Supply `EXPO_OWNER` and `EXPO_PUBLIC_EAS_PROJECT_ID` to the build environment.
3. Review and deploy the backend with migration `0054_native_sessions.sql` before
   enabling native login. Keep SQL LF and existing guards intact.
4. Configure server secrets `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`
   and `APPLE_BUNDLE_ID=ai.okri.app`; reuse the existing token encryption key.
   Keys belong in the server secret store, never `EXPO_PUBLIC_*`, Git or chat.
5. Build preview APK and iOS simulator/device artifacts using `eas.json` profiles.
   Windows can generate Android sources but cannot generate/compile this iOS app.
   EAS/macOS must compile iOS and validate entitlements/privacy manifests.
6. Test real Google and Apple auth, cancel/back, cold launch, session expiry,
   airplane mode, 200% system text, VoiceOver/TalkBack, keyboard, notch/safe areas,
   workspace isolation, editor roles and form submission on both platforms.
   Account deletion tests must use a designated non-production account/database.
7. Review dependency advisories, privacy/data-safety declarations and legal copy.
   Record real device checks in `release/device-verification.json` using the schema
   below. Do not mark browser-preview checks as device checks.
8. Build signed production AAB/IPA, then submit to Play internal testing/TestFlight.
   A first Play upload may require Console upload before automated submissions.
   Complete store metadata, reviewer access, age rating and export declarations.
9. Verify accepted processing, testing eligibility and store review status before
   claiming publication. An EAS upload is not a public store release.

```json
{
  "iosBuildId": "actual EAS build ID",
  "androidBuildId": "actual EAS build ID",
  "googleLogin": true,
  "appleLogin": true,
  "dailySubmission": true,
  "workspaceIsolation": true,
  "accountDeletion": true,
  "systemText200Percent": true,
  "screenReader": true,
  "privacyDeclarationsReviewed": true,
  "dependencyAdvisoriesReviewed": true
}
```

No payment purchase UI, advertising, analytics SDK or new push delivery is included
in this first native companion. Existing server-side bot behavior is reused when
the user explicitly submits. Website-only advanced property/document editing and
integration administration have not been ported into this first native client.

## Data safety and deletion review

The app transmits account identity and user-authored team work over TLS to OKRI.
The token is stored in Keychain/Keystore via SecureStore, not AsyncStorage. Only
language and theme are saved in ordinary local preferences. Shared work remains
with the team after account deletion; solo-owned workspaces are permanently
removed. Owned shared workspaces require ownership transfer first. Inactive
membership records and authored team history may remain as business records.
Invoice/trial-prevention records and existing backups follow the service retention
policy; review that policy and the store deletion web URL before submission.

2026-09-07 dependency review: `npm audit --omit=dev` reports no high/critical
advisories but 19 moderate dependency entries, arising from two roots:
`decode-uri-component` through navigation/query-string and `uuid` through Xcode
build tools. Navigation linking is not enabled; auth URLs use the platform URL
parser. Do not apply npm's suggested major framework downgrades blindly. Review
upstream patches before the release candidate and record the outcome.

## Current evidence

- Mobile/root TypeScript and root web build pass.
- Expo Doctor: 21/21 checks pass.
- Android/iOS Hermes and web JavaScript exports succeed.
- Android native release APK builds successfully from the generated project; the
  emulator install and cold launch were verified with package `ai.okri.app`.
- The verification APK uses the Android debug keystore and is not a Play Store
  upload artifact. It must be rebuilt with an EAS production signing key before
  internal testing or public release.
- Native auth/model/API/localization unit tests pass; existing daily, language,
  migration and workspace regression suites were checked.
- Mocked browser flow and five-language/six-theme layout checks pass.
- No production-signed AAB/IPA, physical-device verification or store submission yet.
- Backend changes are isolated on `codex/native-mobile`, not publicly deployed.

References: [Expo monorepos](https://docs.expo.dev/build-reference/build-with-monorepos/),
[Play submission](https://docs.expo.dev/submit/android/),
[App Store review guidelines](https://developer.apple.com/app-store/review/guidelines/).
