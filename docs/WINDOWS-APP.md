# OKRI desktop app

## Local Codex runner

The PWA and the local Codex runner are separate. Installing OKRI as a PWA does not start local code execution. A user explicitly downloads the runner from a Task or Project, creates a short-lived connection code, chooses a working folder, and starts it in a terminal.

The runner does not copy browser OAuth state, Codex credentials, API keys, or OKRI cookies. See `docs/local-agent.md` for its execution boundary and revocation model.

OKRI currently uses an installable PWA, not a native EXE, DMG, or embedded
WebView. Edge/Chrome/Safari can install it into a standalone window with the
existing Google browser authentication, cookies and workspace selection. The
browser owns the OS shortcut, installation confirmation and uninstall.
Do not add a second account store or copy OAuth tokens into desktop storage.

## Download route and installation

Login and app-menu entry points link to `/download`; they never start
installation or a file download by themselves. The route identifies Windows or
Mac, explains the browser-managed installation, and lets the user switch
platforms before acting.

Chromium exposes a real `beforeinstallprompt` event. Only the explicit final
install button consumes that one-use event and opens the browser-owned
confirmation. Safari users follow `File > Add to Dock`. The route links to
official browser guidance when an in-page prompt is unavailable. Dismissal does
not report success. Only `appinstalled` or standalone display mode reports an
installed state.

The manifest uses stable same-origin `/` identity and launch scope. Shortcuts
open existing My Work and OKR views; they do not pin an account
or team. Team address routing and OAuth remain the web application's concern.

## Build and update

- `predev` and `prebuild` generate `public/manifest.webmanifest` and
  `public/offline.html` from the shared theme registry and offline source.
- Existing SVG branding is rasterized into the versioned 192/512px PNG icons.
  `scripts/generate-app-icons.mjs` uses the existing sharp installation only when
  refreshing those icons; sharp is not needed by the normal app build/runtime.
- Build fingerprints include the offline document, static assets and worker
  source. An updated worker waits for existing app windows and site tabs to close. There is no
  forced reload or background polling loop.
- Root navigation always requests the server. Only hashed/public static assets
  and the fixed offline document enter Cache Storage. API responses, OAuth,
  invitations, workspace data and writes are never cached by the worker.
- Offline mode is a connection status screen, not offline editing. Retry keeps
  the original app URL. Offline fonts use only the needed Pretendard subsets.

## Verification

`npm test` includes manifest/icon, install-event, cache isolation, upgrade and
network/storage failure tests. `tests/e2e/pwa.spec.ts` validates real Chromium
manifest/installability, offline navigation and themed/responsive controls with
one browser worker and local API mocks. It does not install software on a user's
machine or create production records.

Packaged EXE/DMG files, store listings, code signing, native tray, push
notifications and background offline writes are not part of this PWA release.
