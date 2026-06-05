# Puglet

A simple Linear agent powered by OpenAI that mirrors a Linear task into a GitHub issue. The bot is deployed to a Cloudflare Worker.

When you ask the bot (in a Linear agent session) to create a GitHub issue — or to "triage" the task — it creates an issue in a single, pre-configured GitHub repository where:

- the **title** is the Linear task's title, and
- the **body** is the Linear task's URL.

Creating that issue is what kicks off the downstream GitHub pipeline (which may open a pull request). The bot can only do this one thing right now: if asked for anything else, it replies that the only thing it can do is create a GitHub issue from the Linear task.

It responds to `AgentSession` webhooks from Linear and creates `AgentActivity` entries in response to prompts from users in Linear.

## Tools Available

The agent has access to a single tool:

1. **`createGithubIssue()`** - Creates a GitHub issue in the configured repo. Takes no arguments; the title and body are pulled directly from the originating Linear task.

## Example Interactions

- "Create a GitHub issue for this." → creates the issue
- "Triage this task." → creates the issue (same action)
- "What's the weather in Paris?" → "Sorry, the only thing I can do right now is create a GitHub issue from this Linear task."

## Architecture

The project is built as a Cloudflare Worker with the following structure:

```
src/
├── index.ts              # Main worker entry point
├── lib/
│   ├── agent/
│   │   ├── agentClient.ts # Main agent logic
│   │   ├── tools.ts       # Tool implementations (GitHub issue creation)
│   │   └── prompt.ts      # Prompt provided to LLM
│   └── oauth.ts           # Linear OAuth handling
│   └── types.ts           # TypeScript type definitions
```

## Setup

### Prerequisites

- Cloudflare account
- Linear workspace with permissions to create an OAuth app
- OpenAI API key
- A GitHub token that can create issues on the target repository (see below)

### GitHub token

The bot authenticates to the GitHub REST API with a token to create issues. You need **one** of:

- **Fine-grained personal access token** (recommended) — scoped to the single
  repository `Zest-Maps/ZestMaps-iOS`, with **Issues: Read and write** repository
  permission. This is the most locked-down option.
- **Classic personal access token** — with the `repo` scope (or `public_repo` if
  the repo is public).

Whichever you create, set it as the `GITHUB_TOKEN` secret (below). The target repo
is configured via the `GITHUB_REPO` variable (`owner/repo`) in `wrangler.jsonc`.

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
