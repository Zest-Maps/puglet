import OpenAI from "openai";
import { LinearClient, LinearDocument as L } from "@linear/sdk";
import type { ChatCompletionMessageParam } from "openai/resources/index";
import { triggerEstimateWorkflow } from "./tools";
import { prompt } from "./prompt";
import { Content, isToolName, ToolName, UnreachableCaseError } from "../types";

/**
 * The Linear task that the agent session is attached to. The identifier
 * (e.g. "ZES-123") is what gets sent to the estimate workflow; the title is
 * kept only as context for messages.
 */
export interface LinearIssueContext {
  identifier: string;
  title: string;
}

/**
 * The estimate workflow's guard rejects anything that doesn't look like a
 * Linear identifier (e.g. "ZES-123") — and a repository_dispatch gives no
 * feedback when that happens, so we validate before dispatching.
 */
const LINEAR_IDENTIFIER_REGEX = /^[A-Za-z][A-Za-z0-9]{0,9}-[0-9]+$/;

export class AgentClient {
  private linearClient: LinearClient;
  private openai: OpenAI;
  private githubToken: string;
  private githubRepo: string;
  private issueContext: LinearIssueContext;

  // Maximum number of iterations for the agent to prevent infinite loops
  private MAX_ITERATIONS = 10;

  constructor(
    linearAccessToken: string,
    openaiApiKey: string,
    githubToken: string,
    githubRepo: string,
    issueContext: LinearIssueContext
  ) {
    this.linearClient = new LinearClient({
      accessToken: linearAccessToken,
    });
    this.openai = new OpenAI({
      apiKey: openaiApiKey,
      // The SDK defaults are a 10-minute timeout with 2 retries, so a single
      // slow/hung completion can wedge the agent loop for many minutes while
      // Linear shows "creating…" with no progress. Bound it: a 30s cap per
      // call, with one retry for transient errors (~60s absolute worst case).
      timeout: 30_000,
      maxRetries: 1,
    });
    this.githubToken = githubToken;
    this.githubRepo = githubRepo;
    this.issueContext = issueContext;
  }

  /**
   * Handle a user prompt by processing it through the agent.
   * @param userPrompt - The user prompt
   * @param agentSessionId - The Linear agent session ID
   */
  public async handleUserPrompt(agentSessionId: string, userPrompt: string) {
    // Generate more context for the LLM from previous activities in this agent session
    const activities = await this.generateMessagesFromPreviousActivities(
      agentSessionId
    );

    const messages = [
      { role: "system", content: prompt },
      userPrompt ? { role: "user", content: userPrompt } : undefined,
      ...activities,
    ].filter(Boolean) as ChatCompletionMessageParam[];

    let taskComplete = false;
    let iterations = 0;

    while (!taskComplete && iterations < this.MAX_ITERATIONS) {
      iterations++;

      try {
        const response = await this.callOpenAI(messages);
        const content = this.mapResponseToLinearActivityContent(response);

        if (content.type === L.AgentActivityType.Thought) {
          await this.linearClient.createAgentActivity({
            agentSessionId,
            content,
          });

          // Add to conversation history
          messages.push({ role: "assistant", content: response });

          // Continue the loop for next cycle, until the task is complete or the maximum iteration count is reached
        } else if (content.type === L.AgentActivityType.Action) {
          const toolName = content.action;
          // PART 1: Create the action activity to inform the user that the agent is going to use the tool
          await this.linearClient.createAgentActivity({
            agentSessionId,
            content,
          });

          // PART 2: Execute the tool
          const parameter = content.parameter;
          const toolResult = await this.executeAction({
            action: toolName,
            parameter,
          });

          // Add tool result to conversation for next LLM call
          messages.push({ role: "assistant", content: response });
          messages.push({
            role: "user",
            content: `Tool result: ${toolResult}`,
          });

          // PART 3: Create the result activity to inform the user that the tool has been executed
          const resultContent: Content = {
            type: L.AgentActivityType.Action,
            action: toolName,
            result: toolResult,
            parameter: parameter || "",
          };
          await this.linearClient.createAgentActivity({
            agentSessionId,
            content: resultContent,
          });

          // Continue the loop for next cycle
        } else if (content.type === L.AgentActivityType.Response) {
          await this.linearClient.createAgentActivity({
            agentSessionId,
            content,
          });
          taskComplete = true;
        } else if (content.type === L.AgentActivityType.Error) {
          await this.linearClient.createAgentActivity({
            agentSessionId,
            content,
          });
          taskComplete = true;
        } else if (content.type === L.AgentActivityType.Elicitation) {
          await this.linearClient.createAgentActivity({
            agentSessionId,
            content,
          });
          taskComplete = true;
        }
      } catch (error) {
        const errorMessage = `Agent error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`;
        await this.linearClient.createAgentActivity({
          agentSessionId,
          content: {
            type: "error",
            body: errorMessage,
          },
        });
        taskComplete = true;
      }
    }

    if (!taskComplete && iterations >= this.MAX_ITERATIONS) {
      const maxIterationsMessage =
        "The agent has reached the maximum number of iterations and will now stop.";
      await this.linearClient.createAgentActivity({
        agentSessionId,
        content: {
          type: "error",
          body: maxIterationsMessage,
        },
      });
    }
  }

  /**
   * Map the response from the OpenAI API to content for an agent activity in Linear.
   * In the case of an action, this function will return a different content object if the action has been executed.
   *
   * @param response - The response from the OpenAI API
   * @returns The Linear activity type
   */
  private mapResponseToLinearActivityContent(response: string): Content {
    const typeToKeyword = {
      [L.AgentActivityType.Thought]: "THINKING:",
      [L.AgentActivityType.Action]: "ACTION:",
      [L.AgentActivityType.Response]: "RESPONSE:",
      [L.AgentActivityType.Elicitation]: "ELICITATION:",
      [L.AgentActivityType.Error]: "ERROR:",
    } as const;
    const mappedType = Object.entries(typeToKeyword).find(([_, keyword]) =>
      response.startsWith(keyword)
    );
    const type = mappedType?.[0]
      ? (mappedType[0] as L.AgentActivityType)
      : L.AgentActivityType.Thought;

    switch (type) {
      case L.AgentActivityType.Thought:
      case L.AgentActivityType.Response:
      case L.AgentActivityType.Elicitation:
      case L.AgentActivityType.Error:
        return { type, body: response.replace(typeToKeyword[type], "").trim() };
      case L.AgentActivityType.Action:
        // Parse action parameters. The argument is free text that may itself
        // contain parentheses, so prefer matching through to the LAST closing
        // paren at the end of the response; if the model added trailing prose
        // after the call, fall back to a first-paren match so we still parse
        // the action instead of erroring out.
        const actionMatch =
          response.match(/ACTION:\s*(\w+)\(([\s\S]*)\)\s*$/) ??
          response.match(/ACTION:\s*(\w+)\(([^)]*)\)/);
        if (actionMatch) {
          const [, toolNameRaw, params] = actionMatch;
          if (!isToolName(toolNameRaw)) {
            throw new Error(`Invalid tool name: ${toolNameRaw}`);
          }
          const toolName = toolNameRaw as ToolName;
          return {
            type,
            action: toolName,
            // Linear requires `parameter` to be a string; an action with no
            // arguments must send "" rather than null, or the activity is rejected.
            parameter: params || "",
          };
        }
      default:
        throw new UnreachableCaseError(type);
    }
  }

  /**
   * Execute an action and return the result
   * @param props - The action and parameter
   * @returns The result of the action
   */
  private async executeAction(props: {
    action: ToolName;
    parameter: string | null;
  }): Promise<string> {
    const { action, parameter } = props;
    switch (action) {
      case "triggerEstimateWorkflow": {
        // The dispatch returns 204 regardless of what the workflow's guard
        // thinks of the payload, so an invalid identifier would fail silently
        // downstream. Catch it here and tell the user instead.
        const identifier = this.issueContext.identifier;
        if (!LINEAR_IDENTIFIER_REGEX.test(identifier)) {
          return `Error: this agent session is not attached to a Linear issue with a valid identifier (got "${identifier}"), so the estimate workflow cannot be triggered.`;
        }

        // The identifier comes from the webhook payload, never from the LLM;
        // the only LLM-provided input is the free-text instruction.
        return await triggerEstimateWorkflow({
          token: this.githubToken,
          repo: this.githubRepo,
          linearIssueId: identifier,
          instruction: (parameter ?? "").trim(),
        });
      }
      default:
        throw new UnreachableCaseError(action);
    }
  }

  /**
   * Call the OpenAI API to get a response
   * @param messages - The messages to send to the OpenAI API
   * @returns The response from the OpenAI API
   */
  private async callOpenAI(
    messages: ChatCompletionMessageParam[]
  ): Promise<string> {
    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-5.4-mini",
        messages,
      });

      return response.choices[0]?.message?.content || "No response";
    } catch (error) {
      throw new Error(
        `OpenAI API error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Generate additional context for the LLM from previous activities in this agent session.
   * In our case, we only consider user prompt and agent responses, but you can extend this logic as needed.
   *
   * @param agentSessionId - The Linear agent session ID
   * @returns All activities for the agent session
   */
  private async generateMessagesFromPreviousActivities(
    agentSessionId: string
  ): Promise<ChatCompletionMessageParam[]> {
    const agentSession = await this.linearClient.agentSession(agentSessionId);

    // Get all activities with pagination
    const allActivities = [];
    let activitiesConnection = await agentSession.activities();
    let hasNextPage = activitiesConnection.pageInfo.hasNextPage;

    // Add first page of activities
    allActivities.push(...activitiesConnection.nodes);

    // Continue fetching while there are more pages
    while (hasNextPage && activitiesConnection.pageInfo.endCursor) {
      activitiesConnection = await agentSession.activities({
        after: activitiesConnection.pageInfo.endCursor,
      });
      allActivities.push(...activitiesConnection.nodes);
      hasNextPage = activitiesConnection.pageInfo.hasNextPage;
    }

    const activities: ChatCompletionMessageParam[] = [];
    for (const activity of allActivities
      .filter(
        (activity) =>
          activity.content.type === L.AgentActivityType.Prompt ||
          activity.content.type === L.AgentActivityType.Response
      )
      .reverse()) {
      const role =
        activity.content.type === L.AgentActivityType.Prompt
          ? "user"
          : "assistant";
      const typedContent = activity.content as
        | L.AgentActivityPromptContent
        | L.AgentActivityResponseContent;
      const content = typedContent.body;
      activities.push({ role, content });
    }
    return activities;
  }
}
