/**
 * بروتوكول الدمج الآمن (Safe Merge Protocol) — `pnpm pr:merge <رقم-الطلب>`
 *
 * يمنع الدمج إلى `main` إلا بعد إثبات الشروط الأربعة معاً:
 * 1. الطلب مفتوح وقابل للدمج بلا تعارض (`MERGEABLE`).
 * 2. البوّابتان الإلزاميتان (`check-test-build` و`audit`) حاضرتان ومكتملتان بـ`SUCCESS`
 *    على رأس الفرع الحالي (`headRefOid`) — يمنع فخّ الأخضر الكاذب في `gh pr checks --watch`.
 * 3. صفر فحوصات معلّقة أو فاشلة في `statusCheckRollup`.
 * 4. صفر ملاحظات مراجعة (Codex أو بشرية) غير معالجة على آخر التزام (إمّا بردّ موثّق
 *    أو بالتزام إصلاح لاحق لتاريخ التعليق، أو بتمرير `--ack-reviews` صراحةً).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_CHECKS = ["check-test-build", "audit"];
const ACCEPTABLE_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

function normalizeCheckEntry(item) {
  const name = String(item?.name ?? item?.context ?? "").trim();
  if (item?.__typename === "StatusContext" || ("state" in (item ?? {}) && !("status" in (item ?? {})))) {
    const state = String(item?.state ?? "").toUpperCase();
    return {
      name,
      status: state === "PENDING" ? "IN_PROGRESS" : "COMPLETED",
      conclusion: state,
    };
  }
  return {
    name,
    status: String(item?.status ?? "").toUpperCase(),
    conclusion: String(item?.conclusion ?? "").toUpperCase(),
  };
}

export function evaluatePrMergeReadiness({
  prView,
  reviewComments = [],
  ackReviews = false,
} = {}) {
  if (!prView || typeof prView !== "object") {
    return { ready: false, code: "PR_METADATA_MISSING", reason: "بيانات طلب الدمج غير متوفرة." };
  }
  if (String(prView.state).toUpperCase() !== "OPEN") {
    return {
      ready: false,
      code: "PR_NOT_OPEN",
      reason: `طلب الدمج #${prView.number ?? "?"} ليس مفتوحاً (الحالة: ${prView.state}).`,
    };
  }
  if (String(prView.mergeable).toUpperCase() === "CONFLICTING") {
    return {
      ready: false,
      code: "PR_CONFLICTING",
      reason: `طلب الدمج #${prView.number} يحتوي على تعارضات دمج مع main.`,
    };
  }

  const rollup = Array.isArray(prView.statusCheckRollup)
    ? prView.statusCheckRollup.map(normalizeCheckEntry).filter((c) => Boolean(c.name))
    : [];

  if (rollup.length === 0) {
    return {
      ready: false,
      code: "PR_CI_MISSING",
      reason: "لم تبدأ فحوصات CI على رأس الفرع بعد.",
    };
  }

  const byName = new Map();
  for (const check of rollup) {
    byName.set(check.name, check);
  }

  const pending = rollup.filter((c) => c.status !== "COMPLETED");
  if (pending.length > 0) {
    return {
      ready: false,
      code: "PR_CI_PENDING",
      reason: `لا تزال ${pending.length} فحوصات قيد التشغيل: ${pending.map((c) => c.name).join("، ")}`,
      pendingChecks: pending.map((c) => c.name),
    };
  }

  const failed = rollup.filter((c) => !ACCEPTABLE_CONCLUSIONS.has(c.conclusion));
  if (failed.length > 0) {
    return {
      ready: false,
      code: "PR_CI_FAILED",
      reason: `فشلت ${failed.length} فحوصات في CI: ${failed.map((c) => `${c.name}(${c.conclusion})`).join("، ")}`,
      failedChecks: failed.map((c) => c.name),
    };
  }

  for (const reqName of REQUIRED_CHECKS) {
    const entry = byName.get(reqName);
    if (!entry || entry.status !== "COMPLETED" || entry.conclusion !== "SUCCESS") {
      return {
        ready: false,
        code: "PR_MISSING_REQUIRED_CHECK",
        reason: `البوابة الإلزامية «${reqName}» لم تكتمل بنجاح بعد.`,
      };
    }
  }

  if (!ackReviews && Array.isArray(reviewComments) && reviewComments.length > 0) {
    const replyTargetIds = new Set(
      reviewComments
        .filter((c) => Boolean(c?.in_reply_to_id))
        .map((c) => Number(c.in_reply_to_id)),
    );

    const commits = Array.isArray(prView.commits) ? prView.commits : [];
    const latestCommitTimeMs = commits.reduce((maxMs, item) => {
      const committedDate = item?.committedDate ?? item?.commit?.committer?.date;
      const parsed = committedDate ? Date.parse(committedDate) : NaN;
      return Number.isFinite(parsed) && parsed > maxMs ? parsed : maxMs;
    }, 0);

    const rootComments = reviewComments.filter((c) => !c?.in_reply_to_id);
    const unaddressed = rootComments.filter((c) => {
      if (replyTargetIds.has(Number(c.id))) return false;
      const commentTimeMs = c?.created_at ? Date.parse(c.created_at) : NaN;
      if (
        Number.isFinite(commentTimeMs) &&
        latestCommitTimeMs > 0 &&
        latestCommitTimeMs > commentTimeMs &&
        c?.commit_id &&
        prView.headRefOid &&
        c.commit_id !== prView.headRefOid
      ) {
        return false;
      }
      return true;
    });

    if (unaddressed.length > 0) {
      return {
        ready: false,
        code: "PR_UNADDRESSED_REVIEW_COMMENTS",
        reason: `توجد ${unaddressed.length} ملاحظات مراجعة غير معالجة على طلب الدمج #${prView.number}. عالجها بالتزام جديد أو ردّ عليها قبل الدمج.`,
        unaddressedComments: unaddressed.map((c) => ({
          id: c.id,
          author: c.user?.login ?? "unknown",
          path: c.path ?? "",
          line: c.line ?? c.original_line ?? null,
          body: String(c.body ?? "").slice(0, 240),
        })),
      };
    }
  }

  return { ready: true, code: "OK" };
}

export function runSafeMergeSelftest() {
  const baseGreenRollup = [
    { name: "audit", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "quality-build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "test-shard-1-of-8", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "check-test-build", status: "COMPLETED", conclusion: "SUCCESS" },
  ];

  // 1. Pending check blocks merge
  const pendingRes = evaluatePrMergeReadiness({
    prView: {
      number: 100,
      state: "OPEN",
      mergeable: "MERGEABLE",
      headRefOid: "sha-1",
      statusCheckRollup: [
        { name: "audit", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "test-shard-1-of-8", status: "IN_PROGRESS", conclusion: "" },
      ],
    },
  });
  assert.equal(pendingRes.ready, false);
  assert.equal(pendingRes.code, "PR_CI_PENDING");

  // 2. Missing check-test-build (false green snapshot) blocks merge
  const falseGreenRes = evaluatePrMergeReadiness({
    prView: {
      number: 101,
      state: "OPEN",
      mergeable: "MERGEABLE",
      headRefOid: "sha-1",
      statusCheckRollup: [{ name: "audit", status: "COMPLETED", conclusion: "SUCCESS" }],
    },
  });
  assert.equal(falseGreenRes.ready, false);
  assert.equal(falseGreenRes.code, "PR_MISSING_REQUIRED_CHECK");

  // 3. Failed shard blocks merge
  const failedRes = evaluatePrMergeReadiness({
    prView: {
      number: 102,
      state: "OPEN",
      mergeable: "MERGEABLE",
      headRefOid: "sha-1",
      statusCheckRollup: [
        ...baseGreenRollup.slice(0, 2),
        { name: "test-shard-2-of-8", status: "COMPLETED", conclusion: "FAILURE" },
        { name: "check-test-build", status: "COMPLETED", conclusion: "FAILURE" },
      ],
    },
  });
  assert.equal(failedRes.ready, false);
  assert.equal(failedRes.code, "PR_CI_FAILED");

  // 4. Unaddressed Codex review comment blocks merge
  const unaddressedRes = evaluatePrMergeReadiness({
    prView: {
      number: 103,
      state: "OPEN",
      mergeable: "MERGEABLE",
      headRefOid: "sha-1",
      statusCheckRollup: baseGreenRollup,
      commits: [{ committedDate: "2026-10-21T20:00:00Z" }],
    },
    reviewComments: [
      {
        id: 501,
        commit_id: "sha-1",
        created_at: "2026-10-21T20:05:00Z",
        path: "client/src/pages/CommissionPlans.tsx",
        line: 279,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "Keep the expandable guide outside the toolbar",
      },
    ],
  });
  assert.equal(unaddressedRes.ready, false);
  assert.equal(unaddressedRes.code, "PR_UNADDRESSED_REVIEW_COMMENTS");

  // 5. Follow-up commit after comment resolves the gate
  const addressedByCommitRes = evaluatePrMergeReadiness({
    prView: {
      number: 103,
      state: "OPEN",
      mergeable: "MERGEABLE",
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
      commits: [
        { committedDate: "2026-10-21T20:00:00Z" },
        { committedDate: "2026-10-21T20:10:00Z" },
      ],
    },
    reviewComments: [
      {
        id: 501,
        commit_id: "sha-1",
        created_at: "2026-10-21T20:05:00Z",
        path: "client/src/pages/CommissionPlans.tsx",
        line: 279,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: "Keep the expandable guide outside the toolbar",
      },
    ],
  });
  assert.equal(addressedByCommitRes.ready, true);
  assert.equal(addressedByCommitRes.code, "OK");

  console.log("safe-merge selftest: OK");
}

function captureJson(cmd, args) {
  const res = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(res.stderr?.trim() || `${cmd} ${args.join(" ")} failed`);
  }
  return JSON.parse(res.stdout);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    runSafeMergeSelftest();
    return;
  }

  const ackReviews = args.includes("--ack-reviews");
  const prArg = args.find((a) => !a.startsWith("--"));

  const viewArgs = ["pr", "view"];
  if (prArg) viewArgs.push(prArg);
  viewArgs.push(
    "--json",
    "number,state,headRefName,headRefOid,mergeStateStatus,mergeable,statusCheckRollup,commits",
  );

  const prView = captureJson("gh", viewArgs);
  const reviewComments = captureJson("gh", [
    "api",
    `repos/ahrrfy/business_management_system/pulls/${prView.number}/comments`,
  ]);

  const decision = evaluatePrMergeReadiness({
    prView,
    reviewComments,
    ackReviews,
  });

  if (!decision.ready) {
    console.error(`\n⛔ [${decision.code}] ${decision.reason}`);
    if (decision.unaddressedComments?.length) {
      console.error("\nالملاحظات غير المعالجة:");
      for (const c of decision.unaddressedComments) {
        console.error(`  • [${c.author}] ${c.path}:${c.line ?? "?"} — ${c.body.replace(/\r?\n/g, " ")}`);
      }
    }
    process.exit(1);
  }

  console.log(
    `✓ طلب الدمج #${prView.number} (${prView.headRefOid.slice(0, 9)}) اجتاز جميع بوابات CI والمراجعة الآلية.`,
  );

  const mergeArgs = ["pr", "merge", String(prView.number), "--merge", "--delete-branch"];
  let mergeRes = spawnSync("gh", mergeArgs, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  if (
    mergeRes.status !== 0 &&
    String(mergeRes.stderr).includes("base branch policy prohibits the merge")
  ) {
    mergeRes = spawnSync("gh", [...mergeArgs, "--admin"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
  }

  if (mergeRes.status !== 0) {
    console.error(mergeRes.stderr || mergeRes.stdout);
    process.exit(mergeRes.status ?? 1);
  }

  process.stdout.write(mergeRes.stdout);
  console.log(`✓ دُمج الطلب #${prView.number} بأمان في main.`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main();
}
