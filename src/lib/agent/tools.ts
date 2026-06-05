/**
 * Create a GitHub issue in the configured repository.
 *
 * The title and body are taken verbatim from the originating Linear task
 * (title -> issue title, Linear task URL -> issue body), so the agent never
 * has to retype them and the mirrored issue always matches the source.
 *
 * @param params.token - A GitHub token with permission to create issues on the repo
 * @param params.repo - The target repository as "owner/repo"
 * @param params.title - The GitHub issue title (the Linear task title)
 * @param params.body - The GitHub issue body (the Linear task URL)
 * @returns The URL of the created issue, or an error string
 */
export const createGithubIssue = async (params: {
  token: string;
  repo: string;
  title: string;
  body: string;
}): Promise<string> => {
  const { token, repo, title, body } = params;

  if (!title) {
    return "Error: no Linear task title available to use as the issue title.";
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(
      `https://api.github.com/repos/${repo}/issues`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "puglet-linear-agent",
        },
        body: JSON.stringify({ title, body }),
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      return `GitHub API error: ${response.status} ${response.statusText} - ${errorText}`;
    }

    const data = (await response.json()) as { html_url: string };
    return `Created GitHub issue: ${data.html_url}`;
  } catch (error) {
    return `Failed to create GitHub issue: ${
      error instanceof Error ? error.message : "Unknown error"
    }`;
  }
};
