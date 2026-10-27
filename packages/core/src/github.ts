import { Octokit } from "@octokit/rest";

import type { Logger } from "@loupe/logger";

import type { DiffFile } from "./diff";
import type { Finding, PriorFinding, ReviewOutput } from "./types";

export type PullRef = {
  readonly owner: string;
  readonly repo: string;
  readonly pull_number: number;
};

export type PullContext = {
  readonly title: string;
  readonly description: string;
  readonly files: readonly DiffFile[];
  /** The PR head commit SHA (what this review is of). */
  readonly headSha: string;
};

/**
 * Octokit's default logger prints request warnings (like the expected 404s from
 * probing for optional convention docs) straight to the console. Route them all
 * through our logger at debug so they don't clutter info-level output.
 */
export function makeOctokit(token: string, logger: Logger): Octokit {
  return new Octokit({
    auth: token,
    log: {
      debug: (m) => logger.debug(m),
      info: (m) => logger.debug(m),
      warn: (m) => logger.debug(m),
      error: (m) => logger.debug(m),
    },
  });
}

/** Fetch PR metadata and the changed files (with patches) in one place. */
export async function fetchPullContext(
  octokit: Octokit,
  ref: PullRef,
): Promise<PullContext> {
  const { data: pr } = await octokit.pulls.get(ref);
  const files = await octokit.paginate(octokit.pulls.listFiles, {
    ...ref,
    per_page: 100,
  });
  return {
    title: pr.title,
    description: pr.body ?? "",
    files: files.map((f) => ({ path: f.filename, patch: f.patch })),
    headSha: pr.head.sha,
  };
}

/**
 * The head SHA this reviewer last reviewed, read from the sha stamped in its
 * most recent review's marker. Undefined if it has never reviewed this PR.
 */
export async function getLastReviewedSha(
  octokit: Octokit,
  ref: PullRef,
  reviewerName: string | undefined,
): Promise<string | undefined> {
  const prefix = markerPrefix(reviewerName);
  try {
    const reviews = await octokit.paginate(octokit.pulls.listReviews, {
      ...ref,
      per_page: 100,
    });
    for (const r of reviews.reverse()) {
      if (r.body?.includes(prefix)) {
        const m = /sha=([0-9a-f]{7,40})/.exec(r.body);
        if (m) return m[1];
      }
    }
  } catch {
    // treat as no prior review
  }
  return undefined;
}

/** Post a top-level PR comment (used for chat replies). */
export async function postIssueComment(
  octokit: Octokit,
  ref: PullRef,
  body: string,
): Promise<void> {
  await octokit.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.pull_number,
    body,
  });
}

/**
 * Each file's patch between two commits: what the PR's new commits changed
 * since a review of `base`. A file GitHub sends no patch for (binary, too
 * large) maps to undefined.
 */
export async function patchesBetween(
  octokit: Octokit,
  ref: PullRef,
  base: string,
  head: string,
): Promise<Map<string, string | undefined>> {
  const { data } = await octokit.repos.compareCommits({
    owner: ref.owner,
    repo: ref.repo,
    base,
    head,
  });
  return new Map((data.files ?? []).map((f) => [f.filename, f.patch]));
}

/**
 * Every inline finding any loupe reviewer has posted on this PR, so a
 * re-review can leave them out rather than report them again. Best-effort: an
 * error reads as none.
 */
export async function fetchPriorFindings(
  octokit: Octokit,
  ref: PullRef,
): Promise<PriorFinding[]> {
  try {
    const comments = await octokit.paginate(octokit.pulls.listReviewComments, {
      ...ref,
      per_page: 100,
    });
    return comments
      .filter((c) => c.body.includes(MARKER_START))
      .map((c) => ({
        path: c.path,
        line: c.line ?? c.original_line ?? null,
        body: c.body.slice(0, c.body.indexOf(MARKER_START)).trim(),
      }));
  } catch {
    return [];
  }
}

/**
 * Fetch the target repo's own convention docs at the PR head, in priority
 * order. Concatenated so the reviewer enforces the repo's actual rules rather
 * than a vendored copy. Missing files are skipped silently.
 */
export type Conventions = {
  /** Concatenated doc bodies for the prompt. */
  readonly text: string;
  /** Which requested paths actually resolved to a file at the PR head. */
  readonly found: readonly string[];
};

export async function fetchConventions(
  octokit: Octokit,
  ref: PullRef,
  paths: readonly string[],
): Promise<Conventions> {
  const { data: pr } = await octokit.pulls.get(ref);
  const sha = pr.head.sha;
  const parts: string[] = [];
  const found: string[] = [];
  for (const path of paths) {
    try {
      const { data } = await octokit.repos.getContent({
        owner: ref.owner,
        repo: ref.repo,
        path,
        ref: sha,
      });
      if ("content" in data && data.type === "file") {
        const text = Buffer.from(data.content, "base64").toString("utf8");
        parts.push(`# ${path}\n\n${text}`);
        found.push(path);
      }
    } catch {
      // file not present at head — skip
    }
  }
  return { text: parts.join("\n\n---\n\n"), found };
}

/** Per-reviewer marker prefix; the sha is appended per run. Comments and the
 * review body carry it so a later run can find what loupe already posted. */
const MARKER_START = "<!-- loupe:";
function markerPrefix(reviewerName: string | undefined): string {
  return `${MARKER_START}${reviewerName ?? "default"} `;
}
function makeMarker(reviewerName: string | undefined, sha: string): string {
  return `${markerPrefix(reviewerName)}sha=${sha} -->`;
}

const SEV_EMOJI: Record<Finding["severity"], string> = {
  blocker: "🔴",
  warning: "🟡",
  nit: "🔵",
};

/** One-line severity tally across inline findings + PR-level concerns. */
function statLine(
  inline: readonly Finding[],
  review: ReviewOutput,
  fileCount: number,
): string {
  const all = [...inline, ...review.concerns];
  const n = (s: Finding["severity"]): number =>
    all.filter((f) => f.severity === s).length;
  const bits: string[] = [];
  if (n("blocker")) bits.push(`🔴 ${n("blocker")}`);
  if (n("warning")) bits.push(`🟡 ${n("warning")}`);
  if (n("nit")) bits.push(`🔵 ${n("nit")}`);
  if (bits.length === 0) bits.push("✅ no issues");
  bits.push(`${fileCount} file${fileCount === 1 ? "" : "s"}`);
  return bits.join(" · ");
}

/** Assemble the rich Markdown review body from the structured review output. */
function renderReviewBody(
  title: string,
  stats: string,
  review: ReviewOutput,
  inline: readonly Finding[],
  dropped: readonly Finding[],
  tag: string,
): string {
  const parts: string[] = [`### 🔍 ${title}\n\n${stats}`];
  if (review.summary.trim()) parts.push(review.summary.trim());

  if (review.concerns.length > 0) {
    parts.push(
      `#### Concerns\n${review.concerns
        .map(
          (c) =>
            `- ${SEV_EMOJI[c.severity]} **${c.title}** — ${c.detail.replace(/\n/g, " ")}`,
        )
        .join("\n")}`,
    );
  }
  if (review.highlights.length > 0) {
    parts.push(
      `#### Highlights\n${review.highlights.map((h) => `- ✅ ${h}`).join("\n")}`,
    );
  }
  if (inline.length > 0) {
    parts.push(
      `_${inline.length} inline comment${inline.length === 1 ? "" : "s"} on the diff below._`,
    );
  }
  if (review.diagram) {
    parts.push("```mermaid\n" + review.diagram + "\n```");
  }
  if (dropped.length > 0) {
    parts.push(
      `<details><summary>Other notes (${dropped.length})</summary>\n\n${dropped
        .map(
          (f) =>
            `- ${SEV_EMOJI[f.severity]} \`${f.path}:${f.line}\` — ${f.body.replace(/\n/g, " ")}`,
        )
        .join("\n")}\n\n</details>`,
    );
  }
  parts.push(tag);
  return parts.join("\n\n");
}

/**
 * Post one review with inline comments. Uses REQUEST_CHANGES when any inline
 * finding is a blocker, otherwise COMMENT — never APPROVE (a bot shouldn't be a
 * required approver). Off-diff findings are appended to the summary body.
 * Earlier runs' comments stay: their threads may hold replies, and a re-review
 * is told what they already said rather than replacing them.
 */
export type PostReviewOptions = {
  readonly reviewerName?: string;
  /** PR head SHA to stamp in the marker (for incremental review next time). */
  readonly headSha: string;
  /** Files in scope, for the stat line. */
  readonly fileCount: number;
};

export async function postReview(
  octokit: Octokit,
  ref: PullRef,
  review: ReviewOutput,
  inline: readonly Finding[],
  dropped: readonly Finding[],
  opts: PostReviewOptions,
): Promise<void> {
  const hasBlocker = [...inline, ...review.concerns].some(
    (f) => f.severity === "blocker",
  );
  const title = opts.reviewerName
    ? `loupe · ${opts.reviewerName}`
    : "loupe review";
  const tag = makeMarker(opts.reviewerName, opts.headSha);
  const stats = statLine(inline, review, opts.fileCount);

  await octokit.pulls.createReview({
    ...ref,
    event: hasBlocker ? "REQUEST_CHANGES" : "COMMENT",
    body: renderReviewBody(title, stats, review, inline, dropped, tag),
    comments: inline.map((f) => ({
      path: f.path,
      line: f.line,
      body: `${SEV_EMOJI[f.severity]} **${f.severity}** ${f.body}\n\n${tag}`,
    })),
  });
}
