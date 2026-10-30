import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectModifiedUnitTestsForPush,
  evaluatePrePushPolicy,
  parsePrePushStdin,
  resolvePushedCommitShas,
} from "../safe-push-guard.mjs";
import {
  buildMergeCommandArgs,
  buildResolveReviewThreadArgs,
  evaluatePrMergeReadiness,
  flattenPaginatedIssueComments,
  flattenPaginatedReviewThreads,
  hasIncompleteIssueCommentsPagination,
  parseCodexReviewState,
  runAtomicRemediationCycle,
  verifyPostMergeCompletion,
  verifyPostMergeState,
  verifyPreMergeTargetState,
} from "../safe-merge.mjs";

const root = process.cwd();

describe("native Codex review compatibility", () => {
  const head = "1234567890abcdef1234567890abcdef12345678";
  const nativeReview = (overrides = {}) => ({
    id: "PRR_1",
    databaseId: 1,
    author: { login: "chatgpt-codex-connector[bot]" },
    commit: { oid: head },
    state: "COMMENTED",
    submittedAt: "2026-10-30T10:00:00Z",
    ...overrides,
  });
  const page = (field: string, nodes: unknown[], overrides = {}) => ({
    data: {
      repository: {
        pullRequest: {
          [field]: {
            totalCount: nodes.length,
            nodes,
            pageInfo: { hasNextPage: false, endCursor: "last" },
            ...overrides,
          },
        },
      },
    },
  });
  const base = () => ({
    number: 1601,
    state: "OPEN",
    baseRefName: "main",
    mergeable: "MERGEABLE",
    headRefOid: head,
    comments: [],
    statusCheckRollup: ["audit", "authz-guard", "check-test-build"].map(
      (name) => ({ name, status: "COMPLETED", conclusion: "SUCCESS" }),
    ),
    nativeReviews: [page("reviews", [nativeReview()])],
  });
  const evaluate = (prOverrides = {}, threads = [page("reviewThreads", [])]) =>
    evaluatePrMergeReadiness({
      prView: { ...base(), ...prOverrides },
      reviewThreads: threads,
    });

  it.each(["COMMENTED", "APPROVED"])(
    "accepts a submitted trusted %s review at the exact head without a private marker",
    (state) => {
      expect(
        evaluate({
          nativeReviews: [page("reviews", [nativeReview({ state })])],
        }),
      ).toMatchObject({ ready: true, headRefOid: head });
    },
  );

  it.each([
    ["missing", []],
    ["wrong author", [nativeReview({ author: { login: "human" } })]],
    ["pending", [nativeReview({ state: "PENDING", submittedAt: null })]],
    ["dismissed", [nativeReview({ state: "DISMISSED" })]],
    ["changes requested", [nativeReview({ state: "CHANGES_REQUESTED" })]],
    ["unknown state", [nativeReview({ state: "SUCCESS" })]],
    ["unsubmitted", [nativeReview({ submittedAt: null })]],
    ["missing commit", [nativeReview({ commit: null })]],
    ["stale head", [nativeReview({ commit: { oid: "a".repeat(40) } })]],
    ["abbreviated head", [nativeReview({ commit: { oid: head.slice(0, 9) } })]],
  ])("rejects %s native reviews", (_name, reviews) => {
    expect(
      evaluate({ nativeReviews: [page("reviews", reviews as unknown[])] })
        .ready,
    ).toBe(false);
  });

  it("never uses body text or REST-shaped objects as native proof", () => {
    expect(
      evaluate({
        nativeReviews: [
          {
            user: { login: "chatgpt-codex-connector[bot]" },
            commit_id: head,
            state: "APPROVED",
            submitted_at: "2026-10-30T10:00:00Z",
          },
        ],
        comments: [
          { author: { login: "human" }, body: "Codex approved " + head },
        ],
      }).ready,
    ).toBe(false);
  });

  it("selects the latest submitted bot review independently of array order", () => {
    const newer = nativeReview({
      id: "PRR_2",
      databaseId: 2,
      state: "CHANGES_REQUESTED",
      submittedAt: "2026-10-30T11:00:00Z",
    });
    expect(
      evaluate({ nativeReviews: [page("reviews", [newer, nativeReview()])] })
        .ready,
    ).toBe(false);
    expect(
      evaluate({ nativeReviews: [page("reviews", [nativeReview(), newer])] })
        .ready,
    ).toBe(false);
    expect(
      evaluate({
        nativeReviews: [
          page("reviews", [
            newer,
            nativeReview({
              id: "PRR_3",
              databaseId: 3,
              state: "APPROVED",
              submittedAt: "2026-10-30T12:00:00Z",
            }),
          ]),
        ],
      }).ready,
    ).toBe(true);
  });

  it("uses review IDs to order simultaneous submissions and blocks an active rerun", () => {
    const rejected = nativeReview({
      id: "PRR_2",
      databaseId: 2,
      state: "CHANGES_REQUESTED",
    });
    expect(
      evaluate({ nativeReviews: [page("reviews", [rejected, nativeReview()])] })
        .ready,
    ).toBe(false);
    const accepted = nativeReview({
      id: "PRR_3",
      databaseId: 3,
      state: "APPROVED",
    });
    expect(
      evaluate({ nativeReviews: [page("reviews", [accepted, rejected])] })
        .ready,
    ).toBe(true);
    const pending = nativeReview({
      id: "PRR_4",
      databaseId: 4,
      state: "PENDING",
      submittedAt: null,
    });
    expect(
      evaluate({ nativeReviews: [page("reviews", [pending, accepted])] }).code,
    ).toBe("PR_CODEX_REVIEW_RUNNING");
  });

  it("collects every native review page and rejects truncation or duplicated pages", () => {
    const older = nativeReview({
      id: "PRR_0",
      databaseId: 0,
      commit: { oid: "a".repeat(40) },
      submittedAt: "2026-10-29T10:00:00Z",
    });
    const first = page("reviews", [older], {
      totalCount: 2,
      pageInfo: { hasNextPage: true, endCursor: "first" },
    });
    const last = page("reviews", [nativeReview()], { totalCount: 2 });
    expect(evaluate({ nativeReviews: [first, last] }).ready).toBe(true);
    for (const nativeReviews of [
      [first],
      [last],
      [first, first, last],
      [page("reviews", [nativeReview()], { pageInfo: {} })],
      [{ ...last, errors: [{ message: "partial result" }] }],
    ]) {
      expect(evaluate({ nativeReviews }).ready).toBe(false);
    }
  });

  it.each(["running", "failed", "invalid", "completed"])(
    "does not override an explicit %s marker with native success",
    (state) => {
      const comments = [
        {
          author: { login: "chatgpt-codex-connector" },
          body: `<!-- codex-review-state:v1 ${JSON.stringify({ state, sha: "a".repeat(40) })} -->`,
        },
      ];
      expect(evaluate({ comments }).ready).toBe(false);
    },
  );

  it("requires complete resolved review threads and preserves all existing gates", () => {
    expect(evaluate({}, []).ready).toBe(false);
    expect(
      evaluate({}, [page("reviewThreads", [], { totalCount: 1 })]).ready,
    ).toBe(false);
    expect(
      evaluate({}, [page("reviewThreads", [{ id: "T", isResolved: false }])])
        .code,
    ).toBe("PR_UNADDRESSED_REVIEW_COMMENTS");
    expect(
      evaluate({}, [page("reviewThreads", [{ id: "T", isResolved: true }])])
        .ready,
    ).toBe(true);
    for (const prOverrides of [
      { baseRefName: "other" },
      { mergeStateStatus: "BEHIND" },
      { reviewDecision: "CHANGES_REQUESTED" },
      { reviewDecision: "REVIEW_REQUIRED" },
      { statusCheckRollup: [] },
      {
        statusCheckRollup: base().statusCheckRollup.map((c) => ({
          ...c,
          conclusion: "FAILURE",
        })),
      },
    ])
      expect(evaluate(prOverrides).ready).toBe(false);
  });

  it("blocks unresolved threads on later pages regardless of author or outdated status", () => {
    const first = page("reviewThreads", [{ id: "T1", isResolved: true }], {
      totalCount: 2,
      pageInfo: { hasNextPage: true, endCursor: "first" },
    });
    const last = page(
      "reviewThreads",
      [
        {
          id: "T2",
          isResolved: false,
          isOutdated: true,
          author: { login: "other-reviewer" },
        },
      ],
      { totalCount: 2 },
    );
    expect(evaluate({}, [first, last]).code).toBe(
      "PR_UNADDRESSED_REVIEW_COMMENTS",
    );
  });
});

describe("بروتوكولات الدفع الآمن والدمج الآمن والنشر الآمن", () => {
  it("يفعّل خطاف .husky/pre-push ويفحص الالتزامات المدفوعة فعلياً ويغلق آلياً عند غياب origin/main أو عدم تطابق شجرة العمل", () => {
    const prePushPath = resolve(root, ".husky/pre-push");
    expect(existsSync(prePushPath)).toBe(true);
    const prePushContent = readFileSync(prePushPath, "utf8");
    expect(prePushContent).toContain("node scripts/safe-push-guard.mjs");

    const output = execFileSync(
      process.execPath,
      [resolve(root, "scripts/safe-push-guard.mjs"), "--selftest"],
      { encoding: "utf8" },
    );
    expect(output).toContain("safe-push-guard selftest: OK");

    expect(
      evaluatePrePushPolicy({
        remoteRefs: ["refs/heads/main"],
        currentBranch: "main",
        env: {},
      }),
    ).toMatchObject({
      allowed: false,
      code: "DIRECT_MAIN_PUSH_FORBIDDEN",
    });

    expect(
      evaluatePrePushPolicy({
        remoteRefs: [],
        currentBranch: "feature/test",
        cliArgs: ["origin", "+HEAD:refs/heads/main"],
        env: {},
      }),
    ).toMatchObject({
      allowed: false,
      code: "DIRECT_MAIN_PUSH_FORBIDDEN",
    });

    expect(
      evaluatePrePushPolicy({
        remoteRefs: [],
        currentBranch: "feature/test",
        cliArgs: ["origin", "HEAD:heads/main"],
        env: {},
      }),
    ).toMatchObject({
      allowed: false,
      code: "DIRECT_MAIN_PUSH_FORBIDDEN",
    });

    const parsedStdin = parsePrePushStdin(
      "refs/heads/fix/a abc1234567890 refs/heads/fix/a 0000000000000000000000000000000000000000\n(delete) 0000000000000000000000000000000000000000 refs/heads/old 1111111111111111111111111111111111111111\n",
    );
    expect(resolvePushedCommitShas(parsedStdin)).toEqual(["abc1234567890"]);

    const diffedShas: string[] = [];
    const matched = collectModifiedUnitTestsForPush({
      stdinEntries: parsedStdin,
      unitConfigText: [
        'include: ["scripts/__tests__/safeDeliveryProtocols.test.ts", "client/src/lib/lazyWithRetry.test.ts", "scripts/__tests__/ciCriticalPathWorkflow.test.ts"]',
        '// "client/src/lib/commentedOut.test.ts"',
      ].join("\n"),
      runDiff: (sha: string) => {
        diffedShas.push(sha);
        return {
          status: 0,
          stdout:
            "scripts/__tests__/safeDeliveryProtocols.test.ts\nclient/src/lib/lazyWithRetry.ts\n.github/workflows/ci.yml\nclient/src/lib/commentedOut.ts\n",
        };
      },
      fileExists: () => true,
      verifyCheckoutMatchesSha: () => ({ ok: true }),
    });
    expect(diffedShas).toEqual(["abc1234567890"]);
    expect(matched).toEqual([
      "scripts/__tests__/safeDeliveryProtocols.test.ts",
      "client/src/lib/lazyWithRetry.test.ts",
      "scripts/__tests__/ciCriticalPathWorkflow.test.ts",
    ]);

    expect(() =>
      collectModifiedUnitTestsForPush({
        stdinEntries: parsedStdin,
        unitConfigText:
          'include: ["scripts/__tests__/safeDeliveryProtocols.test.ts"]',
        runDiff: () => ({
          status: 128,
          stderr: "unknown revision origin/main",
        }),
        fileExists: () => true,
        verifyCheckoutMatchesSha: () => ({ ok: true }),
      }),
    ).toThrow(/origin\/main/);

    expect(() =>
      collectModifiedUnitTestsForPush({
        stdinEntries: parsedStdin,
        unitConfigText:
          'include: ["scripts/__tests__/safeDeliveryProtocols.test.ts"]',
        runDiff: () => ({
          status: 0,
          stdout: "scripts/__tests__/safeDeliveryProtocols.test.ts\n",
        }),
        fileExists: () => true,
        verifyCheckoutMatchesSha: () => ({
          ok: false,
          reason: "الالتزام المدفوع لا يطابق HEAD المفحوص حالياً",
        }),
      }),
    ).toThrow(/لا يطابق HEAD/);
  });

  it("يفحص جاهزية الدمج الآمن ويثبّت --match-head-commit ويتحقق من الفرع الهدف واكتمال الدمج الفعلي", () => {
    const output = execFileSync(
      process.execPath,
      [resolve(root, "scripts/safe-merge.mjs"), "--selftest"],
      { encoding: "utf8" },
    );
    expect(output).toContain("safe-merge selftest: OK");

    const greenRollup = [
      { name: "audit", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "authz-guard", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "check-test-build", status: "COMPLETED", conclusion: "SUCCESS" },
    ];

    const blockedByWrongBase = evaluatePrMergeReadiness({
      prView: {
        number: 1526,
        state: "OPEN",
        baseRefName: "feature/other",
        mergeable: "MERGEABLE",
        headRefOid: "7f60f09e78",
        statusCheckRollup: greenRollup,
      },
    });
    expect(blockedByWrongBase.ready).toBe(false);
    expect(blockedByWrongBase.code).toBe("PR_INVALID_BASE_BRANCH");

    const blockedByBehindState = evaluatePrMergeReadiness({
      prView: {
        number: 1526,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        mergeStateStatus: "BEHIND",
        headRefOid: "7f60f09e78",
        statusCheckRollup: greenRollup,
      },
    });
    expect(blockedByBehindState.ready).toBe(false);
    expect(blockedByBehindState.code).toBe("PR_BEHIND_BASE_BRANCH");

    const blockedByReview = evaluatePrMergeReadiness({
      prView: {
        number: 1526,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        headRefOid: "7f60f09e78",
        statusCheckRollup: greenRollup,
      },
      reviewThreads: [
        {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "PRRT_4341514310",
                      isResolved: false,
                      path: "client/src/pages/CommissionPlans.tsx",
                      line: 279,
                      comments: {
                        nodes: [
                          {
                            databaseId: 4341514310,
                            author: { login: "chatgpt-codex-connector" },
                            body: "Keep the expandable guide outside the toolbar",
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      ],
    });
    expect(blockedByReview.ready).toBe(false);
    expect(blockedByReview.code).toBe("PR_UNADDRESSED_REVIEW_COMMENTS");

    const blockedByTruncatedPagination = evaluatePrMergeReadiness({
      prView: {
        number: 1526,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        headRefOid: "7f60f09e78",
        statusCheckRollup: greenRollup,
      },
      reviewThreads: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                nodes: [{ id: "T1", isResolved: true }],
              },
            },
          },
        },
      },
    });
    expect(blockedByTruncatedPagination.ready).toBe(false);
    expect(blockedByTruncatedPagination.code).toBe(
      "PR_REVIEW_THREADS_PAGINATION_INCOMPLETE",
    );

    const blockedByMalformedCodexComment = evaluatePrMergeReadiness({
      prView: {
        number: 1526,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        headRefOid: "7f60f09e78",
        statusCheckRollup: greenRollup,
        comments: [
          {
            author: { login: "chatgpt-codex-connector" },
            body: "<!-- codex-review-state:v1 {corrupted} -->",
          },
        ],
      },
    });
    expect(blockedByMalformedCodexComment.ready).toBe(false);
    expect(blockedByMalformedCodexComment.code).toBe(
      "PR_CODEX_REVIEW_STATE_INVALID",
    );

    const parsedNestedCodex = parseCodexReviewState([
      {
        author: { login: "chatgpt-codex-connector" },
        body: '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"90fb9671d55713f186742f7757481427fef726bd","has_any_findings":false,"has_unresolved_findings":false,"status":"in_progress"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->',
      },
    ]);
    expect(parsedNestedCodex?.state).toBe("in_progress");
    expect(parsedNestedCodex?.sha).toBe(
      "90fb9671d55713f186742f7757481427fef726bd",
    );

    const blockedByNestedCodexRunning = evaluatePrMergeReadiness({
      prView: {
        number: 1530,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        headRefOid: "90fb9671d55713f186742f7757481427fef726bd",
        statusCheckRollup: greenRollup,
        comments: [
          {
            author: { login: "chatgpt-codex-connector" },
            body: '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"90fb9671d55713f186742f7757481427fef726bd","has_any_findings":false,"has_unresolved_findings":false,"status":"in_progress"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->',
          },
        ],
      },
    });
    expect(blockedByNestedCodexRunning.ready).toBe(false);
    expect(blockedByNestedCodexRunning.code).toBe("PR_CODEX_REVIEW_RUNNING");

    const blockedByNestedCodexFailed = evaluatePrMergeReadiness({
      prView: {
        number: 1530,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        headRefOid: "90fb9671d55713f186742f7757481427fef726bd",
        statusCheckRollup: greenRollup,
        comments: [
          {
            author: { login: "chatgpt-codex-connector" },
            body: '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"1111111110000000000000000000000000000000","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"},"security_review":{"commit_sha":"90fb9671d55713f186742f7757481427fef726bd","has_any_findings":false,"has_unresolved_findings":false,"status":"failed"}} -->',
          },
        ],
      },
    });
    expect(blockedByNestedCodexFailed.ready).toBe(false);
    expect(blockedByNestedCodexFailed.code).toBe("PR_CODEX_REVIEW_FAILED");
    expect(blockedByNestedCodexFailed.reason).toContain("90fb9671d");

    const blockedByMissingBase = evaluatePrMergeReadiness({
      prView: {
        number: 1530,
        state: "OPEN",
        mergeable: "MERGEABLE",
        headRefOid: "90fb9671d55713f186742f7757481427fef726bd",
        statusCheckRollup: greenRollup,
      },
    });
    expect(blockedByMissingBase.ready).toBe(false);
    expect(blockedByMissingBase.code).toBe("PR_INVALID_BASE_BRANCH");

    const blockedWithFailedCi = evaluatePrMergeReadiness({
      prView: {
        number: 1530,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        headRefOid: "90fb9671d55713f186742f7757481427fef726bd",
        statusCheckRollup: [
          ...greenRollup.slice(0, 2),
          {
            name: "check-test-build",
            status: "COMPLETED",
            conclusion: "FAILURE",
          },
        ],
      },
    });
    expect(blockedWithFailedCi.ready).toBe(false);
    expect(blockedWithFailedCi.code).toBe("PR_CI_FAILED");

    const flattened = flattenPaginatedReviewThreads([
      {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { nodes: [{ id: "T1", isResolved: true }] },
            },
          },
        },
      },
      {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { nodes: [{ id: "T2", isResolved: false }] },
            },
          },
        },
      },
    ]);
    expect(flattened).toHaveLength(2);

    const mergeArgs = buildMergeCommandArgs(
      1530,
      "0bd1c2db9733578ae5ca4de6fd8d48883e503f02",
    );
    expect(mergeArgs).toContain("--match-head-commit");
    expect(mergeArgs).toContain("0bd1c2db9733578ae5ca4de6fd8d48883e503f02");
    expect(mergeArgs).not.toContain("--admin");
    expect(mergeArgs).not.toContain("--delete-branch");

    const resolveArgs = buildResolveReviewThreadArgs("PRRT_4341514310");
    expect(resolveArgs).toContain("threadId=PRRT_4341514310");

    expect(
      verifyPostMergeState({
        state: "OPEN",
        baseRefName: "main",
        mergedAt: null,
      }).merged,
    ).toBe(false);
    expect(
      verifyPostMergeState({
        state: "MERGED",
        baseRefName: "main",
        mergedAt: "2026-10-22T10:30:00Z",
        mergeCommit: { oid: "merged-sha-1" },
      }).merged,
    ).toBe(true);
    expect(
      verifyPostMergeState({
        state: "MERGED",
        baseRefName: "develop",
        mergedAt: "2026-10-22T10:30:00Z",
        mergeCommit: { oid: "merged-sha-1" },
      }).code,
    ).toBe("PR_INVALID_BASE_BRANCH");
    expect(
      verifyPreMergeTargetState({
        prNumber: 1530,
        expectedHeadRefOid: "0bd1c2db9",
        fetchState: () => ({
          prView: {
            number: 1530,
            state: "OPEN",
            baseRefName: "develop",
            headRefOid: "0bd1c2db9",
          },
          reviewThreads: [],
        }),
      }).code,
    ).toBe("PR_INVALID_BASE_BRANCH");

    const queuedVerdict = verifyPostMergeCompletion(1530, "0bd1c2db9", {
      maxAttempts: 2,
      delayMs: 0,
      sleep: () => {},
      fetchPrState: () => ({
        number: 1530,
        state: "OPEN",
        baseRefName: "main",
        mergeQueueEntry: { state: "QUEUED" },
        headRefOid: "0bd1c2db9",
      }),
    });
    expect(queuedVerdict.merged).toBe(false);
    expect(queuedVerdict.code).toBe("PR_QUEUED_NOT_MERGED_YET");
  });

  it("ينفّذ دورة الإصلاح الذرّي وإعادة الفحص حتى الاخضرار التام ويرفض عدم تطابق الرأس عن بُعد", async () => {
    const greenRollup = [
      { name: "audit", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "authz-guard", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "check-test-build", status: "COMPLETED", conclusion: "SUCCESS" },
    ];
    const makeTrustedCodexComments = (sha: string) => [
      {
        author: { login: "chatgpt-codex-connector" },
        body: `<!-- codex-review-state:v1 {"sha":"${sha}","state":"completed"} -->`,
      },
    ];

    const resolvedThreadsLog: Array<{ threadId: string; sha: string }> = [];
    const cycleResult = await runAtomicRemediationCycle({
      prNumber: 1530,
      pollIntervalMs: 0,
      initialPrView: {
        number: 1530,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        headRefOid: "sha-initial",
        statusCheckRollup: greenRollup,
        comments: makeTrustedCodexComments("sha-initial"),
      },
      initialReviewThreads: [
        {
          id: "PRRT_100",
          isResolved: false,
          path: "scripts/safe-merge.mjs",
          line: 42,
          comments: {
            nodes: [
              {
                databaseId: 100,
                author: { login: "chatgpt-codex-connector" },
                body: "Validate baseRefName before merging",
              },
            ],
          },
        },
      ],
      remediateAndCommit: async () => ({
        newHeadRefOid: "sha-atomic-fix-1",
        resolvedThreadIds: ["PRRT_100"],
      }),
      verifyLocalGates: async () => ({ ok: true }),
      resolveThread: async (threadId: string, sha: string) => {
        resolvedThreadsLog.push({ threadId, sha });
      },
      fetchLatestState: async () => ({
        prView: {
          number: 1530,
          state: "OPEN",
          baseRefName: "main",
          mergeable: "MERGEABLE",
          headRefOid: "sha-atomic-fix-1",
          statusCheckRollup: greenRollup,
          comments: makeTrustedCodexComments("sha-atomic-fix-1"),
        },
        reviewThreads: [
          {
            id: "PRRT_100",
            isResolved: true,
            path: "scripts/safe-merge.mjs",
            line: 42,
          },
        ],
      }),
    });

    expect(cycleResult.ready).toBe(true);
    expect(cycleResult.cycles).toBe(1);
    expect(cycleResult.headRefOid).toBe("sha-atomic-fix-1");
    expect(resolvedThreadsLog).toEqual([
      { threadId: "PRRT_100", sha: "sha-atomic-fix-1" },
    ]);

    let resolvedOnStaleRemote = false;
    const staleRemoteResult = await runAtomicRemediationCycle({
      prNumber: 1530,
      pollIntervalMs: 0,
      initialPrView: {
        number: 1530,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        headRefOid: "sha-unfixed-1",
        statusCheckRollup: greenRollup,
        comments: makeTrustedCodexComments("sha-unfixed-1"),
      },
      initialReviewThreads: [
        {
          id: "PRRT_101",
          isResolved: false,
          path: "scripts/safe-merge.mjs",
          line: 50,
          comments: {
            nodes: [
              {
                databaseId: 101,
                author: { login: "chatgpt-codex-connector" },
                body: "Push the atomic commit before re-evaluating",
              },
            ],
          },
        },
      ],
      remediateAndCommit: async () => ({
        newHeadRefOid: "sha-fixed-2",
        resolvedThreadIds: ["PRRT_101"],
      }),
      verifyLocalGates: async () => ({ ok: true }),
      resolveThread: async () => {
        resolvedOnStaleRemote = true;
      },
      fetchLatestState: async () => ({
        prView: {
          number: 1530,
          state: "OPEN",
          baseRefName: "main",
          mergeable: "MERGEABLE",
          headRefOid: "sha-unfixed-1",
          statusCheckRollup: greenRollup,
          comments: makeTrustedCodexComments("sha-unfixed-1"),
        },
        reviewThreads: [{ id: "PRRT_101", isResolved: true }],
      }),
    });
    expect(staleRemoteResult.ready).toBe(false);
    expect(staleRemoteResult.code).toBe("REMEDIATION_REMOTE_HEAD_MISMATCH");
    expect(resolvedOnStaleRemote).toBe(false);

    const missingThreadIdsResult = await runAtomicRemediationCycle({
      prNumber: 1530,
      pollIntervalMs: 0,
      initialPrView: {
        number: 1530,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        headRefOid: "sha-unfixed-1",
        statusCheckRollup: greenRollup,
        comments: makeTrustedCodexComments("sha-unfixed-1"),
      },
      initialReviewThreads: [
        {
          id: "PRRT_101",
          isResolved: false,
          path: "scripts/safe-merge.mjs",
          line: 50,
        },
      ],
      remediateFinding: async () => [{ commitSha: "sha-fixed-2" }],
      verifyLocalGates: async () => ({ ok: true }),
      fetchLatestState: async () => ({
        prView: {
          number: 1530,
          state: "OPEN",
          baseRefName: "main",
          mergeable: "MERGEABLE",
          headRefOid: "sha-fixed-2",
          statusCheckRollup: greenRollup,
          comments: makeTrustedCodexComments("sha-fixed-2"),
        },
        reviewThreads: [{ id: "PRRT_101", isResolved: false }],
      }),
    });
    expect(missingThreadIdsResult.ready).toBe(false);
    expect(missingThreadIdsResult.code).toBe(
      "REMEDIATION_MISSING_RESOLVED_THREADS",
    );
  });

  it("يرفض نتائج مراجعة Codex القديمة (Stale SHA) أو المفقودة أو المزوّرة ويرتب إعادات الفحوصات المتداخلة حسب وقت البدء (startedAt)", () => {
    const staleCodexRes = evaluatePrMergeReadiness({
      prView: {
        number: 1532,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        headRefOid: "new-head-sha-222",
        statusCheckRollup: [
          { name: "audit", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "authz-guard", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "quality-build", status: "COMPLETED", conclusion: "SUCCESS" },
          {
            name: "test-shard-1-of-8",
            status: "COMPLETED",
            conclusion: "SUCCESS",
          },
          {
            name: "check-test-build",
            status: "COMPLETED",
            conclusion: "SUCCESS",
          },
        ],
        comments: [
          {
            author: { login: "chatgpt-codex-connector" },
            body: '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"old-head-sha-111","status":"completed"},"security_review":{"commit_sha":null,"status":null}} -->',
          },
        ],
      },
    });
    expect(staleCodexRes.ready).toBe(false);
    expect(staleCodexRes.code).toBe("PR_CODEX_REVIEW_STALE");

    const missingCodexRes = evaluatePrMergeReadiness({
      prView: {
        number: 1532,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        headRefOid: "new-head-sha-222",
        statusCheckRollup: [
          { name: "audit", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "authz-guard", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "quality-build", status: "COMPLETED", conclusion: "SUCCESS" },
          {
            name: "test-shard-1-of-8",
            status: "COMPLETED",
            conclusion: "SUCCESS",
          },
          {
            name: "check-test-build",
            status: "COMPLETED",
            conclusion: "SUCCESS",
          },
        ],
        comments: [
          {
            author: { login: "untrusted-user" },
            body: '<!-- codex-review-state:v1 {"sha":"new-head-sha-222","state":"completed"} -->',
          },
        ],
      },
    });
    expect(missingCodexRes.ready).toBe(false);
    expect(missingCodexRes.code).toBe("PR_CODEX_REVIEW_MISSING");

    const overlappingRerunRes = evaluatePrMergeReadiness({
      prView: {
        number: 1532,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        headRefOid: "new-head-sha-222",
        statusCheckRollup: [
          { name: "audit", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "authz-guard", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "quality-build", status: "COMPLETED", conclusion: "SUCCESS" },
          {
            name: "test-shard-1-of-8",
            status: "COMPLETED",
            conclusion: "SUCCESS",
          },
          {
            name: "check-test-build",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            startedAt: "2026-10-22T10:00:00Z",
            completedAt: "2026-10-22T10:10:00Z",
          },
          {
            name: "check-test-build",
            status: "IN_PROGRESS",
            conclusion: "",
            startedAt: "2026-10-22T10:05:00Z",
            completedAt: "",
          },
        ],
      },
    });
    expect(overlappingRerunRes.ready).toBe(false);
    expect(overlappingRerunRes.code).toBe("PR_CI_PENDING");
  });

  it("يفحص خضرة بوابة CI قبل النشر الإنتاجي ويرفض الالتزامات غير المفحوصة على main أو الفاشلة ويتجاهل فحص diagnose التشخيصي", () => {
    const output = execFileSync(
      process.execPath,
      [resolve(root, "scripts/deploy.mjs"), "--selftest-ci-gate"],
      { encoding: "utf8" },
    );
    expect(output).toContain("deploy ci-gate selftest: OK");

    const deployContractOutput = execFileSync(
      process.execPath,
      [resolve(root, "scripts/deploy.test.mjs")],
      { encoding: "utf8" },
    );
    expect(deployContractOutput).toContain(
      "deployment storefront-readiness contract test: OK",
    );
  });

  it("يجلب ويتحقق من جميع صفحات تعليقات PR (>100 تعليق) ويغلق آلياً عند نقص الترقيم قبل الوثوق بعلامة Codex", () => {
    const safeMergeSource = readFileSync(
      resolve(root, "scripts/safe-merge.mjs"),
      "utf8",
    );
    expect(safeMergeSource).toContain("ISSUE_COMMENTS_QUERY");
    expect(safeMergeSource).not.toContain("statusCheckRollup,comments");

    const greenRollup = [
      { name: "audit", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "authz-guard", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "check-test-build", status: "COMPLETED", conclusion: "SUCCESS" },
    ];

    const pageOneNodes = Array.from({ length: 100 }, (_, i) => ({
      id: `IC_${i + 1}`,
      author: { login: i === 0 ? "chatgpt-codex-connector" : "reviewer" },
      body:
        i === 0
          ? '<!-- codex-review-state:v1 {"sha":"old-sha-000","state":"completed"} -->'
          : `Comment #${i + 1}`,
    }));

    const incompletePages = [
      {
        data: {
          repository: {
            pullRequest: {
              comments: {
                pageInfo: { hasNextPage: true, endCursor: "cursor-100" },
                nodes: pageOneNodes,
              },
            },
          },
        },
      },
    ];
    expect(hasIncompleteIssueCommentsPagination(incompletePages)).toBe(true);
    expect(parseCodexReviewState(incompletePages)).toMatchObject({
      state: "invalid",
      paginationIncomplete: true,
    });
    expect(
      evaluatePrMergeReadiness({
        prView: {
          number: 1532,
          state: "OPEN",
          baseRefName: "main",
          mergeable: "MERGEABLE",
          headRefOid: "head-sha-222",
          statusCheckRollup: greenRollup,
          comments: incompletePages,
        },
      }),
    ).toMatchObject({
      ready: false,
      code: "PR_ISSUE_COMMENTS_PAGINATION_INCOMPLETE",
    });

    const completePages = [
      incompletePages[0],
      {
        data: {
          repository: {
            pullRequest: {
              comments: {
                pageInfo: { hasNextPage: false, endCursor: "cursor-102" },
                nodes: [
                  {
                    id: "IC_101",
                    author: { login: "chatgpt-codex-connector" },
                    body: '<!-- codex-review-state:v1 {"sha":"head-sha-222","state":"completed"} -->',
                  },
                ],
              },
            },
          },
        },
      },
    ];
    expect(hasIncompleteIssueCommentsPagination(completePages)).toBe(false);
    expect(flattenPaginatedIssueComments(completePages)).toHaveLength(101);
    expect(
      evaluatePrMergeReadiness({
        prView: {
          number: 1532,
          state: "OPEN",
          baseRefName: "main",
          mergeable: "MERGEABLE",
          headRefOid: "head-sha-222",
          statusCheckRollup: greenRollup,
          comments: completePages,
        },
      }),
    ).toMatchObject({
      ready: true,
      code: "OK",
    });
    expect(
      evaluatePrMergeReadiness({
        prView: {
          number: 1532,
          state: "OPEN",
          baseRefName: "main",
          mergeable: "MERGEABLE",
          mergeStateStatus: "BEHIND",
          isMergeQueueEnabled: false,
          headRefOid: "head-sha-222",
          statusCheckRollup: greenRollup,
          comments: completePages,
        },
      }),
    ).toMatchObject({
      ready: false,
      code: "PR_BEHIND_BASE_BRANCH",
    });

    expect(
      evaluatePrMergeReadiness({
        prView: {
          number: 1532,
          state: "OPEN",
          baseRefName: "main",
          mergeable: "MERGEABLE",
          mergeStateStatus: "BEHIND",
          isMergeQueueEnabled: true,
          headRefOid: "head-sha-222",
          statusCheckRollup: greenRollup,
          comments: completePages,
        },
      }),
    ).toMatchObject({
      ready: true,
      code: "OK",
    });
  });

  it("يتتبع شجرة استيراد المصادر متعددة القفزات (Transitive Imports) بأمان ضد الحلقات لاختيار اختبارات الوحدة المتأثرة", () => {
    const pushedStdin = parsePrePushStdin(
      "refs/heads/fix/transitive abc9999999999 refs/heads/fix/transitive 0000000000000000000000000000000000000000\n",
    );

    // 1. Real repository transitive chain: invoiceReceipt.test.ts -> invoiceReceipt.ts -> @/lib/paymentMethod -> @shared/inboundPaymentPolicy
    const realTwoHop = collectModifiedUnitTestsForPush({
      stdinEntries: pushedStdin,
      unitConfigText:
        'include: ["client/src/lib/printing/invoiceReceipt.test.ts", "client/src/lib/lazyWithRetry.test.ts"]',
      runDiff: () => ({
        status: 0,
        stdout: "client/src/lib/paymentMethod.ts\n",
      }),
      fileExists: () => true,
      verifyCheckoutMatchesSha: () => ({ ok: true }),
    });
    expect(realTwoHop).toEqual([
      "client/src/lib/printing/invoiceReceipt.test.ts",
    ]);

    const realThreeHop = collectModifiedUnitTestsForPush({
      stdinEntries: pushedStdin,
      unitConfigText:
        'include: ["client/src/lib/printing/invoiceReceipt.test.ts", "client/src/lib/lazyWithRetry.test.ts"]',
      runDiff: () => ({
        status: 0,
        stdout: "shared/inboundPaymentPolicy.ts\n",
      }),
      fileExists: () => true,
      verifyCheckoutMatchesSha: () => ({ ok: true }),
    });
    expect(realThreeHop).toEqual([
      "client/src/lib/printing/invoiceReceipt.test.ts",
    ]);

    // 2. Cyclic imports + barrel index.ts + deleted leaf + local export type + ESM .js->.ts + type-only boundary
    const virtualFs = new Map<string, string>([
      ["client/src/mod/entry.test.ts", 'import { a } from "./a";\n'],
      [
        "client/src/mod/a.ts",
        'type LocalT = string;\nexport type { LocalT };\nimport type { HugeRouter } from "./hugeRouter";\nimport { b } from "./b.service.js";\nexport const a = b;\n',
      ],
      [
        "client/src/mod/hugeRouter.ts",
        'import { unrelated } from "./unrelatedLeaf";\nexport type HugeRouter = typeof unrelated;\n',
      ],
      ["client/src/mod/unrelatedLeaf.ts", "export const unrelated = 42;\n"],
      [
        "client/src/mod/b.service.ts",
        'import { a } from "./a";\nimport { util } from "@/lib/pkg";\nexport const b = () => util || a;\n',
      ],
      [
        "client/src/lib/pkg/index.ts",
        'export { leaf } from "./leaf";\nexport { deletedLeaf } from "./deletedLeaf";\n',
      ],
      ["client/src/lib/pkg/leaf.ts", "export const leaf = 1;\n"],
    ]);

    expect(
      collectModifiedUnitTestsForPush({
        stdinEntries: pushedStdin,
        unitConfigText: 'include: ["client/src/mod/entry.test.ts"]',
        runDiff: () => ({
          status: 0,
          stdout: "client/src/lib/pkg/leaf.ts\n",
        }),
        readFile: (p: string) => virtualFs.get(p) ?? "",
        fileExists: () => true,
        verifyCheckoutMatchesSha: () => ({ ok: true }),
      }),
    ).toEqual(["client/src/mod/entry.test.ts"]);

    expect(
      collectModifiedUnitTestsForPush({
        stdinEntries: pushedStdin,
        unitConfigText: 'include: ["client/src/mod/entry.test.ts"]',
        runDiff: () => ({
          status: 0,
          stdout: "D\tclient/src/lib/pkg/deletedLeaf.ts\n",
        }),
        readFile: (p: string) => virtualFs.get(p) ?? "",
        fileExists: () => true,
        verifyCheckoutMatchesSha: () => ({ ok: true }),
      }),
    ).toEqual(["client/src/mod/entry.test.ts"]);

    // Type-only import (import type { HugeRouter }) on intermediate module does not pull unrelatedLeaf.ts into runtime closure
    expect(
      collectModifiedUnitTestsForPush({
        stdinEntries: pushedStdin,
        unitConfigText: 'include: ["client/src/mod/entry.test.ts"]',
        runDiff: () => ({
          status: 0,
          stdout: "client/src/mod/unrelatedLeaf.ts\n",
        }),
        readFile: (p: string) => virtualFs.get(p) ?? "",
        fileExists: () => true,
        verifyCheckoutMatchesSha: () => ({ ok: true }),
      }),
    ).toEqual([]);

    // Unregistered node:test file (scripts/deploy.test.mjs) still selects its wrapper Vitest suite
    expect(
      collectModifiedUnitTestsForPush({
        stdinEntries: pushedStdin,
        unitConfigText:
          'include: ["scripts/__tests__/safeDeliveryProtocols.test.ts"]',
        runDiff: () => ({
          status: 0,
          stdout: "M\tscripts/deploy.test.mjs\n",
        }),
        fileExists: () => true,
        verifyCheckoutMatchesSha: () => ({ ok: true }),
      }),
    ).toEqual(["scripts/__tests__/safeDeliveryProtocols.test.ts"]);
  });

  it("يبقي CommissionGuide خارج شريط أدوات ListToolbar في CommissionPlans لمنع التمدد الأفقي (Codex P2)", () => {
    const source = readFileSync(
      resolve(root, "client/src/pages/CommissionPlans.tsx"),
      "utf8",
    );
    const guideIndex = source.indexOf("<CommissionGuide />");
    const toolbarIndex = source.indexOf("<ListToolbar");
    expect(guideIndex).toBeGreaterThan(-1);
    expect(toolbarIndex).toBeGreaterThan(guideIndex);
  });
});
