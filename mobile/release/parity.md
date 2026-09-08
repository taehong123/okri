# Native parity ledger

## 1.0.0 candidate (not publicly released)

- Shared: themes, five languages, authorized OKR/Project/Task/Routine data.
- Native: Today, Projects, hierarchy tree, detail/edit/create, personal Daily,
  read-only Gantt, workspace selection, settings, Google/Apple auth and deletion.
- Web-only for this first release: property/document editing, administration,
  integration configuration and billing. Existing web links remain available
  where appropriate; do not add payment steering without store-policy review.
- This policy change: native v1 transport, current-member mapping, release status,
  isolated preview, runtime fingerprint and store/optional-signed-OTA release lanes.
- Re-run physical iOS/Android validation. Previous APK predates these changes.
- Integrated web/Slack work status (916d46c): v1 preserves remote status and
  translates skip to the existing skipReason contract; selecting work can resume
  without discarding Tasks. Native office/remote controls are explicitly deferred
  to the next native UI release and are not claimed in this candidate.
- Native schema repair 0056 retains 0054 unchanged and covers environments that
  already applied 0055 before native authentication was deployed.

For every later product request, record web implementation and one explicit native
disposition: shared next bundle, native implemented, web-only with rationale, or
deferred with a target store release. The candidate report is input to this review,
not evidence that a web feature magically exists in React Native.
