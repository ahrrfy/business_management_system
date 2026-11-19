import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildReviewOutcomeState,
  buildReviewPrompt,
  callGeminiWithFallback,
  formatStickyStateComment,
  GEMINI_REVIEW_MODELS,
  parseGeminiReviewResponse,
  resolveModelChain,
// @ts-expect-error untyped .mjs CLI script
} from "../gemini-pr-review.mjs";
import {
  evaluatePrMergeReadiness,
  parseGeminiReviewState,
// @ts-expect-error untyped .mjs CLI script
} from "../safe-merge.mjs";

const root = process.cwd();
const workflow = readFileSync(
  resolve(root, ".github/workflows/gemini-review.yml"),
  "utf8",
);

const greenRollup = [
  { name: "check-test-build", status: "COMPLETED", conclusion: "SUCCESS" },
  { name: "authz-guard", status: "COMPLETED", conclusion: "SUCCESS" },
  { name: "audit", status: "COMPLETED", conclusion: "SUCCESS" },
  { name: "gemini-review", status: "COMPLETED", conclusion: "SUCCESS" },
];

describe("Gemini 4 PR review workflow and safe-merge failover", () => {
  it("يحصر صلاحيات workflow ويستخدم نماذج Gemini 4 دون تنفيذ كود من فروع خارجية", () => {
    expect(workflow).toContain("permissions: {}");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain("head.repo.full_name == github.repository");
    expect(workflow).toContain("gemini-4-carbon");
    expect(workflow).toContain("gemini-4-argon");
    expect(workflow).toContain("gemini-4-hydrogen");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("node scripts/gemini-pr-review.mjs");
  });

  it("يرتب سلسلة نماذج Gemini 4 ويتبدّل عند 429/404 دون تمرير المفتاح في الرابط", async () => {
    expect(GEMINI_REVIEW_MODELS[0]).toBe("gemini-4-carbon");
    expect(resolveModelChain("gemini-4-argon")).toEqual([
      "gemini-4-argon",
      "gemini-4-carbon",
      "gemini-4-hydrogen",
      "gemini-3.8-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash-lite",
    ]);

    const seenUrls: string[] = [];
    const seenHeaders: Array<Record<string, string>> = [];
    const mockFetch = (async (url: string, init?: RequestInit) => {
      seenUrls.push(url);
      seenHeaders.push((init?.headers as Record<string, string>) ?? {});
      if (url.includes("gemini-4-carbon")) {
        return new Response("quota exceeded", { status: 429 });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      verdict: "approve",
                      summary: "لا توجد أخطاء",
                      findings: [],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await callGeminiWithFallback({
      apiKey: "test-key-secret",
      models: resolveModelChain("gemini-4-carbon"),
      prompt: buildReviewPrompt({
        prNumber: 42,
        title: "test pr",
        headSha: "abc1234567890",
        changedFiles: ["server/a.ts"],
        diffText: "+const x = 1;",
      }),
      fetchFn: mockFetch,
    });

    expect(result.model).toBe("gemini-4-argon");
    expect(result.verdict).toBe("approve");
    expect(result.findings).toEqual([]);
    expect(seenUrls.every((u) => !u.includes("key="))).toBe(true);
    expect(seenHeaders.every((h) => h["x-goog-api-key"] === "test-key-secret")).toBe(true);
  });

  it("يرفض الردود التالفة ويحفظ علامة gemini-review-state:v1 المهيكلة", () => {
    expect(() => parseGeminiReviewResponse("")).toThrow();
    expect(() => parseGeminiReviewResponse("not-json")).toThrow();

    const parsed = parseGeminiReviewResponse(
      '```json\n{"verdict":"request_changes","summary":"يوجد خلل","findings":[{"severity":"P1","path":"a.ts","line":12,"title":"t","body":"b"}]}\n```',
    );
    expect(parsed.verdict).toBe("request_changes");
    expect(parsed.findings).toHaveLength(1);
    expect(
      buildReviewOutcomeState({
        verdict: "request_changes",
        summary: "ملخص",
        findings: [],
      }),
    ).toMatchObject({
      hasBlockingReview: true,
      hasAnyFindings: true,
      hasUnresolvedFindings: true,
    });

    const sticky = formatStickyStateComment({
      commitSha: "abcdef1234567890",
      model: "gemini-4-carbon",
      hasAnyFindings: false,
      hasUnresolvedFindings: false,
      status: "completed",
      summary: "ok",
    });
    expect(sticky).toContain("<!-- gemini-review-state:v1");
    expect(sticky).toContain('"status":"completed"');
  });

  it("يقبل Gemini 4 كبديل في safe-merge عند فشل Codex فقط ويرفض الانتحال والملاحظات المفتوحة", () => {
    const trustedGemini = {
      author: { login: "github-actions" },
      body: formatStickyStateComment({
        commitSha: "headsha12345",
        model: "gemini-4-carbon",
        hasAnyFindings: false,
        hasUnresolvedFindings: false,
        status: "completed",
      }),
    };

    expect(parseGeminiReviewState([trustedGemini])).toMatchObject({
      state: "completed",
      sha: "headsha12345",
      has_unresolved_findings: false,
    });

    const codexFailedWithGeminiGreen = evaluatePrMergeReadiness({
      prView: {
        number: 500,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        headRefOid: "headsha12345",
        statusCheckRollup: greenRollup,
        comments: [
          {
            author: { login: "chatgpt-codex-connector" },
            body: '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"headsha12345","status":"failed"}} -->',
          },
          trustedGemini,
        ],
      },
    });
    expect(codexFailedWithGeminiGreen).toMatchObject({
      ready: true,
      code: "OK",
    });

    const codexCompletedWithFindingsNotOverridden = evaluatePrMergeReadiness({
      prView: {
        number: 501,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        headRefOid: "headsha12345",
        statusCheckRollup: greenRollup,
        comments: [
          {
            author: { login: "chatgpt-codex-connector" },
            body: '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"headsha12345","has_unresolved_findings":true,"status":"completed"}} -->',
          },
          trustedGemini,
        ],
      },
    });
    expect(codexCompletedWithFindingsNotOverridden).toMatchObject({
      ready: false,
      code: "PR_UNADDRESSED_REVIEW_COMMENTS",
    });

    const geminiFindingsStillBlock = evaluatePrMergeReadiness({
      prView: {
        number: 502,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        headRefOid: "headsha12345",
        statusCheckRollup: greenRollup,
        comments: [
          {
            author: { login: "chatgpt-codex-connector" },
            body: '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"headsha12345","status":"failed"}} -->',
          },
          {
            author: { login: "github-actions[bot]" },
            body: formatStickyStateComment({
              commitSha: "headsha12345",
              model: "gemini-4-carbon",
              hasAnyFindings: true,
              hasUnresolvedFindings: true,
              status: "completed",
            }),
          },
        ],
      },
    });
    expect(geminiFindingsStillBlock).toMatchObject({
      ready: false,
      code: "PR_UNADDRESSED_REVIEW_COMMENTS",
    });

    const geminiCodeAssistAppPass = evaluatePrMergeReadiness({
      prView: {
        number: 503,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        headRefOid: "headsha12345",
        statusCheckRollup: greenRollup,
        comments: [
          {
            author: { login: "chatgpt-codex-connector" },
            body: '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"headsha12345","status":"failed"}} -->',
          },
        ],
        reviews: [
          {
            author: { login: "gemini-code-assist" },
            state: "COMMENTED",
            commit: { oid: "headsha12345" },
            body: "## Code Review\n\nLooks good overall.",
          },
        ],
      },
    });
    expect(geminiCodeAssistAppPass).toMatchObject({
      ready: true,
      code: "OK",
    });

    const geminiCodeAssistChangesRequested = evaluatePrMergeReadiness({
      prView: {
        number: 504,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        headRefOid: "headsha12345",
        statusCheckRollup: greenRollup,
        comments: [
          {
            author: { login: "chatgpt-codex-connector" },
            body: '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"headsha12345","status":"failed"}} -->',
          },
        ],
        reviews: [
          {
            author: { login: "gemini-code-assist[bot]" },
            state: "CHANGES_REQUESTED",
            commit: { oid: "headsha12345" },
            body: "Found critical issue.",
          },
        ],
      },
    });
    expect(geminiCodeAssistChangesRequested).toMatchObject({
      ready: false,
      code: "PR_UNADDRESSED_REVIEW_COMMENTS",
    });

    const staleWorkflowCannotShadowHeadCodeAssist = evaluatePrMergeReadiness({
      prView: {
        number: 505,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        headRefOid: "headsha12345",
        statusCheckRollup: greenRollup,
        comments: [
          {
            author: { login: "chatgpt-codex-connector" },
            body: '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"headsha12345","status":"failed"}} -->',
          },
          {
            author: { login: "github-actions" },
            body: formatStickyStateComment({
              commitSha: "oldersha9999",
              model: "gemini-4-hydrogen",
              hasAnyFindings: false,
              hasUnresolvedFindings: false,
              status: "completed",
            }),
          },
        ],
        reviews: [
          {
            author: { login: "gemini-code-assist" },
            state: "CHANGES_REQUESTED",
            commit: { oid: "headsha12345" },
            body: "Issue found on HEAD.",
          },
          {
            author: { login: "gemini-code-assist" },
            state: "COMMENTED",
            commit: { oid: "headsha12345" },
            body: "",
          },
        ],
      },
    });
    expect(staleWorkflowCannotShadowHeadCodeAssist).toMatchObject({
      ready: false,
      code: "PR_UNADDRESSED_REVIEW_COMMENTS",
    });
  });
});
