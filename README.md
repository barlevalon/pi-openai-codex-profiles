# Pi OpenAI Codex Profiles

Keep separate `personal` and `work` OpenAI Codex OAuth credentials in Pi.

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

/model openai-codex:personal/gpt-5.5
/model openai-codex:work/gpt-5.5
```

Pi stores each login under its provider ID in `~/.pi/agent/auth.json`. The original `openai-codex` credential remains unchanged.

This implements the custom-provider approach suggested in [earendil-works/pi#1770](https://github.com/earendil-works/pi/issues/1770).

## Test

With Node.js and Pi on PATH, run `npm test`. The check installs this directory into a temporary Pi profile and verifies that both aliases expose the bundled Codex models. It uses no saved credentials and makes no model requests.

Set `PI_PACKAGE_TEST_SOURCE` to a Git source to check an installed revision instead of the local directory.
