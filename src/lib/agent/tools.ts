/**
 * A GitHub issue or pull request that may match an existing task.
 */
export interface MatchingItem {
  url: string;
  title: string;
  isPr: boolean;
}

/**
 * Search the configured repository for existing issues or pull requests that
 * already match the Linear task, so we don't create a duplicate.
 *
 * Two complementary signals are used and merged:
 *   1. The Linear task URL, which Puglet writes into every issue body — this
 *      exactly catches anything already referencing this same Linear task
 *      (issues we created before, or PRs that mention it).
 *   2. The task title, which catches manually-created matches that don't
 *      reference the Linear URL.
 *
 * GitHub's `/search/issues` endpoint returns both issues and pull requests in
 * one call; an item is a PR when it has a `pull_request` field.
 *
 * @param params.token - A GitHub token that can read issues and pull requests on the repo
 * @param params.repo - The target repository as "owner/repo"
 * @param params.title - The Linear task title to match against issue/PR titles
 * @param params.linearUrl - The Linear task URL to match against issue/PR bodies
 * @returns The matching items, or an error string
 */
export const findMatchingIssuesOrPrs = async (params: {
  token: string;
  repo: string;
  title: string;
  linearUrl: string;
}): Promise<{ matches: MatchingItem[] } | { error: string }> => {
  const { token, repo, title, linearUrl } = params;

  // Strip embedded double quotes so they don't break the quoted search phrase.
  const safeTitle = title.replace(/"/g, "").trim();

  const queries: string[] = [];
  if (linearUrl) {
    queries.push(`repo:${repo} "${linearUrl}"`);
  }
  if (safeTitle) {
    queries.push(`repo:${repo} in:title "${safeTitle}"`);
  }

  // Nothing to match on — treat as "no duplicates found" rather than erroring.
  if (queries.length === 0) {
    return { matches: [] };
  }

  try {
    const byUrl = new Map<string, MatchingItem>();

    for (const q of queries) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(
        `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=20`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "puglet-linear-agent",
          },
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        return {
          error: `GitHub search API error: ${response.status} ${response.statusText} - ${errorText}`,
        };
      }

      const data = (await response.json()) as {
        items?: {
          html_url: string;
          title: string;
          pull_request?: unknown;
        }[];
      };

      for (const item of data.items ?? []) {
        byUrl.set(item.html_url, {
          url: item.html_url,
          title: item.title,
          isPr: item.pull_request !== undefined,
        });
      }
    }

    return { matches: [...byUrl.values()] };
  } catch (error) {
    return {
      error: `Failed to search GitHub: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    };
  }
};

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
