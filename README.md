# Pi OpenAI Codex Profiles

Keep separate `personal` and `work` OpenAI Codex OAuth credentials in Pi.

## Install

Clone this repository into Pi's global extensions directory and install its dependency:

```bash
git clone https://github.com/barlevalon/pi-openai-codex-profiles.git \
  ~/.pi/agent/extensions/openai-codex-profiles
npm install --omit=dev --prefix ~/.pi/agent/extensions/openai-codex-profiles
```

Restart Pi or run `/reload`.

## Use

```text
/login openai-codex:personal
/login openai-codex:work

/model openai-codex:personal/gpt-5.5
/model openai-codex:work/gpt-5.5
```

Pi stores each login under its provider ID in `~/.pi/agent/auth.json`. The original `openai-codex` credential remains unchanged.

This implements the custom-provider approach suggested in [earendil-works/pi#1770](https://github.com/earendil-works/pi/issues/1770).
