# Pi OpenAI Codex Profiles

Keep separate `personal` and `work` OpenAI Codex OAuth identities in Pi. A profile-local policy assigns provider accounts to personal or repository-restricted work membership. Each account keeps its native credential slot and independent quota history. Without a valid policy, only personal Codex is authorized. Managed Copilot is denied and no review model is advertised. Requires Pi 1.5.2's native provider and virtual-model APIs.

## Install and update

```bash
pi install git:github.com/barlevalon/pi-openai-codex-profiles
```

Pi supplies the runtime dependencies. No separate npm install or build is needed. Append `@<commit-or-tag>` to pin a version. For an unpinned installation, update with:

```bash
pi update git:github.com/barlevalon/pi-openai-codex-profiles
```

Restart Pi or run `/reload` after installation or policy changes. If migrating from a manual extension checkout, move the old copy outside Pi's extensions directory before loading this package. Do not load both copies.

## Configure routing

The extension reads `getAgentDir()/codex-routing-policy.json` once during initialization. `PI_CODING_AGENT_DIR` selects that profile directory. The extension never searches target repositories for policy files.

A neutral example follows. Replace both model placeholders with exact native chat IDs before enabling review, or omit `review` entirely.

```json
{
	"version": 1,
	"accountOrder": ["work", "personal"],
	"copilotProfile": "work",
	"work": {
		"githubOwners": ["example-org"],
		"roots": ["~/projects/workspaces"]
	},
	"review": {
		"copilotModel": "<exact native Copilot chat model ID>",
		"codexFallbackModel": "<exact native Codex chat model ID>"
	}
}
```

The minimal policy is:

```json
{
	"version": 1,
	"accountOrder": ["personal"]
}
```

### Policy fields

- `version` is required and must equal `1`.
- `accountOrder` is required. Its only valid values are `["personal"]`, `["personal", "work"]`, and `["work", "personal"]`. It enrolls and orders Codex accounts, not a shared work budget.
- `copilotProfile` optionally assigns the existing `github-copilot` credential to `"personal"` or `"work"`. The assignment covers ordinary chat, classifiers, and review routing. Omission denies managed Copilot. It never implies personal ownership.
- `work` has optional `githubOwners` and `roots` arrays. Omitted arrays mean `[]`. Any work-owned account requires at least one valid owner or root. This includes work Copilot with a personal-only Codex order. Selectors alone do not enroll Work Codex.
- `githubOwners` contains valid GitHub owners, matched case-insensitively. Owner names cannot contain consecutive hyphens or start or end with a hyphen.
- `roots` contains absolute paths or paths beginning with `~/`. The latter resolve against the home directory at load time. Other characters are literal. Environment and command interpolation are not supported.
- `review`, when present, requires exactly `copilotModel` and `codexFallbackModel`. Both must be nonblank exact native chat model IDs without provider prefixes. There are no default models or fallback families.

Unknown fields, invalid types, invalid selectors, and malformed JSON invalidate the entire policy. Credential, header, and endpoint fields are not supported. Symlinks, nonregular files, unreadable files, and files larger than 64 KiB also fail closed. A generic warning reports personal-only routing with review disabled. A missing file is silent. Both Codex aliases and guarded Copilot remain registered after failure. Their complete native catalogs remain inspectable. Availability filters do not grant permission. Policy snapshots are immutable until `/reload` or a new extension instance.

Existing policies that used Copilot must add `copilotProfile` explicitly. Use `"work"` with nonempty work selectors for a work-owned credential, or `"personal"` for a personal credential. Reload after this input migration. No credentials move between native slots.

### Work eligibility

A repository qualifies through either of these checks:

- Its single local origin is an exact `github.com/<configured-owner>/<repo>` HTTPS or Git SSH URL. Includes and multiple origin URLs cannot qualify through origin.
- Its canonical checkout is a strict descendant of a configured root. A linked worktree outside the root also qualifies when its primary checkout is beneath that root and shares the same common Git directory.

The nearest actual Git repository owns the decision. A root container itself, a directory prefix, or a symlink into an unrelated repository does not qualify through the root check. Missing roots grant nothing. Roots are canonicalized again at every guard. Git discovery scrubs `GIT_*` variables, disables config includes for origin lookup, and bounds command time and output.

Routing uses Pi's current `ctx.cwd`, not a shell tool's working directory or an ambient startup directory. Eligible repositories use the configured Codex order. Other, unknown, and nonrepository locations use personal Codex only. A work-owned Copilot credential is unavailable there. Work requires a bound Pi context. A matching direct personal Codex source can be reused without a context or registry lookup.

Session start, model selection, and session-tree changes bind the context and await native offline availability refresh. Cached availability remains provisional. Auth, fetch, and callback boundaries recheck current membership. Known cooldowns remove eligible routed targets. If all targets are cooling down, the request fails before authentication.

## Use native account logins

```text
/login openai-codex:personal
/login openai-codex:work
/model openai-codex:personal/<native-codex-model-id>
```

Login remains native account management and is not restricted by repository scope. Pi stores each identity under its existing provider ID in the profile's `auth.json`. Native refresh and auth derivation remain in use. The original `openai-codex` provider and credential are unchanged.

Selecting either alias normalizes the session to `codex-policy/<requested-model-id>` before authentication. Every native Codex chat ID is available. The selected model ID and thinking level stay unchanged. Assistant messages record the physical account that answered.

Work auth and sends require current membership and an eligible repository. Direct work streams outside that scope fail, including raw calls, stale model objects, forged provider labels, and explicit credentials. Missing or broken target authentication is a setup error, not quota exhaustion.

Ownership authorizes OAuth refresh at its start. Once a refresh starts, the rotated result returns to native Pi for atomic persistence, even if scope or caller cancellation changes. Auth conversion and subsequent use remain guarded. This package does not persist credentials.

## Use an explicitly configured review

```text
/login github-copilot
/model profile-review/<configured-copilot-model-id>
```

The derived selection tries exactly the configured native Copilot chat model. Its account must belong to an eligible profile before any budget read or physical authentication. A work review is unavailable outside work scope, not silently converted to a personal reviewer or reported as quota exhaustion. The pstack role selector rejects an unavailable exact configured model. Choosing a personal reviewer remains explicit caller behavior.

Confirmed Copilot quota exhaustion falls back to exactly the configured Codex model under the repository account policy. No review model is advertised without a valid `review` policy.

The entry advertises shared thinking and input capabilities and the smaller context and output limits. Targets must have equal input limits after normalizing Pi's image-resize defaults of 2000 by 2000 pixels, 4.5 MiB encoded, and JPEG quality 80. Missing or incompatible native targets leave an error-only selection at the configured ID. They do not break personal core routing or select a neighboring model. Runtime capability checks run before physical target auth, including direct and stale review streams.

A notice reports use of the configured Codex fallback without assuming model-family diversity. JSON and print final answers also include the notice, including length termination and a Codex tool-use response followed by a Copilot final answer in the same prompt.

Ordinary `github-copilot` calls add ownership checks to native raw, simple, classifier, and auth operations. They retain native options, retries, signals, immediate events, OAuth model filtering, and classifier results. They do not enter quota routing, buffer starts, or receive internal quota cancellation. The review provider accepts provider-neutral `streamSimple` calls and rejects API-specific `stream` calls. This package does not modify review-role settings or replace the native footer.

## Quota and stream rules

Both Codex accounts require structured `usage_limit_reached` in an error's code or type. Copilot requires HTTP 402 with `error.code` equal to `quota_exceeded`. The Copilot response fixtures come from [Pi issue 3643](https://github.com/earendil-works/pi/issues/3643) and [GitHub community discussion 197813](https://github.com/orgs/community/discussions/197813). These responses prove a provider-reported quota block, not a billing balance.

Generic 429 responses, authentication failures, network errors, context errors, and English quota messages do not authorize fallback. Error-body inspection is limited to 16 KiB and one second and respects cancellation. Each target in the finite plan is attempted at most once. There are no implicit extra targets.

One request-local retry owner attempts each routed target at most once. Failed attempts remain hidden only before content or usage commits the stream. Text, thinking, tool calls, usage, caller aborts, callback failures, scope loss, and malformed streams prevent replay. Iterator cleanup finishes before retry or cancellation classification. Empty success remains success.

Returned HTTP responses and raw provider events record quota evidence before post-receipt scope checks. Output and usage commit before caller hooks can mutate events. Observations persist even when replay is forbidden. Only a clean structured quota error before output can advance.

Caller transport and semantic options stay intact. A matching first direct Codex source preserves its endpoint, model headers, request headers, key, and environment without catalog membership. Only an account switch resolves the exact destination model and native auth, discarding source overrides. Captured native operations own streaming and physical attribution.

Quota observations live beneath `getAgentDir()/codex-routing`. Independent `work-codex`, `personal-codex`, and `copilot-review` keys use the same version-1 file schema. Each observation is an atomically renamed file with mode `0600` in a directory created with mode `0700`. Processes merge the maximum reset per key. Only version, key, and reset timestamp are stored. Codex epoch-second `resets_at` and HTTP `Retry-After` seconds or dates determine resets. Missing or invalid resets use a 15-minute cooldown.

Corrupt work state disables work. Corrupt personal state errors. Corrupt Copilot state errors unless an active quota observation from the current process already blocks Copilot. Persistence failures retain in-process cooldowns and warn that they cannot be shared. Requests already in flight can precede another process's observation. More than 4,096 observation files fails closed. Observations are not automatically deleted.

This extension is an account-routing policy, not a sandbox. `--no-extensions` bypasses it. Other extensions and the unchanged builtin provider are outside its enforcement.

## Test

For development, run `npm ci --ignore-scripts`, then `npm test` with Node.js 22.19 or later and Pi 1.5.2 on PATH. The test command checks production types and positive and negative type fixtures before running the offline runtime suites. Development dependencies pin the tested SDK and compiler. Pi supplies runtime modules, including TypeBox, so normal extension installation needs no separate npm setup.

The independent scope suite uses the installed development SDK. Set `PROFILE_SCOPE_SDK` to another directory containing `node_modules/@earendil-works` to test an explicit SDK 1.5.2 installation. Tests install the package into temporary profiles, create real Git fixtures, and merge cooldown observations across independent processes.

Host tests use fake credentials, temporary `PI_CODING_AGENT_DIR` profiles, `--offline --no-mcp --no-context-files`, local response fixtures, and a loopback HTTP server. They cover defaults, strict parsing, policy isolation and reloads, scope guards, both account priorities, independent budgets, review capabilities, auth isolation, stream commitment, prompt-level notices, and native compaction. No saved credentials or upstream model requests are used.

Set `PI_PACKAGE_TEST_SOURCE` to a Git source to check an installed revision instead of the local directory.

## Implementation reference

- `policy.ts` checks raw policy structure with a private TypeBox schema, then constructs copied, frozen profile membership.
- `identifiers.ts` shares explicit ASCII, GitHub owner, and unpadded-text rules. Configured review IDs retain their stricter grammar in `policy.ts`.
- `targets.ts` correlates native credentials and budgets and performs pure eligibility and candidate selection.
- `scope.ts` reads exact Git origin records and verifies checkout provenance.
- `native-guards.ts` preserves native auth, availability, and direct-operation contracts.
- `routing.ts` returns the validated review candidates before budget selection. Each routed attempt owns one progress union, and received evidence precedes caller hooks.
- `review.ts` derives shared capabilities and tracks prompt-level Codex contribution using native stop reasons.
- `stream-evidence.ts` recognizes raw and normalized output commitment.
- `quota-protocol.ts` inspects cloned responses through byte-bounded Web Streams and decodes direct quota observations with private payloads.
- `quota.ts` reads complete bounded records and preserves local and shared provenance through immutable max-merge files.
