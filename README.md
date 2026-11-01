# Antigravity ChatGPT

Adds ChatGPT models to the native Google Antigravity agent chat, using the ChatGPT
subscription you already pay for. No OpenAI API key, no per-token billing.

Antigravity IDE ships with a fixed model list and no way to add a provider. This
extension serves the Cloud Code model catalog through a local proxy, appends the
ChatGPT models you pick, and translates the agent's Gemini-shaped traffic to the
Codex Responses API. Native Gemini/Claude models keep going to Google untouched.

## Why Codex credentials

ChatGPT Plus has no API key. The official Codex CLI signs in to the same backend
(`chatgpt.com/backend-api/codex`) with a Plus account, so this extension borrows
that session: it reads `~/.codex/auth.json`, refreshes the token in place, and
calls the API directly. Signing out with `codex logout` signs the extension out
too.

Requires the Codex CLI (`npm install -g @openai/codex`) once, for `codex login`.

## How it works

| Hook | Covers |
| --- | --- |
| `jetski.cloudCodeUrl` user setting | catalog / account calls from the Electron main process |
| `SetCloudCodeURL` RPC on the language-server hub | chat generation (`streamGenerateContent`) |

The extension starts a loopback proxy, points both hooks at it, and rewrites only
the requests whose model id belongs to an injected entry. Everything else is
forwarded byte-for-byte.

```
Antigravity agent
      │  Gemini GenerateContent (+ tools)
      ▼
127.0.0.1:57333  (this extension)
      │  Gemini → Chat Completions → Responses
      ▼
chatgpt.com/backend-api/codex/responses   (ChatGPT Plus session)
```

## Setup

1. `Antigravity ChatGPT: Sign in with ChatGPT` (opens `codex login`).
2. `Antigravity ChatGPT: Enable ChatGPT routing`.
3. Reload the window.
4. Pick a model under the "ChatGPT" group in the agent model picker.

If the model list is missing, `Antigravity ChatGPT: Restart proxy and re-attach
language server`, then reload.

## Turning it off

`Antigravity ChatGPT: Disable` restores the original `jetski.cloudCodeUrl` value
(or removes it if it was unset) and puts the language server back on the Google
endpoint.

## Notes

- The proxy binds to `127.0.0.1` only.
- Provider failures are reported as a normal assistant message, so the agent never
  retries in a loop. Four failures in 15 s trip a short circuit breaker.
- Internal Cloud Code shapes change between Antigravity releases. The proxy fails
  open: if the catalog cannot be parsed, the upstream response is returned
  untouched, and native models keep working.
- Reasoning summaries stream into the same "thought" parts Antigravity already
  renders for Gemini.
- Using a ChatGPT subscription from a non-OpenAI client is not something OpenAI
  documents as supported. Your account, your call.

## Commands

- `Open settings panel (account & models)`
- `Sign in with ChatGPT` / `Sign out` / `Check sign-in`
- `Add ChatGPT models to the picker` / `Remove ChatGPT models`
- `Enable ChatGPT routing` / `Disable ChatGPT routing`
- `Restart proxy and re-attach language server`
- `Show log`
