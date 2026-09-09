# Workspace visual alignment

The signed-in experience follows the accepted landing's typography, spacing,
neutral surfaces and quiet separators. `app/workspace-design.css` is imported
after the existing base styles. Theme tokens, routes, permissions, authentication,
CRUD, hierarchy, Routines and integration behavior remain unchanged.

The layer covers navigation, headers, My Work, Project views, Task details,
Routines, daily work, data connections, recommendations, conversation, settings,
integrations and Project review.
Document sections are unframed; repeated records and dialogs keep their boundaries.
Conversation foreground and background roles remain paired in all six themes.
The existing global action-state rules still control hover, focus and disabled
colors. The public landing is not restyled.

## Local preview

Run the normal application on port 3187, then from the project directory:

```powershell
node scripts/design-preview.mjs
```

Open `http://localhost:3188/?view=my_work`. This is a fictional, read-only visual
preview, not a logged-in production session. API reads use the same test fixtures
as the landing images. All non-GET requests and API WebSocket upgrades are blocked.
No API request is forwarded to the application or external services. The helper
binds only to localhost, refuses production mode, and is not part of the app build.

## Verification

Use one browser worker with local API mocks:

```powershell
$env:OKRI_E2E_BASE_URL = 'http://localhost:3187'
npx playwright test tests/e2e/workspace-design.spec.ts tests/e2e/design-balance.spec.ts --project=desktop-chromium --workers=1
npx playwright test tests/e2e/themes.spec.ts --project=desktop-chromium --workers=1
npx playwright test tests/e2e/landing.spec.ts --project=desktop-chromium --workers=1
npx tsc --noEmit --incremental false
npm run lint
npm test
```

Regenerate the fictional product captures using `docs/LANDING.md` after visual
changes. Inspect screenshots as well as layout assertions. No production writes,
integration messages, migrations or tracking are required.

Validated on 2026-09-03: production build and 160 Node tests, full lint and type
checks; 29 workspace/theme/capture tests, 10 landing tests, two desktop density
checks and four mobile touch checks passed with one worker. The three skipped
density cases belong to other viewport profiles. Actual Pretendard glyphs,
320-3840px layouts, 200% text and all six palettes were checked. The read-only
proxy rendered My Work without runtime errors and rejected all four write verbs.

## Integration

### Landing-to-workspace alignment (2026-09-09)

The native landing example is the visual reference for reading OKRs: one quiet
Objective icon, a KR rail, a 14px role label, a regular 16px title, and separate
14px metric labels with 18px tabular values. Keep the reading measure at 44rem;
do not spread related values across the full workspace. The live KR shows its
stored progress and Initiative count, not inferred current/target metric values.
Disclosure, project-detail navigation and keyboard operation remain unchanged.
Initiatives retain their themed rail without repeating a letter badge beside
the role label. Child Project and Task rows use indentation, not nested frames.

Project tables use row separators without vertical cell rules. Project cards
use one top separator and open metric groups. Connected KR data uses the same
rail and label/value rhythm. Retain visible boundaries on editable controls and
the shared semantic palette; removing passive frames is not a reason to lower
control contrast. Project context sections keep a valid shared inset and a
transparent surface. Body and secondary text do not shrink on mobile.

Check `landing-alignment.spec.ts`, `design-system.spec.ts`,
`workspace-design.spec.ts` and `item-editor.spec.ts` with one worker and mocked
API writes before publishing.

This follows landing commit `b0adfb7` in the isolated `.sites-landing` checkout,
on `codex/design-unification`. Preserve other tasks' API/default-property/daily-bot
changes during later integration. Do not copy the unrelated shared dirty checkout.
Before publication, apply these visual changes to the latest deployed source;
deploying this older baseline directly would roll back intervening bot releases.
Public deployment remains gated on explicit approval and coordination.
