# OKRI development contract

Before changing UI, read `docs/THEMES.md` and the relevant component styles.
The document is an implementation contract, not optional inspiration.

- Preserve behavior, navigation, permissions, customer data and other services.
- Use the shared font, typography, spacing and semantic color tokens.
- Keep Korean, Latin and numerals on the self-hosted Pretendard family.
- Do not change text size by viewport width or add nonzero letter spacing.
- Do not invent component hex colors. Use the documented Radix palette roles.
- Hierarchy badges, rails and progress indicators must follow the chosen theme.
- Use an aligned, unframed layout for page sections; avoid nested visual cards.
- Before publishing, check actual rendered fonts, light/dark palette contrast,
  narrow/mobile and wide layouts, long titles, keyboard access and user text zoom.
- Run browser checks with one worker and mocked writes. Do not create test
  records or send integration messages in production.
- Coordinate with other OKRI tasks before changing shared files or deploying.
- Keep migration SQL as LF. Never weaken database guards to fix packaging.

## Installed mobile clients

Before API, auth, database, shared model or mobile release changes, read
`docs/MOBILE_RELEASE_POLICY.md`. This is an implementation contract.

- Web updates must preserve supported native clients. Native business traffic
  uses `/api/mobile/v1`; keep its frozen consumer fixtures and semantics.
- Run `npm run test:mobile-contract` and the normal build before any web deployment.
  Never bypass prebuild to ship a breaking API or a modified historical migration.
- Record native parity in `mobile/release/parity.md` for product requests. A web UI
  change does not automatically implement a native UI.
- Public app releases need current source-bound physical-device evidence. Do not
  fabricate IDs/checks or infer store availability from an upload.
- Use fingerprint runtimes and distinct channels. Never reload active forms,
  force an update because a policy fetch failed, or enable paid/signed OTA silently.
- Preserve the support window: 180 days after first successor, two newer fully
  available versions and 30 days' notice, independently on each platform.
