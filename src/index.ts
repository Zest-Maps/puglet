import { LinearWebhookClient } from "@linear/sdk/webhooks";
import {
  handleOAuthAuthorize,
  handleOAuthCallback,
  getOAuthToken,
} from "./lib/oauth";
import { AgentClient } from "./lib/agent/agentClient";
import { AgentSessionEventWebhookPayload } from "@linear/sdk";

/**
 * This Cloudflare worker handles all requests for the demo agent.
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Puglet says hello! 🐶", { status: 200 });
    }

    // Handle OAuth authorize route
    if (url.pathname === "/oauth/authorize") {
      return handleOAuthAuthorize(request, env);
    }

    // Handle OAuth callback route
    if (url.pathname === "/oauth/callback") {
      return handleOAuthCallback(request, env);
    }

    // Handle webhook route
    if (url.pathname === "/webhook" && request.method === "POST") {
      if (!env.LINEAR_WEBHOOK_SECRET) {
        return new Response("Webhook secret not configured", { status: 500 });
      }

      if (!env.OPENAI_API_KEY) {
        return new Response("OpenAI API key not configured", { status: 500 });
      }

      if (!env.GITHUB_TOKEN) {
        return new Response("GitHub token not configured", { status: 500 });
      }

      if (!env.GITHUB_REPO) {
        return new Response("GitHub repo not configured", { status: 500 });
      }

      return this.handleWebhookWithEventListener(request, env, ctx);
    }

    return new Response("OK", { status: 200 });
  },

  /**
   * Handle webhook using the new LinearWebhookClient with event emitter pattern.
   * This uses the createHandler() method for simplified event handling.
   * @param request The incoming request.
   * @param env The environment variables.
   * @param ctx The execution context.
   * @returns A response promise.
   */
  async handleWebhookWithEventListener(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      // Create webhook client
      const webhookClient = new LinearWebhookClient(env.LINEAR_WEBHOOK_SECRET);
      const handler = webhookClient.createHandler();

      handler.on("AgentSessionEvent", (payload) => {
        // Don't await: hand the agent loop to waitUntil so we ack Linear
        // immediately (within its webhook timeout) and finish in the background.
        ctx.waitUntil(this.handleAgentSessionEvent(payload, env, ctx));
      });

      return await handler(request);
    } catch (error) {
      console.error("Error in webhook handler:", error);
      return new Response("Error handling webhook", { status: 500 });
    }
  },

  /**
   * Handle an AgentSessionEvent webhook asynchronously (for non-blocking processing).
   * @param webhook The agent session event webhook payload.
   * @param env The environment variables.
   * @param ctx The execution context.
   * @returns A promise that resolves when the webhook is handled.
   */
  async handleAgentSessionEvent(
    webhook: any,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const token = await getOAuthToken(env, webhook.organizationId);
    if (!token) {
      console.error("Linear OAuth token not found");
      return;
    }

    const issue = webhook.agentSession.issue;
    const issueContext = {
      title: issue?.title ?? "",
      url: issue?.url ?? "",
    };

    const agentClient = new AgentClient(
      token,
      env.OPENAI_API_KEY,
      env.GITHUB_TOKEN,
      env.GITHUB_REPO,
      issueContext
    );
    const userPrompt = this.generateUserPrompt(webhook);
    await agentClient.handleUserPrompt(webhook.agentSession.id, userPrompt);
  },

  /**
   * Generate a user prompt for the agent based on the webhook payload.
   * Modify this as needed if you want to give the agent more context by querying additional APIs.
   *
   * @param webhook The webhook payload.
   * @returns The user prompt.
   */
  generateUserPrompt(webhook: AgentSessionEventWebhookPayload): string {
    const issueTitle = webhook.agentSession.issue?.title;
    const commentBody = webhook.agentSession.comment?.body;
    if (issueTitle && commentBody) {
      return `Issue: ${issueTitle}\n\nTask: ${commentBody}`;
    } else if (issueTitle) {
      // The agent was delegated/assigned this task with no comment. Treat that
      // as an implicit request to triage it (i.e. create the GitHub issue).
      return `This Linear task was delegated to you with no comment. Triage it. Issue: ${issueTitle}`;
    } else if (commentBody) {
      return `Task: ${commentBody}`;
    }
    return "";
  },
};
