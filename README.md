# Puglet

A simple Linear agent powered by OpenAI that triages a Linear task by triggering an automated estimate workflow in GitHub. The bot is deployed to a Cloudflare Worker.

When you ask the bot (in a Linear agent session) to "triage" the task, it fires a `repository_dispatch` event of type `pug-estimate` at a single, pre-configured GitHub repository:

```
POST https://api.github.com/repos/<owner>/<repo>/dispatches
{ "event_type": "pug-estimate",
  "client_payload": { "linear_issue": "ZES-123", "instruction": "<optional note>" } }
```

That dispatch triggers the `Estimate Issue` workflow on the repo's default branch, which takes it from there: it analyzes the Linear task and the affected code, posts a triage summary (complexity, effort, and an AI-autonomy verdict) as a comment on the Linear issue, applies `complexity:` / `effort:` / `autonomy:` labels, and — when the verdict is `ai-can-fix` — chains straight into an automated fix that opens a pull request.

Triaging the task (for small, client-side iOS app work only) and sharing dog facts are the only things the bot can do: if asked for anything else, it politely declines — with a dog fact.

It responds to `AgentSession` webhooks from Linear and creates `AgentActivity` entries in response to prompts from users in Linear.

## Tools Available

The agent has access to a single tool:

1. **`triggerEstimateWorkflow(instruction)`** - Fires the `pug-estimate` repository dispatch for the originating Linear task. The Linear issue identifier (e.g. `ZES-123`) is pulled from the webhook payload; the optional `instruction` is a short free-text note the agent composes from any extra guidance the user gave in the session.

## Example Interactions

- "Triage this task." → triggers the estimate workflow
- "Triage this, but keep the fix to the Settings screen." → triggers the workflow with that note as the instruction
- "What's the weather in Paris?" → politely declines (with a dog fact)

## Re-running

Re-triggering is safe: the workflow serializes runs per Linear issue, and a re-run reads the full Linear thread. To override a `needs-human` verdict, remove the `autonomy:needs-human` label on the Linear issue and ask Puglet to triage again.

## Architecture

The project is built as a Cloudflare Worker with the following structure:

```
src/
├── index.ts              # Main worker entry point
├── lib/
│   ├── agent/
│   │   ├── agentClient.ts # Main agent logic
│   │   ├── tools.ts       # Tool implementations (estimate workflow dispatch)
│   │   └── prompt.ts      # Prompt provided to LLM
│   └── oauth.ts           # Linear OAuth handling
│   └── types.ts           # TypeScript type definitions
```

## Setup

### Prerequisites

- Cloudflare account
- Linear workspace with permissions to create an OAuth app
- OpenAI API key
- A GitHub token that can send repository dispatches to the target repository (see below)

### GitHub token

The bot authenticates to the GitHub REST API with a token to fire the
`repository_dispatch` event. You need **one** of:

- **Fine-grained personal access token** (recommended) — scoped to the single
  repository `Zest-Maps/ZestMaps-iOS`, with **Contents: Read and write**
  repository permission (this is what the dispatches endpoint requires). This is
  the most locked-down option.
- **Classic personal access token** — with the `repo` scope (or `public_repo` if
  the repo is public).

Whichever you create, set it as the `GITHUB_TOKEN` secret (below). The target repo
is configured via the `GITHUB_REPO` variable (`owner/repo`) in `wrangler.jsonc`.
The `Estimate Issue` workflow (with `on: repository_dispatch: types: [pug-estimate]`)
must exist on that repo's **default branch** — repository dispatches only trigger
workflows from the default branch.

### Cloudflare Worker Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure Cloudflare environment**

   * Set your `WORKER_URL`, `LINEAR_CLIENT_ID`, and `GITHUB_REPO` variables in `wrangler.jsonc`

   * Set the client secret, webhook secret, OpenAI API key, and GitHub token via wrangler
   ```
   wrangler secret put LINEAR_CLIENT_SECRET
   wrangler secret put LINEAR_WEBHOOK_SECRET
   wrangler secret put OPENAI_API_KEY
   wrangler secret put GITHUB_TOKEN
   ```

   * Create a KV namespace and set its ID in `wrangler.jsonc` as well
   ```
   wrangler kv namespace create "PUGLET_BOT_TOKENS"
   ```

3. **Deploy**
   ```
   npm run deploy
   ```

### Linear OAuth Setup

1. Create a new OAuth app in Linear
2. Set the redirect URI to `https://<your-worker-url>/oauth/callback`
3. Enable webhooks and set the webhook endpoint to `https://<your-worker-url>/oauth/webhook`
4. Subscribe to agent session webhooks (and app user notification webhooks, if you'd like)
5. Copy the client ID, client secret, and webhook signing secret to use in your Cloudflare worker

## Installation

Once you've finished setting things up in both Linear and Cloudflare, visit `https://<your-worker-url>/oauth/authorize` to initiate OAuth between Puglet and Linear. This will install Puglet in your Linear workspace with an `actor=app` OAuth token.

## Development

### Local Development

```bash
# Start local development server
npm run dev
```

## Code Structure

### API Endpoints

- `POST /webhook` - Endpoint that receives Linear webhooks for `AgentSession` and `AgentActivity` creation
- `GET /oauth/authorize` - OAuth authorization endpoint
- `GET /oauth/callback` - OAuth callback handler

## License

This project is licensed under the MIT License.
