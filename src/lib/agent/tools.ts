/**
 * A GitHub issue or pull request that may match an existing task.
 */
export interface MatchingItem {
  url: string;
  title: string;
  isPr: boolean;
}

/** How many pages of 100 issues to scan before giving up (bounds cost). */
const MAX_DEDUP_PAGES = 10;

/**
 * Find existing issues or pull requests in the configured repository that
 * already match the Linear task, so we don't create a duplicate.
 *
 * Two complementary signals are used and merged:
 *   1. The Linear task URL, which Puglet writes into every issue body — this
 *      exactly catches anything already referencing this same Linear task
 *      (issues we created before, or PRs that mention it).
 *   2. The task title, which catches manually-created matches that don't
 *      reference the Linear URL.
 *
 * We deliberately do NOT use GitHub's `/search/issues` endpoint here. That
 * endpoint is backed by the global search index, which a fine-grained PAT
 * scoped to a single private repo (the token type the README recommends)
 * cannot read — it returns 422 "the listed repositories cannot be searched".
 * Instead we page through `GET /repos/{repo}/issues`, which only needs
 * Issues:read — the same permission the token already uses to create issues —
 * and filter client-side. That endpoint returns PRs alongside issues; an item
 * is a PR when it has a `pull_request` field.
 *
 * Coverage is bounded to MAX_DEDUP_PAGES (most-recently-updated first), which
 * comfortably covers re-triage of a recent task; the cap is logged if hit.
 *
 * @param params.token - A GitHub token that can read issues on the repo
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

  const normalizedTitle = title.trim().toLowerCase();

  // Nothing to match on — treat as "no duplicates found" rather than erroring.
  if (!normalizedTitle && !linearUrl) {
    return { matches: [] };
  }

  try {
    const byUrl = new Map<string, MatchingItem>();

    for (let page = 1; page <= MAX_DEDUP_PAGES; page++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(
        `https://api.github.com/repos/${repo}/issues?state=all&per_page=100&page=${page}&sort=updated&direction=desc`,
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
          error: `GitHub issues API error: ${response.status} ${response.statusText} - ${errorText}`,
        };
      }

      const items = (await response.json()) as {
        html_url: string;
        title: string;
        body?: string | null;
        pull_request?: unknown;
      }[];

      for (const item of items) {
        const titleMatches =
          !!normalizedTitle && item.title.trim().toLowerCase() === normalizedTitle;
        const urlMatches =
          !!linearUrl && (item.body ?? "").includes(linearUrl);

        if (titleMatches || urlMatches) {
          byUrl.set(item.html_url, {
            url: item.html_url,
            title: item.title,
            isPr: item.pull_request !== undefined,
          });
        }
      }

      // A short page means we've reached the end of the list.
      if (items.length < 100) {
        break;
      }

      if (page === MAX_DEDUP_PAGES) {
        console.warn(
          `findMatchingIssuesOrPrs: stopped after scanning ${MAX_DEDUP_PAGES} pages (${
            MAX_DEDUP_PAGES * 100
          } issues) of ${repo}; older items were not checked for duplicates.`
        );
      }
    }

    return { matches: [...byUrl.values()] };
  } catch (error) {
    return {
      error: `Failed to look up GitHub issues: ${
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
