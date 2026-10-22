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
  flattenPaginatedReviewThreads,
  parseCodexReviewState,
  runAtomicRemediationCycle,
  verifyPostMergeCompletion,
  verifyPostMergeState,
} from "../safe-merge.mjs";

const root = process.cwd();

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
        comments: [{ body: "<!-- codex-review-state:v1 {corrupted} -->" }],
      },
    });
    expect(blockedByMalformedCodexComment.ready).toBe(false);
    expect(blockedByMalformedCodexComment.code).toBe(
      "PR_CODEX_REVIEW_STATE_INVALID",
    );

    const parsedNestedCodex = parseCodexReviewState([
      {
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

    const resolveArgs = buildResolveReviewThreadArgs("PRRT_4341514310");
    expect(resolveArgs).toContain("threadId=PRRT_4341514310");

    expect(verifyPostMergeState({ state: "OPEN", mergedAt: null }).merged).toBe(
      false,
    );
    expect(
      verifyPostMergeState({
        state: "MERGED",
        mergedAt: "2026-10-22T10:30:00Z",
        mergeCommit: { oid: "merged-sha-1" },
      }).merged,
    ).toBe(true);

    const queuedVerdict = verifyPostMergeCompletion(1530, "0bd1c2db9", {
      maxAttempts: 2,
      delayMs: 0,
      sleep: () => {},
      fetchPrState: () => ({
        number: 1530,
        state: "OPEN",
        isInMergeQueue: true,
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

    const resolvedThreadsLog: Array<{ threadId: string; sha: string }> = [];
    const cycleResult = await runAtomicRemediationCycle({
      prNumber: 1530,
      initialPrView: {
        number: 1530,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        headRefOid: "sha-initial",
        statusCheckRollup: greenRollup,
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
      initialPrView: {
        number: 1530,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        headRefOid: "sha-unfixed-1",
        statusCheckRollup: greenRollup,
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
        },
        reviewThreads: [{ id: "PRRT_101", isResolved: true }],
      }),
    });
    expect(staleRemoteResult.ready).toBe(false);
    expect(staleRemoteResult.code).toBe("REMEDIATION_REMOTE_HEAD_MISMATCH");
    expect(resolvedOnStaleRemote).toBe(false);

    const missingThreadIdsResult = await runAtomicRemediationCycle({
      prNumber: 1530,
      initialPrView: {
        number: 1530,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        headRefOid: "sha-unfixed-1",
        statusCheckRollup: greenRollup,
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
        },
        reviewThreads: [{ id: "PRRT_101", isResolved: false }],
      }),
    });
    expect(missingThreadIdsResult.ready).toBe(false);
    expect(missingThreadIdsResult.code).toBe(
      "REMEDIATION_MISSING_RESOLVED_THREADS",
    );
  });

  it("يرفض نتائج مراجعة Codex القديمة (Stale SHA) ويرتب إعادات الفحوصات المتداخلة حسب وقت البدء (startedAt)", () => {
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
            body: '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"old-head-sha-111","status":"completed"},"security_review":{"commit_sha":null,"status":null}} -->',
          },
        ],
      },
    });
    expect(staleCodexRes.ready).toBe(false);
    expect(staleCodexRes.code).toBe("PR_CODEX_REVIEW_STALE");

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
