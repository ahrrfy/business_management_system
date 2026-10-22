import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectModifiedUnitTestsForPush,
  evaluatePrePushPolicy,
} from "../safe-push-guard.mjs";
import {
  buildMergeCommandArgs,
  evaluatePrMergeReadiness,
  verifyPostMergeState,
} from "../safe-merge.mjs";

const root = process.cwd();

describe("بروتوكولات الدفع الآمن والدمج الآمن والنشر الآمن", () => {
  it("يفعّل خطاف .husky/pre-push ويفحص الالتزامات المدفوعة فعلياً ويغلق آلياً عند غياب origin/main أو عدم تطابق الشجرة", () => {
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

    const diffedShas: string[] = [];
    const matched = collectModifiedUnitTestsForPush({
      stdinEntries: [
        {
          localRef: "refs/heads/fix/branch",
          localSha: "abc1234567890",
          remoteRef: "refs/heads/fix/branch",
          remoteSha: "0000000000000000000000000000000000000000",
        },
      ],
      unitConfigText: 'include: ["scripts/__tests__/safeDeliveryProtocols.test.ts"]',
      runDiff: (sha: string) => {
        diffedShas.push(sha);
        return {
          status: 0,
          stdout: "scripts/__tests__/safeDeliveryProtocols.test.ts\n",
        };
      },
      fileExists: () => true,
      headSha: "abc1234567890",
      trackedStatus: "",
    });
    expect(diffedShas).toEqual(["abc1234567890"]);
    expect(matched).toEqual(["scripts/__tests__/safeDeliveryProtocols.test.ts"]);

    expect(() =>
      collectModifiedUnitTestsForPush({
        stdinEntries: [
          {
            localRef: "refs/heads/fix/branch",
            localSha: "abc1234567890",
            remoteRef: "refs/heads/fix/branch",
            remoteSha: "0000000000000000000000000000000000000000",
          },
        ],
        unitConfigText: 'include: ["scripts/__tests__/safeDeliveryProtocols.test.ts"]',
        runDiff: () => ({ status: 128, stderr: "unknown revision origin/main" }),
        fileExists: () => true,
        headSha: "abc1234567890",
        trackedStatus: "",
      }),
    ).toThrow(/origin\/main/);
  });

  it("يفحص جاهزية الدمج الآمن ويشترط baseRefName=main ويثبّت --match-head-commit ويتحقق من حالة MERGED", () => {
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

    const mergeArgs = buildMergeCommandArgs(1530, "0bd1c2db9733578ae5ca4de6fd8d48883e503f02");
    expect(mergeArgs).toContain("--match-head-commit");
    expect(mergeArgs).toContain("0bd1c2db9733578ae5ca4de6fd8d48883e503f02");
    expect(mergeArgs).not.toContain("--admin");

    expect(verifyPostMergeState({ state: "OPEN", mergedAt: null }).merged).toBe(false);
    expect(
      verifyPostMergeState({
        state: "MERGED",
        mergedAt: "2026-10-22T10:35:00Z",
        mergeCommit: { oid: "abc" },
      }).merged,
    ).toBe(true);
  });

  it("يفحص خضرة بوابة CI قبل النشر الإنتاجي ويرفض الالتزامات غير المفحوصة أو الفاشلة", () => {
    const output = execFileSync(
      process.execPath,
      [resolve(root, "scripts/deploy.mjs"), "--selftest-ci-gate"],
      { encoding: "utf8" },
    );
    expect(output).toContain("deploy ci-gate selftest: OK");
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
