import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluatePrePushPolicy } from "../safe-push-guard.mjs";
import { evaluatePrMergeReadiness } from "../safe-merge.mjs";

const root = process.cwd();

describe("بروتوكولات الدفع الآمن والدمج الآمن والنشر الآمن", () => {
  it("يفعّل خطاف .husky/pre-push ويشغّل الاختبار الذاتي لحارس الدفع", () => {
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
        remoteRefs: ["refs/heads/fix/safe-branch"],
        currentBranch: "fix/safe-branch",
        env: {},
      }),
    ).toMatchObject({
      allowed: true,
      code: "OK",
    });
  });

  it("يفحص جاهزية الدمج الآمن ويمنع الدمج عند فشل CI أو وجود ملاحظات مراجعة غير معالجة", () => {
    const output = execFileSync(
      process.execPath,
      [resolve(root, "scripts/safe-merge.mjs"), "--selftest"],
      { encoding: "utf8" },
    );
    expect(output).toContain("safe-merge selftest: OK");

    const greenRollup = [
      { name: "audit", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "check-test-build", status: "COMPLETED", conclusion: "SUCCESS" },
    ];

    const blockedByReview = evaluatePrMergeReadiness({
      prView: {
        number: 1526,
        state: "OPEN",
        mergeable: "MERGEABLE",
        headRefOid: "7f60f09e78",
        statusCheckRollup: greenRollup,
        commits: [{ committedDate: "2026-10-21T20:14:00Z" }],
      },
      reviewComments: [
        {
          id: 4341514310,
          commit_id: "7f60f09e78",
          created_at: "2026-10-21T20:17:36Z",
          path: "client/src/pages/CommissionPlans.tsx",
          line: 279,
          user: { login: "chatgpt-codex-connector[bot]" },
          body: "Keep the expandable guide outside the toolbar",
        },
      ],
    });
    expect(blockedByReview.ready).toBe(false);
    expect(blockedByReview.code).toBe("PR_UNADDRESSED_REVIEW_COMMENTS");
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
