# Pi OpenAI Codex Profiles

Keep separate `personal` and `work` OpenAI Codex OAuth credentials in Pi. Use work quota first in SIBP repositories and personal quota everywhere else. Requires host Pi 1.5.2's native provider and virtual-model APIs.

## Install

Install the Git-backed Pi package:

```bash
pi install git:github.com/barlevalon/pi-openai-codex-profiles
```

Pi provides the runtime dependencies; no separate npm install or build is needed. The package declaration is saved in `~/.pi/agent/settings.json`, so sharing that file shares the installation source, not a source checkout or credentials.

To use the same version on several machines, append `@<commit-or-tag>` to the source. Pi keeps pinned installations on that ref.

If migrating from the old manual clone, move `~/.pi/agent/extensions/openai-codex-profiles` outside Pi's extensions directory before restarting or running `/reload`. Keep the old checkout as a backup until the package works. Do not load both copies.

Restart Pi or run `/reload` after installation.

## Update

For an unpinned installation:

```bash
pi update git:github.com/barlevalon/pi-openai-codex-profiles
```

For a pinned installation, change the ref in the package declaration to adopt another commit or tag.

## Use

```text
/login openai-codex:personal
/login openai-codex:work

/model openai-codex:personal/gpt-6.1-sol
```

Pi stores each login under its existing provider ID in `~/.pi/agent/auth.json`. Native OAuth login and refresh remain in use. The original `openai-codex` provider and credential remain unchanged.

Selecting either Codex alias normalizes the session selection to `codex-policy/<requested-model-id>` before the first request. Every bundled Codex ID is available. Model ID and thinking level stay selected. Assistant messages record the physical account that answered, not `codex-policy`. Existing defaults and Poteto role mappings need no edits.

### Repository policy

A repository qualifies for work Codex through either of these checks:

- Its local origin is an exact `github.com/sibp/<repo>` HTTPS or Git SSH URL. Multiple origin URLs do not qualify through origin.
- Its canonical checkout is beneath `~/repos/sibp`. Linked worktrees outside that directory also qualify when their primary checkout is beneath it.

The nearest actual Git repository owns the decision. A directory prefix alone, a symlink into an unrelated repository, or repository-redirection environment variables cannot qualify a location. Routing uses Pi's current `ctx.cwd`, not a shell tool's working directory.

Qualifying repositories use work, then personal after confirmed work quota exhaustion. Both profile logins are required. Missing or broken work authentication is a setup error, not quota exhaustion. All other, nonrepository, and unknown locations use personal only, including explicit work selections. Work OAuth refresh and auth derivation also check scope. Direct low-level work calls outside scope fail instead of redirecting.

### Review policy

```text
/login github-copilot
/model profile-review/claude-opus-5.5
```

This dedicated selection tries exactly `github-copilot/claude-opus-5.5`. Confirmed Copilot quota exhaustion falls back to exactly `gpt-6.1-sol` under the repository account policy. It advertises the intersection of the models' thinking and input capabilities and their smaller limits. A notice reports reduced review diversity when Codex answers. JSON and print-mode final answers also carry the notice, so Poteto receives it in the review result.

Ordinary `github-copilot` selections do not change. The review provider accepts provider-neutral `streamSimple` calls and rejects API-specific `stream` calls. This package does not change Poteto's configured review models or substitute other model families.

### Quota and stream rules

Codex quota requires structured `usage_limit_reached` in an error's code or type. Copilot quota requires HTTP 402 with `error.code` equal to `quota_exceeded`. The Copilot fixtures come from [Pi issue 3643](https://github.com/earendil-works/pi/issues/3643) and [GitHub community discussion 197813](https://github.com/orgs/community/discussions/197813). Those responses prove a provider-reported quota block, not the accuracy of a billing balance.

A generic 429, authentication failure, network error, context error, or English quota message does not authorize fallback. Error-body inspection is limited to 16 KiB and one second, and respects caller cancellation. Each target in the fixed plan is attempted at most once. Failed attempts remain hidden only before content or usage commits the stream. Text, thinking, tool calls, usage, caller aborts, callback failures, and malformed streams prevent replay. Empty success remains success. Caller transport and semantic options stay intact. Account switches resolve native target auth again and discard the source key, headers, and environment.

Confirmed quota observations live beneath `getAgentDir()/codex-routing`. Each observation is an independent, atomically renamed file with mode `0600` in a directory created with mode `0700`. Processes merge the maximum reset for each quota key. Only version, quota key, and reset timestamp are stored. Codex epoch-second `resets_at` and HTTP `Retry-After` seconds or dates determine resets. Missing or invalid resets use a 15-minute retry cooldown.

Unreadable work state disables work. Unreadable Copilot state fails the review request unless an active in-process observation already blocks Copilot. Persistence failures retain the in-process cooldown and warn that it cannot be shared. Requests already in flight can precede another process's quota observation. More than 4,096 observation files fails closed. Observations are not automatically deleted.

This extension is an account-routing policy, not a sandbox. `--no-extensions` bypasses it. Other extensions and the unchanged builtin provider are outside its enforcement.

## Test

With Node.js 22.19 or later and host Pi 1.5.2 on PATH, run `npm test`. Tests install the package into a temporary Pi profile, create real Git fixtures, and merge cooldown observations from independent processes.

Host Pi tests use temporary `PI_CODING_AGENT_DIR` profiles with fake credentials, `--offline --no-mcp --no-context-files`, per-request response fixtures, and a loopback HTTP server. They cover alias normalization before auth, target credentials and attribution, quota fallback with retries disabled, explicit native retries, partial streams, aborts, review routing, child-shaped processes, and native compaction. No saved credentials or upstream model endpoints are used.

Set `PI_PACKAGE_TEST_SOURCE` to a Git source to check an installed revision instead of the local directory.
