# OKRI self-hosted deployment

## Target state

The production path is intentionally independent of the ChatGPT/Sites account:

```text
developer checkout -> github.com/taehong123/okri (main) -> allvibe-server timer
-> container image -> K3s OKRI service -> okri.ai after verified cutover
```

The server timer polls `main` every minute. It builds only a new commit, pushes
an immutable commit-tagged image plus `main` to the existing private registry,
rolls out the exact immutable tag, and stores the deployed commit in
`/var/lib/okri/release-sha`. No ChatGPT account, Sites project or browser login
is on this delivery path.

`deploy/selfhost/` contains the installed systemd service and timer. The
dedicated clone is `/srv/okri/source`; it is safe for the service to reset to
GitHub because it is not a human working directory.

## Safety boundary

Do **not** delete, detach, disable, or redirect the current Sites deployment
yet. It currently owns the live D1 database and R2 objects. The self-hosted
deployment starts with no public ingress, so an empty database can never take
`okri.ai` traffic by accident.

The production ingress template is deliberately excluded from Kustomize. It is
applied only in the cutover window after all checks below pass.

## Runtime secret handoff

Create/update the Kubernetes `okri/okri-runtime` secret from a secret manager,
not from Git files or chat. Preserve the **exact existing values** for every
currently configured variable, especially:

- Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_TOKEN_ENCRYPTION_KEY`, `GOOGLE_OAUTH_REDIRECT_URI`
- Slack: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`,
  `SLACK_TOKEN_ENCRYPTION_KEY`, `SLACK_OAUTH_REDIRECT_URI`
- Account/session and integrations: `ACCOUNT_DATA_ENCRYPTION_KEY`,
  `OKRI_API_TOKEN`, `OPENAI_API_KEY`, `RESEND_API_KEY`, Twilio variables
- Billing: all configured `PAYPAL_*`, `PAYPLE_*`, `INTERNAL_BILLING_SECRET`,
  `EMAIL_UNSUBSCRIBE_SECRET`, `BILLING_*`
- Product URLs and limits: `OKRI_PUBLIC_URL=https://okri.ai`,
  `OKRI_APP_URL=https://okri.ai`, existing `OKRI_AI_*` limits/models

Add a new random `OKRI_SCHEDULER_TOKEN`; it protects the internal scheduler
route. The deployment bootstrap makes an initial token only for isolated health
testing. Replace it when copying the production secret set.

Do not rotate Google, Slack or encryption keys during this move. Existing
database rows contain values encrypted with those keys, and OAuth redirect URLs
continue to be `https://okri.ai/...` after DNS cutover.

## D1 and R2 handoff from the current Sites owner

Ask the account that owns Sites project `appgprj_6a7fb5fa15408191a9d675676579fca5`
for these artifacts, placed in a private transfer location (never pasted into
chat):

1. A **data-only** D1 `DB` SQL export from one maintenance window. It must not
   contain `CREATE`, `ALTER` or `DROP` statements. Include the export SHA-256
   and row counts for `users`, `workspaces`, `workspace_members`, `items`,
   `routines`, `daily_submissions`, `slack_connections`, and `project_images`.
2. A complete `WORKSPACE_AVATARS` export. Store each object under
   `objects/<its-exact-R2-key>` and add `manifest.json`:

   ```json
   { "version": 1, "objects": [
     { "key": "project-images/v1/...", "contentType": "image/png",
       "customMetadata": { "ownerId": "..." }, "uploaded": "ISO-8601" }
   ] }
   ```

   Include the number of objects, total bytes, and a SHA-256 manifest. Preserve
   custom metadata; document-image access checks depend on it.
3. A secure transfer of the runtime secret values listed above into the target
   secret manager. Do not send values over Slack, GitHub issues or this chat.

The source account must leave its current deployment and domain route intact
until the final verification says to retire it.

## Import and verify

1. Stop writes briefly on the old deployment (maintenance/read-only mode and
   pause external Slack delivery). Export D1 and R2 at that same point.
2. Copy the artifacts onto the server under `/srv/okri/import`, owned by root;
   do not put them in `/srv/okri/source`. The required layout is
   `d1-data.sql`, `r2/manifest.json`, `r2/objects/<exact R2 key>`, and
   `runtime.env` (the preserved production variables plus a new
   `OKRI_SCHEDULER_TOKEN`).
3. Run the single-use importer below. It suspends scheduled writes, stops the
   application, creates an offline rollback copy, mounts the protected files
   read-only into a non-root Job, runs migrations then D1 then R2, atomically
   replaces the runtime secret, restores the application, and only then resumes
   the scheduler. It never writes handoff data or secrets into Git.

   ```bash
   sudo /srv/okri/source/deploy/selfhost/okri-import-production-state
   ```

   The importer rejects an existing user database, an invalid/missing R2
   object, duplicate R2 keys, and a missing scheduler token. A failed transfer
   leaves the old public route untouched and restores the isolated app; its
   pre-import copy stays under `/var/lib/okri/pre-import-...` for recovery.
4. Compare all supplied row counts, run `PRAGMA foreign_key_check`, verify a
   Workspace avatar, a project image/document image, Google sign-in, Slack
   signature handling, daily submission, and the frozen mobile v1 smoke suite.
   Use designated test accounts only; never send production Slack messages for
   this check.
5. Enable `ingress.production.yaml.template` (rename only after review), wait
   for a valid certificate, and change the Cloudflare origin for `okri.ai` to
   `61.72.248.246`. Keep the same public hostname. Validate web, Slack, OAuth,
   MCP and `/api/mobile/v1` before removing the old route.
6. Keep the previous deployment and a consistent local backup for rollback
   until post-cutover verification is complete. The self-hosted daily backup
   retains 30 snapshots under `/var/lib/okri/backups`.

## Exact request for the other account

Send this, unchanged if useful:

> OKRI를 ChatGPT Sites 의존 없이 자체 서버로 이전합니다. 현재 Sites 프로젝트
> `appgprj_6a7fb5fa15408191a9d675676579fca5`의 `DB`를 한 유지보수 시점 기준으로
> **data-only SQL**로 export하고, `WORKSPACE_AVATARS` R2의 모든 객체와
> content type/custom metadata를 manifest 포함해 private transfer 위치에 내보내 주세요.
> 각 테이블 row count와 SHA-256도 함께 남겨 주세요. 현재 runtime 환경변수 값은
> target secret manager로만 안전하게 전달해 주세요(채팅/깃에 값 금지). `okri.ai`의
> Sites route, custom domain, D1/R2 데이터는 최종 검증 완료 전까지 삭제·연결해제·DNS 변경하지 마세요.
