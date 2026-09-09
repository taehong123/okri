# OKRI design and theme contract

## First-login setup

- `app/first-run-setup.tsx` uses the existing dialog, Pretendard and semantic
  typography/field/focus roles. One conversational question is shown at a time:
  personal/team, workspace, Objective, KR, optional Initiative, review, feature guide.
- Examples are placeholders, never persisted sample data. The final review
  contains the user's answers; edits clear its confirmation checkbox.
- `app/first-run-setup.css` is a focused form surface, not another theme.
  No viewport font scaling, decorative banner, nested cards or new palette.
- Close saves and pauses while preserving the underlying business route.
  Existing accounts and invitation/OAuth/detail links are not intercepted.
- Drafts belong to the account, not browser storage. New accounts opt in during
  registration; legacy NULL values never automatically start setup.
- `tests/onboarding.test.mjs` covers migration, atomic writes, access, conflict
  and retries. `tests/e2e/onboarding.spec.ts` verifies personal/team/resume/viewer,
  response-loss and responsive flows with mocked writes.

## Design source and structure preservation

The upstream design source is [ALLVIBE Design v1.0.0](https://github.com/all-vibe/all-vibe-agent-toolkit/blob/4f927714f728abcbe8920a3c39aad49692758c46/plugins/all-vibe-design/skills/all-vibe-design/SKILL.md), shared by 조성배 on 2026-08-24.
Read its foundations, application-design, interaction-accessibility, content-design
and service-profiles references before substantial UI work. This document records
OKRI-specific clarifications, not a replacement design system.

- Preserve navigation order, default destination, URL contracts, tab grouping,
  object hierarchy, view modes and create/edit flows. Styling is not permission
  to move features or rewrite their behavior.
- White is monochrome: white canvas, ink-black actions/links/focus, cool neutral
  separators. Keep semantic status colors and external brand marks intact.
- Existing explicit themes remain available and saved preferences win.
- Korean, Latin and numerals use the same self-hosted Pretendard Variable 1.3.9
  family through `--font-ui`. The 92 official Unicode-range subsets load only
  when their glyphs are visible; do not preload the entire font or add a CDN.
- Typography comes from `--type-body` (1rem), `--type-label` (.875rem),
  `--type-meta` (.8125rem), `--type-section` (1.125rem), `--type-page` (1.5rem).
  The root respects browser defaults (100%) at every viewport width.
  Do not add per-screen pixel font patches, CSS zoom or scale transforms.
- Korean body line height is 1.6; headings start at 1.25. Letter spacing is zero.
  Titles wrap instead of losing essential content. Rows expand with their content.
- Desktop density is deliberately quieter: controls 36px, editable fields 40px,
  and rows at least 48px. At 980px and below, or with a coarse pointer, controls
  and fields are at least 44px and rows at least 52px. All dimensions use rem.
  This is the user's balance correction, not a font-size reduction: body and
  inputs remain 16px. Never enlarge desktop density at 1800px or any wider size.
  Deletion selection retains an 18px square inside a 44px unframed hit area;
  completion has a circular indicator. Long content must increase row height.
- Radii: controls 8px, containers 10px, overlays 14px. Prefer quiet borders over
  shadows or nested tinted panels. Remove redundant eyebrow copy, not useful help.
- Spacing uses the 4/8/12/16/24/32px scale (`--space-*`). Desktop page insets are
  32px, mobile insets 16px. Page top spacing is 24px and heading-to-content spacing
  is 16px. The page heading and document share a left edge.
  Tree indentation is 32px on desktop and 16px on mobile. Sibling titles,
  counts and percentages share fixed grid tracks; labels must not split mid-word.
- The OKR read surface is an unframed document, not a card inside another card.
  Child Projects use dividers, not nested boxes. Root titles have section-sized
  text, execution rows body-sized text, and metadata regular medium-weight text.
- The OKR page header contains only its title and list action. Start the document
  at the Objective, with a quiet edit icon for writers; keep file metadata in the
  list/editor and Project/Task navigation in the hierarchy, not a duplicate banner.
- Project item titles use regular weight (400) in cards, tables, boards, My Work
  and the OKR tree. Preserve their size, placement and the separate emphasis of
  page/section headings; do not make the entire item bold to distinguish its type.
- New layout/typography tests cover 320, 390, 768, 1440, 1920, 2560 and 3840 CSS px,
  larger user text, unchanged navigation, long Korean titles and overlay stacking.
- Run browser verification with one worker. Test writes use local mocks only;
  never create production QA workspaces, records or Slack messages.

## Theme color contract

Use the unmodified sRGB scales in [Radix Colors 3.0.0](https://www.radix-ui.com/colors/docs/palette-composition/composing-a-palette).
Their [role-based steps](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale)
are the source for backgrounds, separators, interactive borders and text.
`lib/themes.ts` includes the exact upstream scale data and maps roles once.
Stronger text steps are selected when necessary to meet 4.5:1 WCAG contrast.

| Theme | Neutral | KR and main accent | Initiative |
| --- | --- | --- | --- |
| White | Gray | Ink / Gray | Gray |
| Beige | Sand | Gold | Teal |
| Gray | Slate | Teal | Violet |
| Dark | Gray Dark | Blue Dark | Violet Dark |
| Neon | Slate Dark | Cyan Dark | Violet Dark |
| Cyberpunk | Mauve Dark | Pink Dark | Cyan Dark |

Bright accents belong on controls, rails and badges, not large tinted panels.
Status colors retain their meaning independently of the hierarchy palette.
White navigation uses the same white canvas as the page, including the loading
sidebar, mobile navigation and settings navigation. Hover and selection use
neutral Gray steps. Generic guidance, default avatars, empty-state icons and
setup steps use text/icon/surface roles, never the blue information-status role.
White Initiative labels and rails are neutral Gray as well. Keep informational
alerts, workflow statuses, user-chosen group colors and external brands distinct;
do not desaturate them or replace a user's saved theme.
Upstream licenses are retained with the font assets and in
`public/RADIX-COLORS-LICENSE.txt`. Font reference:
[Pretendard variable subsets](https://github.com/orioncactus/pretendard#%EA%B0%80%EB%B3%80-%EB%8B%A4%EC%9D%B4%EB%82%98%EB%AF%B9-%EC%84%9C%EB%B8%8C%EC%85%8B).

`lib/themes.ts` is the single source for theme IDs, labels, brightness, defaults,
previews and semantic colors. White is the fallback; a valid saved `okri.theme`
always wins. `app/layout.tsx` applies the generated palette and preference before
the first body paint. The client and BlockNote consume the same registry.

## Component rules

`app/workspace-design.css`, imported after the base stylesheet, aligns signed-in
surfaces with the landing's document layout. It does not own theme values or
application behavior. Page content is capped at 75rem, with the existing 32/16px
insets and 24px top / 16px heading spacing. Body descriptions use the body role;
regularly scanned secondary values use the label role rather than metadata.
Project tabs use an underline, while the workspace, conversation and settings
sections remain unframed. Repeated items and actual dialogs retain their frames.
Mobile navigation grows with its labels, and content retains bottom clearance.
Do not apply desktop sidebar padding or navigation margins to the mobile bar.

- Surface text uses `text-primary`, `text-secondary` or `text-tertiary` on the
  corresponding `bg-*` surface. Links and icons have their own tokens.
- Actions use **paired** `button-{role}-bg` and `button-{role}-fg` tokens, never
  `ink`, `raised`, hardcoded white, or an unrelated accent as a substitute.
- Use the existing `primary-action`, `secondary`/`cancel` and `icon-button`
  classes. Existing component-specific action selectors are mapped together
  in the shared action-state section of `app/globals.css`.
- When adding an action selector, map its role once; the nested hover/active
  rules must apply to it too. Destructive filled actions use the danger pair.
- Disabled colors are explicit, not opacity. `disabled` and `aria-disabled`
  controls use the common disabled pair, including nested labels and icons.
  Busy controls retain that readable pair and expose `aria-busy` where needed.
- Do not animate foreground/background/opacity between enabled and disabled
  button states: individually valid endpoints can have unreadable intermediate
  colors. Border/shadow motion remains allowed.
- Semantic messages/badges use a matching `{status}-fg` / `{status}-bg` pair.
  Small status dots use the foreground token, not the pale badge background.
- Focus uses `focus-ring`. A subtle separator is not a control outline;
  identifiable controls use `border-control`.
- KR/Initiative backgrounds stay neutral. Their badges and rails use matching
  theme accent roles, not a shared light/dark brown or gray-green palette.
  All progress bars and range controls use `progress-fill` / `progress-track`;
  percentage labels use `progress-text`. Cyberpunk alone adds a small static
  selection glow.
- BlockNote menu/editor variables follow the active palette, but user-authored
  text/highlight colors and external brand marks must remain untouched.
- New component colors must not be literal hex/RGB values in `globals.css`.
  Add roles to the registry and contrast tests instead of theme-specific patches.

## Regression checks

- `tests/e2e/workspace-design.spec.ts`: ten working views across seven widths,
  actual Korean/Latin/numeral fonts, long titles, 200% user text, unclipped mobile
  navigation, settings header separation and keyboard close, and six-theme
  conversation contrast. All application requests use fictional fixtures.
### Create and edit surfaces

Detail views are read-first documents. Project, Task and Routine properties use
`DocumentProperties`: a compact summary, a collapsed read-only definition list,
and a separate `변경` dialog for existing edit controls. Opening or expanding a
document must not write data. Saved values, custom property names, hide/restore
behavior, permissions and Routine draft/discard confirmation remain intact.
`app/document-view.css` shares this layout after the existing field styles.
Project content uses one column; the recent-update feed remains visible, while
bot enable controls and template tools stay out of the default reading surface.
Titles are headings, not permanent input fields. Completion stays a direct work
action. The `document-view.spec.ts` checks read/edit separation, nested-dialog
focus, Viewer access, six themes, actual fonts and 320–3840px/200% layouts.

Document edit mode uses the existing BlockNote controls in a small, wrapping
formatting row. Template actions share the Change button's height, typography
and semantic action states; do not stretch the final action across mobile rows.
Reading mode has no toolbar. Autosave must preserve cursor and undo history;
replace the editor only when explicitly applying a template, not after saving.
Project, Task and custom Routine images use authenticated, workspace-scoped R2
objects. Accept only verified PNG/JPEG/WebP/GIF up to 5 MB, with bounded reads,
no public image caching and server-side target/role checks. Image bytes never
belong in document JSON or browser storage. `document-editor.spec.ts` and
`document-images.test.mjs` cover persistence, failures, permissions and layout.

`app/item-editor.css` is the shared field/layout layer loaded after `globals.css`
and `workspace-design.css`.
Project creation, Project detail, property definitions, templates, Task detail,
Routine fields and the OKR editor use the same label, field and focus tokens.
Do not add another page-specific input palette or density override.

- Project create/edit custom values use `PropertyValueInput`; the caller retains
  responsibility for draft state, typed persistence and write permissions.
- Hide controls occupy a separate column, never absolute positions over fields.
  Hiding preserves values; read-only controls must remain visibly non-editable.
- Use `--field-height`, `--space-*` and container-fitting grid tracks. Long
  titles and labels grow vertically, including at 200% user text size.
- Project detail keeps properties, linked Task navigation and the document.
  Sections share an inset; the Task table owns its horizontal scroll region.
- `tests/e2e/item-editor.spec.ts` checks create/edit parity, typed value and member
  preservation, hide/restore, Viewer controls, six palettes, actual font glyphs,
  keyboard operation and 320 through 3840px layouts with larger user text.

- `tests/e2e/design-balance.spec.ts`: desktop density stays stable through 4K;
  editable values and mobile touch targets retain their size, search/date values
  fit their columns, and selection/completion hit areas stay separate with larger
  user text.
- `tests/themes.test.mjs`: all palettes are complete, references resolve, text
  and button contrast is at least 4.5:1; controls, rails and disabled labels are
  at least 3:1. First-paint restoration handles invalid/blocked storage.
- `tests/e2e/themes.spec.ts`: every palette across the real screens and dialogs,
  editor/slash menus, keyboard theme selection, reload persistence, contrast,
  overflow and runtime errors. Buttons are checked at rest, hover, active,
  focus, disabled/busy and frame-by-frame when enabled.
- Axe contrast violations fail regardless of severity. Do not disable or filter
  them to accommodate a palette.
- Verify actual Korean/Latin glyph rendering through browser font diagnostics,
  not just a computed font-family declaration. Fonts must load from this site's
  own origin, and subsets not needed by the page must remain unloaded.
- Test projects cover 320px, 390px, 1440px and 3840px viewports. Theme previews
  are two columns on small screens and three where space permits.

References: [VS Code role-based theme colors](https://code.visualstudio.com/api/references/theme-color#button-control),
[Dark Modern palette](https://github.com/microsoft/vscode/blob/main/extensions/theme-defaults/themes/dark_modern.json),
[WCAG text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).

## Workspace navigation and search

- The closed workspace selector shows its avatar and name; the open switcher
  retains personal/team type, role and current selection. The adjacent settings
  gear, existing menu order and home destination remain unchanged.
- The top bar uses a compact home action and workspace-scoped search instead of
  a duplicate brand/page breadcrumb. Search reuses the native overlay dialog and
  shared typography, input, action, focus and surface tokens.
- Search is an unframed grouped list inside one dialog, not nested cards. Work
  titles are regular weight; type, parent, assignee and due date are secondary.
  Filters scroll horizontally on phones so larger user text does not push the
  result actions out of reach. No viewport-based font scaling is introduced.
- `search=1` represents the temporary search overlay; result navigation retains
  its history entry. `cycle` and `focus` identify an OKR file and the item to
  reveal. Closing search leaves the underlying view and drafts intact.
- Recent queries and opaque work references are session-local and keyed by both
  user and workspace. Their titles and permissions are revalidated on the server;
  authenticated search responses must remain `private, no-store`.
- `tests/workspace-search.test.mjs` checks full-database search, scope, paging,
  filtering and trash exclusion. `tests/e2e/workspace-search.spec.ts` covers
  keyboard/history/draft behavior, all five languages, six real themes, actual
  fonts, 320–3840px layouts and short phones with 200% user text.

## Gantt schedule

- `?view=gantt` is a workspace-level read view for Projects and their direct
  Tasks. Project rows expose status, responsible member, progress and due date;
  expanded Task rows expose their own due-date milestones.
- Scheduling remains due-date only. A Project bar represents the interval from
  today to its due date, or from an overdue due date to today. It must never imply
  that creation time, task completion or an inferred date is a planned start.
- The Project label column stays visible while the date region scrolls. Mobile
  and larger text keep 44px controls and scroll only the timeline, never the page.
- Overdue, complete and current-day states use semantic labels plus theme roles;
  color alone is not sufficient. All five languages and six themes remain usable.

## Global language typography

### Slack management forms

- Management reports use Slack-native sections and input modals, not a web
  banner or a custom visual theme. Keep one actionable row per work item,
  urgency first, titles regular weight, and Task parent context secondary.
- `정보 입력·수정` edits due date, accountable member, state and priority;
  Project custom properties retain their workspace names, types and options.
  Task forms link to their parent Project's properties instead of inventing
  another Task property model. Unknown/missing values are not auto-filled.
- Use native labelled date pickers and searchable member/option selectors.
  Preserve typed values on errors and present only safe recovery instructions.
  Five-language payload/limit tests use mocked Slack writes; no production
  messages are sent for layout testing. Slack controls its own fonts and scale.

### Web language typography

The interface supports Korean, English, Japanese, Simplified Chinese and
Spanish without changing the layout scale or the theme palette. Korean, Latin
and numeral glyphs always remain on the self-hosted Pretendard family. Japanese
and Simplified Chinese may use an installed system CJK family only for their
own Unicode ranges; do not add a font CDN, location request or viewport-based
font-size override.

- Set the active document language on `html` (`zh-Hans` for Simplified Chinese)
  so assistive technology and the scoped CJK fallback use the same language.
- Long translations wrap and grow their existing row or field. Never reduce
  font size, apply nonzero letter spacing, hide an existing action, or move it
  to another menu to make a translation fit.
- System labels use the typed message catalogs. User-authored titles, text,
  property names, option values, templates and custom bot messages are not
  translated. A renamed default property is user-authored from that point on.
- Language changes must preserve the current view, scroll, selection, drafts,
  editor history and theme. They must not invalidate or refetch business data.
- Browser checks cover all five languages at 320, 390, 1440 and 3840px, 200%
  text zoom, keyboard operation, all six themes and actual rendered glyphs.

## Public OKR guide

- `/guide` explains Objective, Key Result, Initiative, Project and Task with a
  local fictional example. Keep KR metrics separate from task completion, and
  distinguish the Project lead's accountability from the Task assignee's work.
- Draw the tree in native HTML/CSS with nested lists, not raster screenshots.
  Individual nodes may be framed; descendant lists stay outside those frames.
  Use the existing hierarchy roles and shared fonts, sizes and semantic colors.
- The root branches into two columns only when its container has enough space.
  Narrow screens and larger user text use a vertical tree with bounded indents.
  Expand/collapse controls remain keyboard accessible with 44px targets.
- Share links contain only the guide language. A typed goal stays in same-tab
  session storage for two hours, then is offered in the existing AI conversation.
  Adding it requires an explicit click after draft hydration, preserves the
  existing message, and must never automatically call AI or create work.
- `tests/guide.test.mjs` checks all five catalogs, example topology and draft
  bounds/expiry. `tests/e2e/guide.spec.ts` uses mocked APIs for guest/auth handoff,
  keyboard access, all themes, font diagnostics and 320–3840px text-zoom layouts.
