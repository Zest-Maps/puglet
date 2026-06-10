# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Puglet is a Linear agent deployed as a Cloudflare Worker. It receives `AgentSession` webhooks from Linear, runs an OpenAI-driven agent loop, and has exactly one tool: firing a `pug-estimate` `repository_dispatch` at the GitHub repo configured in `wrangler.jsonc` (`GITHUB_REPO`, currently `Zest-Maps/ZestMaps-iOS`). The dispatched `Estimate Issue` workflow on that repo's default branch does the actual triage/fix work. The agent is intentionally limited: triage small client-side iOS tasks, share dog facts, decline everything else.

## Commands

```bash
npm run dev        # wrangler dev (local server)
npm run deploy     # wrangler deploy --minify
npm run lint       # eslint src --ext .ts
npm run lint:fix
npm run cf-typegen # regenerate worker-configuration.d.ts (Env types) from wrangler.jsonc
```

There are no tests. Run `npm run cf-typegen` after changing bindings/vars in `wrangler.jsonc` — the global `Env` type used throughout `src/` comes from the generated `worker-configuration.d.ts`.

## Architecture

Request flow: `src/index.ts` routes `/` (health), `/oauth/authorize`, `/oauth/callback`, and `POST /webhook`. The webhook handler verifies the signature via `LinearWebhookClient`, then hands `AgentSessionEvent` processing to `ctx.waitUntil()` so Linear gets an ack within its webhook timeout while the agent loop finishes in the background.

Agent loop (`src/lib/agent/agentClient.ts`): `AgentClient.handleUserPrompt` rebuilds conversation history from previous Linear agent-session activities, then loops (max 10 iterations) calling OpenAI. The LLM does **not** use native function calling — it emits plain text prefixed with one of `THINKING:` / `ACTION:` / `RESPONSE:` / `ELICITATION:` / `ERROR:` (defined in `src/lib/agent/prompt.ts`), which `mapResponseToLinearActivityContent` parses into Linear `AgentActivity` types. `RESPONSE`, `ERROR`, and `ELICITATION` end the loop; `THINKING` and `ACTION` continue it. Actions are posted to Linear twice: once before execution (announcement) and once after with the result.

Tool execution (`src/lib/agent/tools.ts`): the Linear issue identifier comes from the webhook payload, never from the LLM — the only LLM-controlled input is the free-text `instruction`. The identifier is validated against `LINEAR_IDENTIFIER_REGEX` before dispatching because GitHub answers a `repository_dispatch` with 204 regardless of payload validity, so bad payloads would otherwise fail silently downstream.

OAuth (`src/lib/oauth.ts`): tokens are obtained with `actor=app` and stored per-workspace in the `PUGLET_BOT_TOKENS` KV namespace as JSON (`StoredTokenData`), auto-refreshed with a 5-minute expiry buffer.

## Constraints worth knowing

- The OpenAI client is deliberately bounded (30s timeout, 1 retry) so a hung completion can't wedge the worker while Linear shows "creating…". Keep external calls bounded similarly (the GitHub dispatch uses a 10s AbortController).
- Changing the agent's behavior usually means editing `src/lib/agent/prompt.ts`. The prompt, the keyword parser in `agentClient.ts`, and the `ToolName`/`Content` types in `src/lib/types.ts` must stay in sync — adding a tool touches all three plus `executeAction`.
- Linear rejects an Action activity whose `parameter` is null; always send `""` for no-argument actions.
- Secrets (`LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, `OPENAI_API_KEY`, `GITHUB_TOKEN`) are set via `wrangler secret put`; non-secret config (`WORKER_URL`, `LINEAR_CLIENT_ID`, `GITHUB_REPO`) lives in `wrangler.jsonc` `vars`.
