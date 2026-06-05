import { OAuthTokenResponse, StoredTokenData } from "./types";

const OAUTH_TOKEN_KEY_PREFIX = "linear_oauth_token_";

/**
 * Build the OAuth redirect URI, tolerating a trailing slash on WORKER_URL.
 * A double slash (e.g. ".../oauth/callback") won't match Linear's registered
 * redirect URI and causes an "invalid redirect_uri" error.
 * @param env - The environment variables.
 * @returns The redirect URI.
 */
function getRedirectUri(env: Env): string {
  return `${env.WORKER_URL.replace(/\/+$/, "")}/oauth/callback`;
}

/**
 * Generate a workspace-specific key for storing OAuth tokens
 * @param workspaceId - The Linear workspace ID
 * @returns The storage key
 */
function getWorkspaceTokenKey(workspaceId: string): string {
  return `${OAUTH_TOKEN_KEY_PREFIX}${workspaceId}`;
}

/**
 * Handles the OAuth authorization request.
 * Redirects the user to Linear's OAuth authorization page.
 * @param request - The request object.
 * @param env - The environment variables.
 * @returns A response object.
 */
export function handleOAuthAuthorize(request: Request, env: Env): Response {
  const scope = "read,write,app:assignable,app:mentionable";

  const authUrl = new URL("https://linear.app/oauth/authorize");
  authUrl.searchParams.set("client_id", env.LINEAR_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", getRedirectUri(env));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("actor", "app");

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
    },
  });
}

/**
 * Handles the OAuth callback from Linear by exchanging the authorization code for an access token and storing it.
 * @param request - The request object.
 * @param env - The environment variables.
 * @returns A response object.
 */
export async function handleOAuthCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(`OAuth Error: ${error}`, { status: 400 });
  }

  if (!code) {
    return new Response("Missing required OAuth parameters", { status: 400 });
  }

  try {
    // Exchange authorization code for access token
    const tokenResponse = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: env.LINEAR_CLIENT_ID,
        client_secret: env.LINEAR_CLIENT_SECRET,
        code,
        redirect_uri: getRedirectUri(env),
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      return new Response(`Token exchange failed: ${errorText}`, {
        status: 400,
      });
    }

    const tokenData = (await tokenResponse.json()) as OAuthTokenResponse;

    // Get workspace information using the access token
    const workspaceInfo = await getWorkspaceInfo(tokenData.access_token);

    // Create stored token data with expiry information
    const storedTokenData: StoredTokenData = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() + tokenData.expires_in * 1000, // Convert seconds to milliseconds and add to current time
    };

    // Store the token data with workspace-specific key
    await setOAuthTokenData(env, storedTokenData, workspaceInfo.id);

    return new Response(
      `
      <html>
        <head><title>OAuth Success</title></head>
        <body>
          <h1>OAuth Authorization Successful!</h1>
          <p>Access token received and stored securely for workspace: <strong>${workspaceInfo.name}</strong></p>
          <p>You can now interact with weather bot!</p>
        </body>
      </html>
    `,
      {
        status: 200,
        headers: {
          "Content-Type": "text/html",
        },
      }
    );
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    return new Response(`Token exchange error: ${errorMessage}`, {
      status: 500,
    });
  }
}

/**
 * Retrieves the stored OAuth token for a specific workspace, automatically refreshing if expired.
 * This implementation uses a KV namespace to store the token.
 * @param env - The environment variables.
 * @param workspaceId - The Linear workspace ID
 * @returns The OAuth access token.
 */
export async function getOAuthToken(
  env: Env,
  workspaceId: string
): Promise<string | null> {
  if (!env.PUGLET_BOT_TOKENS) {
    return null;
  }

  try {
    const key = getWorkspaceTokenKey(workspaceId);
    const storedData = await env.PUGLET_BOT_TOKENS.get(key);

    if (!storedData) {
      return null;
    }

    // Try to parse as JSON (new format)
    let tokenData: StoredTokenData;
    try {
      tokenData = JSON.parse(storedData) as StoredTokenData;
    } catch {
      // If parsing fails, treat as legacy string token
      console.warn("Found legacy token format, treating as expired");
      return null;
    }

    // Check if token is expired (with 5 minute buffer)
    const bufferTime = 5 * 60 * 1000; // 5 minutes in milliseconds
    const isExpired = Date.now() >= tokenData.expires_at - bufferTime;

    if (!isExpired) {
      // Token is still valid
      return tokenData.access_token;
    }

    // Token is expired, try to refresh
    if (!tokenData.refresh_token) {
      console.error("Token expired and no refresh token available");
      return null;
    }

    try {
      console.log("Access token expired, refreshing...");
      const refreshedTokenData = await refreshAccessToken(
        env,
        tokenData.refresh_token
      );

      // Update stored token data
      const newStoredTokenData: StoredTokenData = {
        access_token: refreshedTokenData.access_token,
        refresh_token: refreshedTokenData.refresh_token,
        expires_at: Date.now() + refreshedTokenData.expires_in * 1000,
      };

      // Store the refreshed token
      await setOAuthTokenData(env, newStoredTokenData, workspaceId);

      console.log("Token refreshed successfully");
      return newStoredTokenData.access_token;
    } catch (refreshError) {
      console.error("Failed to refresh token:", refreshError);
      return null;
    }
  } catch (error) {
    console.error("Error retrieving OAuth token:", error);
    return null;
  }
}

/**
 * Stores the OAuth token data for a specific workspace.
 * This implementation uses a KV namespace to store the token data.
 * @param env - The environment variables.
 * @param tokenData - The OAuth token data including access token, refresh token, and expiry.
 * @param workspaceId - The Linear workspace ID.
 */
export async function setOAuthTokenData(
  env: Env,
  tokenData: StoredTokenData,
  workspaceId: string
): Promise<void> {
  const key = getWorkspaceTokenKey(workspaceId);
  await env.PUGLET_BOT_TOKENS.put(key, JSON.stringify(tokenData));
}

/**
 * Checks if OAuth token exists and is valid for a specific workspace.
 * This will attempt to refresh the token if it's expired.
 * @param env - The environment variables.
 * @param workspaceId - The Linear workspace ID
 * @returns True if a valid OAuth token exists, false otherwise.
 */
export async function hasOAuthToken(
  env: Env,
  workspaceId: string
): Promise<boolean> {
  const token = await getOAuthToken(env, workspaceId);
  return token !== null;
}

/**
 * Refresh an expired access token using the refresh token
 * @param env - The environment variables
 * @param refreshToken - The refresh token
 * @returns The new token data
 */
async function refreshAccessToken(
  env: Env,
  refreshToken: string
): Promise<OAuthTokenResponse> {
  const response = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.LINEAR_CLIENT_ID,
      client_secret: env.LINEAR_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed: ${errorText}`);
  }

  return (await response.json()) as OAuthTokenResponse;
}

/**
 * Get the workspace information from Linear using the access token
 * @param accessToken - The Linear access token
 * @returns The workspace information
 */
async function getWorkspaceInfo(
  accessToken: string
): Promise<{ id: string; name: string }> {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: `
        query {
          viewer {
            organization {
              id
              name
            }
          }
        }
      `,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to get workspace info: ${response.statusText}`);
  }

  const data = (await response.json()) as {
    data?: {
      viewer?: {
        organization?: {
          id: string;
          name: string;
        };
      };
    };
  };

  const organization = data.data?.viewer?.organization;

  if (!organization) {
    throw new Error("No organization found in response");
  }

  return {
    id: organization.id,
    name: organization.name,
  };
}
