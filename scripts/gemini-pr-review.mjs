#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const GEMINI_REVIEW_MODELS = [
  "gemini-4-carbon",
  "gemini-4-argon",
  "gemini-4-hydrogen",
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
];

export const GEMINI_STATE_MARKER = "gemini-review-state:v1";

const IGNORED_DIFF_PATTERNS = [
  ":!pnpm-lock.yaml",
  ":!package-lock.json",
  ":!yarn.lock",
  ":!dist/**",
  ":!shared/operationPermissionCatalog*.generated.ts",
];

const RETRYABLE_HTTP_STATUSES = new Set([404, 429, 500, 502, 503, 504]);
const MAX_DIFF_CHARS = 160_000;

export function resolveModelChain(requestedModel = "") {
  const clean = String(requestedModel ?? "").trim();
  if (!clean) return [...GEMINI_REVIEW_MODELS];
  const rest = GEMINI_REVIEW_MODELS.filter((m) => m !== clean);
  return [clean, ...rest];
}

export function buildReviewPrompt({
  prNumber,
  title = "",
  headSha = "",
  changedFiles = [],
  diffText = "",
}) {
  const filesList =
    changedFiles.length > 0
      ? changedFiles.map((f) => `- ${f}`).join("\n")
      : "- (none)";
  const trimmedDiff =
    diffText.length > MAX_DIFF_CHARS
      ? `${diffText.slice(0, MAX_DIFF_CHARS)}\n\n[... diff truncated at ${MAX_DIFF_CHARS} chars ...]`
      : diffText;

  return [
    "You are an automated senior code & security reviewer for an ERP/POS accounting system (TypeScript, React, Drizzle/MySQL, tRPC).",
    "Review the PR diff strictly for high-signal bugs only:",
    "1. Double-entry / AP / AR / cash / inventory ledger drift or math/rounding mistakes.",
    "2. Authorization, branch isolation, RBAC, injection, secret exposure, or unguarded state transitions.",
    "3. Race conditions, MySQL lock ordering / isolation bugs, null crashes, or broken UI links/contracts.",
    "Do NOT report style preferences, formatting, or speculative nits.",
    "",
    `PR #${prNumber}: ${title}`,
    `Commit: ${headSha}`,
    "Changed files:",
    filesList,
    "",
    "Return ONLY valid JSON matching this exact schema (no markdown wrapping):",
    '{',
    '  "verdict": "approve" | "request_changes",',
    '  "summary": "concise summary in Arabic or English",',
    '  "findings": [',
    '    {',
    '      "severity": "P0" | "P1" | "P2",',
    '      "path": "relative/file/path.ts",',
    '      "line": 123,',
    '      "title": "short finding title",',
    '      "body": "clear actionable explanation and fix"',
    "    }",
    "  ]",
    "}",
    "",
    "Diff:",
    trimmedDiff || "(empty diff)",
  ].join("\n");
}

export function parseGeminiReviewResponse(rawText) {
  const clean = String(rawText ?? "").trim();
  if (!clean) {
    throw new Error("Gemini returned an empty response.");
  }
  const fenceMatch = clean.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : clean;
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const objStart = candidate.indexOf("{");
    const objEnd = candidate.lastIndexOf("}");
    if (objStart < 0 || objEnd <= objStart) {
      throw new Error("Gemini response did not contain valid JSON.");
    }
    parsed = JSON.parse(candidate.slice(objStart, objEnd + 1));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Gemini JSON payload must be an object.");
  }
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const findings = rawFindings
    .filter((f) => f && typeof f === "object")
    .map((f) => {
      const sev = String(f.severity ?? "P2")
        .trim()
        .toUpperCase();
      const normalizedSev =
        sev === "P0" || sev === "P1" || sev === "P2" ? sev : "P2";
      const parsedLine = Number(f.line);
      return {
        severity: normalizedSev,
        path: String(f.path ?? "").trim(),
        line:
          Number.isSafeInteger(parsedLine) && parsedLine > 0
            ? parsedLine
            : null,
        title: String(f.title ?? "Review finding").trim().slice(0, 160),
        body: String(f.body ?? "").trim(),
      };
    })
    .filter((f) => f.body.length > 0 || f.title.length > 0);

  const verdict =
    findings.length > 0 || parsed.verdict === "request_changes"
      ? "request_changes"
      : "approve";
  const summary = String(parsed.summary ?? "").trim() || (
    findings.length === 0
      ? "لم تُرصد ملاحظات حرجة أو منطقية في هذا الالتزام."
      : `تم رصد ${findings.length} ملاحظة تتطلّب المعالجة قبل الدمج.`
  );

  return { verdict, summary, findings };
}

export function formatStickyStateComment({
  commitSha,
  model,
  hasAnyFindings,
  hasUnresolvedFindings,
  status,
  summary = "",
  findings = [],
  reviewedAt = new Date().toISOString(),
}) {
  const payload = {
    commit_sha: commitSha,
    model,
    has_any_findings: Boolean(hasAnyFindings),
    has_unresolved_findings: Boolean(hasUnresolvedFindings),
    status,
  };
  const stateLine = `<!-- ${GEMINI_STATE_MARKER} ${JSON.stringify(payload)} -->`;
  const heading =
    status === "failed"
      ? "Gemini Review: Failed"
      : hasUnresolvedFindings
        ? `Gemini Review (${model}): ${findings.length} finding(s) require resolution`
        : `Gemini Review (${model}): Approved (0 unresolved findings)`;

  const lines = [
    stateLine,
    `### ${heading}`,
    "",
    `- **Commit:** \`${String(commitSha).slice(0, 9)}\``,
    `- **Model:** \`${model}\``,
    `- **Reviewed At:** \`${reviewedAt}\``,
  ];
  if (summary) {
    lines.push("", summary);
  }
  if (findings.length > 0) {
    lines.push("", "| Severity | File | Line | Finding |", "| --- | --- | --- | --- |");
    for (const f of findings) {
      const safeFile = f.path ? `\`${f.path.replace(/\|/g, "\\|")}\`` : "—";
      const safeLine = f.line != null ? String(f.line) : "—";
      const safeTitle = f.title.replace(/\|/g, "\\|");
      lines.push(`| **${f.severity}** | ${safeFile} | ${safeLine} | ${safeTitle} |`);
    }
  }
  return lines.join("\n");
}

export async function callGeminiWithFallback({
  apiKey,
  models = GEMINI_REVIEW_MODELS,
  prompt,
  fetchFn = globalThis.fetch,
}) {
  const cleanKey = String(apiKey ?? "").trim();
  if (!cleanKey) {
    throw new Error("GEMINI_API_KEY is missing.");
  }
  const errors = [];
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": cleanKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const msg = `${model} HTTP ${res.status}: ${errText.slice(0, 300)}`;
      errors.push(msg);
      if (RETRYABLE_HTTP_STATUSES.has(res.status)) {
        continue;
      }
      throw new Error(msg);
    }
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts
      ?.map((p) => p?.text ?? "")
      .join("")
      .trim();
    if (!text) {
      errors.push(`${model}: empty candidate text`);
      continue;
    }
    const parsed = parseGeminiReviewResponse(text);
    return { model, ...parsed };
  }
  throw new Error(`All Gemini models failed: ${errors.join(" | ")}`);
}

async function githubRequest({ token, method = "GET", path, body }) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`GitHub API ${method} ${path} failed (${res.status}): ${errText.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function upsertStickyComment({ token, owner, repo, prNumber, body }) {
  const comments = await githubRequest({
    token,
    path: `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
  });
  const existing = Array.isArray(comments)
    ? comments.find(
        (c) =>
          String(c?.user?.login ?? "").toLowerCase() === "github-actions[bot]" &&
          String(c?.body ?? "").includes(GEMINI_STATE_MARKER),
      )
    : null;
  if (existing?.id) {
    await githubRequest({
      token,
      method: "PATCH",
      path: `/repos/${owner}/${repo}/issues/comments/${existing.id}`,
      body: { body },
    });
  } else {
    await githubRequest({
      token,
      method: "POST",
      path: `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      body: { body },
    });
  }
}

function runGit(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 25 * 1024 * 1024,
  });
}

async function main() {
  const apiKey = String(process.env.GEMINI_API_KEY ?? "").trim();
  const token = String(process.env.GITHUB_TOKEN ?? "").trim();
  const repository = String(process.env.GITHUB_REPOSITORY ?? "").trim();
  const prNumber = Number(process.env.PR_NUMBER ?? 0);
  const baseSha = String(process.env.BASE_SHA ?? "").trim();
  const headSha = String(process.env.HEAD_SHA ?? "").trim();
  const prTitle = String(process.env.PR_TITLE ?? "").trim();
  const requestedModel = String(process.env.GEMINI_REVIEW_MODEL ?? "").trim();
  const triggerMode = String(process.env.GEMINI_TRIGGER_MODE ?? "auto").trim();

  if (!apiKey) {
    if (triggerMode === "auto") {
      console.log("GEMINI_API_KEY secret is not configured; skipping automatic Gemini fallback review without publishing a completed state.");
      return;
    }
    throw new Error("GEMINI_API_KEY secret is required to run Gemini PR review.");
  }
  if (!token || !repository.includes("/") || !Number.isSafeInteger(prNumber) || prNumber <= 0 || !baseSha || !headSha) {
    throw new Error("Missing required PR review environment variables (GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, BASE_SHA, HEAD_SHA).");
  }

  const [owner, repo] = repository.split("/");
  const changedFiles = runGit([
    "diff",
    "--name-only",
    `${baseSha}...${headSha}`,
    "--",
    ".",
    ...IGNORED_DIFF_PATTERNS,
  ])
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const diffText = runGit([
    "diff",
    "--unified=4",
    `${baseSha}...${headSha}`,
    "--",
    ".",
    ...IGNORED_DIFF_PATTERNS,
  ]);

  const models = resolveModelChain(requestedModel);
  const prompt = buildReviewPrompt({
    prNumber,
    title: prTitle,
    headSha,
    changedFiles,
    diffText,
  });

  const review = await callGeminiWithFallback({ apiKey, models, prompt });
  const hasFindings = review.findings.length > 0;

  if (hasFindings) {
    const changedSet = new Set(changedFiles);
    const inlineComments = [];
    const fallbackNotes = [];
    for (const f of review.findings) {
      const msg = `**[${f.severity}] ${f.title}**\n\n${f.body}`;
      if (f.path && changedSet.has(f.path) && f.line != null) {
        inlineComments.push({
          path: f.path,
          line: f.line,
          side: "RIGHT",
          body: msg,
        });
      } else {
        fallbackNotes.push(`- **[${f.severity}]** \`${f.path || "general"}\`: ${f.title} — ${f.body}`);
      }
    }
    const reviewBody = [
      `Gemini Review (\`${review.model}\`) on \`${headSha.slice(0, 9)}\`:`,
      "",
      review.summary,
      ...(fallbackNotes.length > 0 ? ["", ...fallbackNotes] : []),
    ].join("\n");
    try {
      await githubRequest({
        token,
        method: "POST",
        path: `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
        body: {
          commit_id: headSha,
          event: "COMMENT",
          body: reviewBody,
          ...(inlineComments.length > 0 ? { comments: inlineComments } : {}),
        },
      });
    } catch {
      await githubRequest({
        token,
        method: "POST",
        path: `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
        body: {
          commit_id: headSha,
          event: "COMMENT",
          body: [
            reviewBody,
            "",
            ...review.findings.map(
              (f) => `- **[${f.severity}]** \`${f.path || "general"}${f.line ? `:${f.line}` : ""}\`: ${f.title} — ${f.body}`,
            ),
          ].join("\n"),
        },
      });
    }
  }

  const stickyBody = formatStickyStateComment({
    commitSha: headSha,
    model: review.model,
    hasAnyFindings: hasFindings,
    hasUnresolvedFindings: hasFindings,
    status: "completed",
    summary: review.summary,
    findings: review.findings,
  });

  await upsertStickyComment({
    token,
    owner,
    repo,
    prNumber,
    body: stickyBody,
  });

  console.log(
    `Gemini PR review completed with ${review.model} (${review.findings.length} finding(s)).`,
  );
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
