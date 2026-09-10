# OKRI Local Agent

OKRI Local Agent lets an authorized user send a Task or Project from OKRI to the Codex CLI already signed in on that user's computer. The browser and OKRI server never receive the Codex login, OpenAI API key, local folder path, or Codex thread ID.

## Connection flow

1. Open a Task or Project and select **Codex에 맡기기**.
2. Download `okri-local-agent.mjs`, enter the repository path, and create a one-time connection code.
3. Run the displayed command in a terminal. The code expires after 10 minutes and succeeds only once.
4. Keep the runner open while sending jobs. Closing it makes the device appear offline.

The MVP requires Node.js 22 or later and an installed, signed-in Codex CLI. The device token stays in process memory. Restarting the runner therefore requires a new one-time code; a later packaged desktop release can use the operating system credential store.

## Security model

- The runner makes outbound HTTPS requests. OKRI opens no inbound port or tunnel to the user's computer.
- The server stores only a SHA-256 token hash, a short prefix, device metadata, item context, instructions, and redacted results.
- Every poll revalidates the device, active workspace membership, user, workspace, and revocation status.
- Jobs are leased to one device. Expired leases can be retried, and duplicate terminal reports are idempotent.
- Codex runs with `approvalPolicy: never`, workspace-only read/write access, no network, no dynamic tools, and no configured MCP servers.
- Secret-looking environment variables are removed before Codex starts. Common API keys, bearer tokens, passwords, and secrets are redacted before server storage.
- Item descriptions are untrusted context, not executable instructions. The runner denies approval and interactive tool requests.
- Revoking a device invalidates future polls and cancels its queued jobs.

This boundary prevents unattended deployment, external network access, credential reads outside the selected workspace, and cross-workspace job pickup. Users should still review repository changes before committing or publishing them.
