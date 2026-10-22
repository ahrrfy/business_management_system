/**
 * بروتوكول الدمج الآمن (Safe Merge Protocol) — `pnpm pr:merge <رقم-الطلب>`
 *
 * يمنع الدمج إلى `main` إلا بعد إثبات الشروط الخمسة معاً:
 * 1. الطلب مفتوح ويستهدف الفرع الأساسي `main` حصراً (`baseRefName === "main"`) وقابل للدمج بلا تعارض (`MERGEABLE`).
 * 2. البوّابات الإلزامية (`check-test-build` و`authz-guard` و`audit`) حاضرة ومكتملة بـ`SUCCESS`
 *    على رأس الفرع الحالي (`headRefOid`) — يمنع فخّ الأخضر الكاذب في `gh pr checks --watch`.
 * 3. صفر فحوصات معلّقة أو فاشلة في `statusCheckRollup`.
 * 4. جميع خيوط المراجعة (`reviewThreads`) محلولة صراحةً (`isResolved === true`) عبر جميع صفحات API.
 * 5. تثبيت عملية الدمج على `headRefOid` المتحقَّق منه عبر `--match-head-commit` دون أي تصعيد بـ`--admin`،
 *    والتحقق الفعلي بعد الأمر من وصول حالة الطلب إلى `MERGED` (وليس مجرد الإدراج في طابور دمج).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_CHECKS = ["check-test-build", "authz-guard", "audit"];
const ACCEPTABLE_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

function normalizeCheckEntry(item) {
  const name = String(item?.name ?? item?.context ?? "").trim();
  if (
    item?.__typename === "StatusContext" ||
    ("state" in (item ?? {}) && !("status" in (item ?? {})))
  ) {
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

export function flattenPaginatedReviewThreads(pagesPayload) {
  if (!Array.isArray(pagesPayload)) {
    const singleNodes =
      pagesPayload?.data?.repository?.pullRequest?.reviewThreads?.nodes;
    return Array.isArray(singleNodes) ? singleNodes : [];
  }
  const threads = [];
  for (const item of pagesPayload) {
    if (Array.isArray(item)) {
      threads.push(...item);
      continue;
    }
    const nodes = item?.data?.repository?.pullRequest?.reviewThreads?.nodes;
    if (Array.isArray(nodes)) {
      threads.push(...nodes);
      continue;
    }
    if (
      item &&
      typeof item === "object" &&
      ("isResolved" in item || "comments" in item || "body" in item)
    ) {
      threads.push(item);
    }
  }
  return threads;
}

export function buildMergeCommandArgs(prNumber, headRefOid) {
  const cleanPr = String(prNumber ?? "").trim();
  const cleanSha = String(headRefOid ?? "").trim();
  if (!cleanPr || !cleanSha) {
    throw new Error("يلزم رقم طلب الدمج وبصمة الالتزام (headRefOid) لتنفيذ الدمج الآمن.");
  }
  return [
    "pr",
    "merge",
    cleanPr,
    "--merge",
    "--delete-branch",
    "--match-head-commit",
    cleanSha,
  ];
}

export function verifyPostMergeState(postMergeView) {
  const state = String(postMergeView?.state ?? "").toUpperCase();
  const mergedAt = String(postMergeView?.mergedAt ?? "").trim();
  const mergeCommitOid = String(postMergeView?.mergeCommit?.oid ?? "").trim();
  if (state === "MERGED" && Boolean(mergedAt)) {
    return {
      merged: true,
      code: "OK",
      mergeCommitOid,
    };
  }
  return {
    merged: false,
    code: "PR_NOT_MERGED_YET",
    reason: `لم يكتمل دمج الطلب في main بعد (الحالة الحالية: ${state || "UNKNOWN"} — قد يكون في طابور الدمج). لا تنفّذ النشر الإنتاجي قبل اكتمال الدمج فعلياً.`,
  };
}

function normalizeReviewThreadEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const firstComment = Array.isArray(entry?.comments?.nodes)
    ? entry.comments.nodes[0]
    : entry;
  return {
    id: entry.id ?? firstComment?.databaseId ?? firstComment?.id ?? "unknown",
    isResolved: entry.isResolved === true,
    author:
      firstComment?.author?.login ??
      firstComment?.user?.login ??
      entry?.author?.login ??
      entry?.user?.login ??
      "unknown",
    path: entry.path ?? firstComment?.path ?? "",
    line:
      entry.line ??
      entry.originalLine ??
      firstComment?.line ??
      firstComment?.original_line ??
      null,
    body: String(firstComment?.body ?? entry?.body ?? "").slice(0, 240),
  };
}

export function evaluatePrMergeReadiness({
  prView,
  reviewThreads = null,
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
  const baseRefName = String(prView.baseRefName ?? "").trim();
  if (baseRefName !== "main") {
    return {
      ready: false,
      code: "PR_INVALID_BASE_BRANCH",
      reason: `طلب الدمج #${prView.number ?? "?"} يستهدف الفرع «${baseRefName || "غير معروف"}»؛ يُسمح بالدمج الآمن إلى الفرع الأساسي «main» حصراً.`,
    };
  }
  const headRefOid = String(prView.headRefOid ?? "").trim();
  if (!headRefOid) {
    return {
      ready: false,
      code: "PR_HEAD_SHA_MISSING",
      reason: `بصمة رأس الفرع (headRefOid) غير متوفرة لطلب الدمج #${prView.number ?? "?"}.`,
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

  if (!ackReviews) {
    const rawThreads =
      reviewThreads != null
        ? flattenPaginatedReviewThreads(reviewThreads)
        : flattenPaginatedReviewThreads(reviewComments);

    const normalizedThreads = rawThreads.map(normalizeReviewThreadEntry).filter(Boolean);
    const unresolved = normalizedThreads.filter((t) => !t.isResolved);

    if (unresolved.length > 0) {
      return {
        ready: false,
        code: "PR_UNADDRESSED_REVIEW_COMMENTS",
        reason: `توجد ${unresolved.length} خيوط مراجعة غير محلولة (unresolved) على طلب الدمج #${prView.number}. عالجها وأغلق الخيط (resolveReviewThread) قبل الدمج.`,
        unaddressedComments: unresolved,
      };
    }
  }

  return { ready: true, code: "OK", headRefOid };
}

export function runSafeMergeSelftest() {
  const baseGreenRollup = [
    { name: "audit", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "authz-guard", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "quality-build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "test-shard-1-of-8", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "check-test-build", status: "COMPLETED", conclusion: "SUCCESS" },
  ];

  // 1. Non-main base branch blocks merge
  const nonMainBaseRes = evaluatePrMergeReadiness({
    prView: {
      number: 99,
      state: "OPEN",
      baseRefName: "release/v1",
      mergeable: "MERGEABLE",
      headRefOid: "sha-1",
      statusCheckRollup: baseGreenRollup,
    },
  });
  assert.equal(nonMainBaseRes.ready, false);
  assert.equal(nonMainBaseRes.code, "PR_INVALID_BASE_BRANCH");

  // 2. Pending check blocks merge
  const pendingRes = evaluatePrMergeReadiness({
    prView: {
      number: 100,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-1",
      statusCheckRollup: [
        { name: "audit", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "authz-guard", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "test-shard-1-of-8", status: "IN_PROGRESS", conclusion: "" },
      ],
    },
  });
  assert.equal(pendingRes.ready, false);
  assert.equal(pendingRes.code, "PR_CI_PENDING");

  // 3. Missing check-test-build (false green snapshot) blocks merge
  const falseGreenRes = evaluatePrMergeReadiness({
    prView: {
      number: 101,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-1",
      statusCheckRollup: [
        { name: "audit", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "authz-guard", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
    },
  });
  assert.equal(falseGreenRes.ready, false);
  assert.equal(falseGreenRes.code, "PR_MISSING_REQUIRED_CHECK");

  // 4. Failed shard blocks merge
  const failedRes = evaluatePrMergeReadiness({
    prView: {
      number: 102,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-1",
      statusCheckRollup: [
        ...baseGreenRollup.slice(0, 3),
        { name: "test-shard-2-of-8", status: "COMPLETED", conclusion: "FAILURE" },
        { name: "check-test-build", status: "COMPLETED", conclusion: "FAILURE" },
      ],
    },
  });
  assert.equal(failedRes.ready, false);
  assert.equal(failedRes.code, "PR_CI_FAILED");

  // 5. Unresolved review thread blocks merge
  const unresolvedThreadRes = evaluatePrMergeReadiness({
    prView: {
      number: 103,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
    },
    reviewThreads: [
      {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "PRRT_1",
                    isResolved: false,
                    path: "client/src/pages/CommissionPlans.tsx",
                    line: 279,
                    comments: {
                      nodes: [
                        {
                          databaseId: 501,
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
  assert.equal(unresolvedThreadRes.ready, false);
  assert.equal(unresolvedThreadRes.code, "PR_UNADDRESSED_REVIEW_COMMENTS");

  // 6. Multi-page reviewThreads where all threads are resolved passes
  const resolvedMultiPageRes = evaluatePrMergeReadiness({
    prView: {
      number: 103,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
    },
    reviewThreads: [
      {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "PRRT_1",
                    isResolved: true,
                    path: "client/src/pages/CommissionPlans.tsx",
                    line: 279,
                    comments: {
                      nodes: [
                        {
                          databaseId: 501,
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
      {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "PRRT_2",
                    isResolved: true,
                    path: "scripts/safe-merge.mjs",
                    line: 324,
                    comments: {
                      nodes: [
                        {
                          databaseId: 502,
                          author: { login: "chatgpt-codex-connector" },
                          body: "Pin the merge to the validated head SHA",
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
  assert.equal(resolvedMultiPageRes.ready, true);
  assert.equal(resolvedMultiPageRes.code, "OK");

  // 7. Merge command args pin the validated headRefOid and never include --admin
  const mergeArgs = buildMergeCommandArgs(1530, "0bd1c2db9733578ae5ca4de6fd8d48883e503f02");
  assert.deepEqual(mergeArgs, [
    "pr",
    "merge",
    "1530",
    "--merge",
    "--delete-branch",
    "--match-head-commit",
    "0bd1c2db9733578ae5ca4de6fd8d48883e503f02",
  ]);
  assert.equal(mergeArgs.includes("--admin"), false);

  // 8. Post-merge verification rejects queued/open PRs and accepts only MERGED state
  assert.equal(verifyPostMergeState({ state: "OPEN", mergedAt: null }).merged, false);
  assert.equal(verifyPostMergeState({ state: "OPEN", mergedAt: null }).code, "PR_NOT_MERGED_YET");
  assert.equal(
    verifyPostMergeState({
      state: "MERGED",
      mergedAt: "2026-10-22T10:30:00Z",
      mergeCommit: { oid: "merged-sha-1" },
    }).merged,
    true,
  );

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

const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 1) {
            nodes {
              databaseId
              body
              author {
                login
              }
            }
          }
        }
      }
    }
  }
}
`.trim();

function fetchAllReviewThreads(prNumber) {
  return captureJson("gh", [
    "api",
    "graphql",
    "--paginate",
    "--slurp",
    "-F",
    "owner=ahrrfy",
    "-F",
    "name=business_management_system",
    "-F",
    `pr=${Number(prNumber)}`,
    "-f",
    `query=${REVIEW_THREADS_QUERY}`,
  ]);
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
    "number,state,baseRefName,headRefName,headRefOid,mergeStateStatus,mergeable,statusCheckRollup",
  );

  const prView = captureJson("gh", viewArgs);
  const reviewThreadsPages = fetchAllReviewThreads(prView.number);

  const decision = evaluatePrMergeReadiness({
    prView,
    reviewThreads: reviewThreadsPages,
    ackReviews,
  });

  if (!decision.ready) {
    console.error(`\n⛔ [${decision.code}] ${decision.reason}`);
    if (decision.unaddressedComments?.length) {
      console.error("\nخيوط المراجعة غير المحلولة:");
      for (const c of decision.unaddressedComments) {
        console.error(
          `  • [${c.author}] ${c.path}:${c.line ?? "?"} (${c.id}) — ${c.body.replace(/\r?\n/g, " ")}`,
        );
      }
    }
    process.exit(1);
  }

  console.log(
    `✓ طلب الدمج #${prView.number} (${prView.headRefOid.slice(0, 9)}) اجتاز جميع بوابات CI والمراجعة الآلية.`,
  );

  const mergeArgs = buildMergeCommandArgs(prView.number, prView.headRefOid);
  const mergeRes = spawnSync("gh", mergeArgs, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  if (mergeRes.status !== 0) {
    console.error(
      mergeRes.stderr?.trim() ||
        mergeRes.stdout?.trim() ||
        "⛔ فشل دمج الطلب وفق سياسة الفرع الأساسي؛ تحقق من تزامن الفرع وحل جميع خيوط المراجعة.",
    );
    process.exit(mergeRes.status ?? 1);
  }

  if (mergeRes.stdout?.trim()) {
    console.log(mergeRes.stdout.trim());
  }

  const postMergeView = captureJson("gh", [
    "pr",
    "view",
    String(prView.number),
    "--json",
    "state,mergedAt,mergeCommit",
  ]);
  const postMergeVerdict = verifyPostMergeState(postMergeView);
  if (!postMergeVerdict.merged) {
    console.error(`\n⛔ [${postMergeVerdict.code}] ${postMergeVerdict.reason}\n`);
    process.exit(1);
  }

  console.log(
    `✓ تم دمج الطلب #${prView.number} فعلياً في main (التزام الدمج: ${postMergeVerdict.mergeCommitOid ? postMergeVerdict.mergeCommitOid.slice(0, 9) : prView.headRefOid.slice(0, 9)}).`,
  );
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main();
}
