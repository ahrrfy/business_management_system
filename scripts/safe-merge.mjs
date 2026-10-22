/**
 * بروتوكول الدمج الآمن (Safe Merge Protocol) — `pnpm pr:merge [PR_NUMBER]`
 *
 * يمنع الدمج إلى `main` إلا بعد إثبات الشروط المُلزِمة معاً:
 * 1. الطلب مفتوح (`OPEN`)، غير مسودّة (`!isDraft`)، يستهدف الفرع `main` حصراً (`baseRefName === "main"`)،
 *    وقابل للدمج بلا تعارض (`MERGEABLE`) ومعرّف رأس الفرع (`headRefOid`) محدّد.
 * 2. البوّابات الإلزامية (`check-test-build` و`authz-guard` و`audit`) حاضرة ومكتملة بـ`SUCCESS`
 *    على رأس الفرع الحالي (`headRefOid`) — يمنع فخّ الأخضر الكاذب في `gh pr checks --watch`.
 * 3. صفر فحوصات معلّقة أو فاشلة في `statusCheckRollup`، وصفر مراجعة Codex قيد التشغيل.
 * 4. جميع خيوط المراجعة (`reviewThreads`) محلولة صراحةً (`isResolved === true`) عبر جميع صفحات API
 *    (لا يُعتبر مجرّد الردّ النصي أو وجود التزام لاحق حلّاً تلقائياً للخيط، ويُمنع التجاوز اليدوي).
 * 5. إذا وُجدت ملاحظات أو فشل، تُعالَج ذرّياً بالتزام مستقل وفحص محلّي ثم يُغلق الخيط وتُعاد دورة الفحص حتى الاخضرار التام.
 * 6. تثبيت عملية الدمج على `headRefOid` المتحقَّق منه عبر `--match-head-commit` دون أي تصعيد بـ`--admin`،
 *    والتحقق الفعلي بعد أمر الدمج من وصول حالة الطلب إلى `MERGED` في `main`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REQUIRED_CHECKS = ["check-test-build", "authz-guard", "audit"];
const ACCEPTABLE_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const IGNORED_DIAGNOSTIC_CHECKS = new Set([
  "diagnose",
  "CI Failure Diagnostics",
]);
const CODEX_STATE_MARKER = "codex-review-state:v1";
const CODEX_STATE_RE = /<!--\s*codex-review-state:v1\s*(\{[\s\S]*?\})\s*-->/;

function normalizeCheckEntry(item) {
  const name = String(item?.name ?? item?.context ?? "").trim();
  const timestamp = String(
    item?.completedAt ||
      item?.startedAt ||
      item?.createdAt ||
      item?.completed_at ||
      item?.started_at ||
      "",
  ).trim();
  const parsedTime = timestamp ? Date.parse(timestamp) : NaN;
  const timestampMs = Number.isFinite(parsedTime) ? parsedTime : NaN;
  const rawId = Number(item?.id ?? item?.databaseId ?? NaN);
  const id = Number.isFinite(rawId) ? rawId : NaN;

  if (
    item?.__typename === "StatusContext" ||
    ("state" in (item ?? {}) && !("status" in (item ?? {})))
  ) {
    const state = String(item?.state ?? "").toUpperCase();
    return {
      id,
      name,
      status:
        state === "PENDING" || state === "EXPECTED"
          ? "IN_PROGRESS"
          : "COMPLETED",
      conclusion: state,
      timestamp,
      timestampMs,
    };
  }
  return {
    id,
    name,
    status: String(item?.status ?? "").toUpperCase(),
    conclusion: String(item?.conclusion ?? "").toUpperCase(),
    timestamp,
    timestampMs,
  };
}

export function hasIncompleteReviewThreadsPagination(pagesPayload) {
  if (!pagesPayload) return false;
  if (!Array.isArray(pagesPayload)) {
    return (
      pagesPayload?.data?.repository?.pullRequest?.reviewThreads?.pageInfo
        ?.hasNextPage === true
    );
  }
  const pageObjects = [];
  const collectPageObjects = (items) => {
    for (const item of items) {
      if (Array.isArray(item)) {
        collectPageObjects(item);
      } else if (
        item &&
        typeof item === "object" &&
        item?.data?.repository?.pullRequest?.reviewThreads
      ) {
        pageObjects.push(item.data.repository.pullRequest.reviewThreads);
      }
    }
  };
  collectPageObjects(pagesPayload);
  if (pageObjects.length === 0) return false;
  const lastPage = pageObjects[pageObjects.length - 1];
  return lastPage?.pageInfo?.hasNextPage === true;
}

export function flattenPaginatedReviewThreads(pagesPayload) {
  if (!pagesPayload) return [];
  if (!Array.isArray(pagesPayload)) {
    const singleNodes =
      pagesPayload?.data?.repository?.pullRequest?.reviewThreads?.nodes;
    return Array.isArray(singleNodes) ? singleNodes : [];
  }
  const threads = [];
  for (const item of pagesPayload) {
    if (Array.isArray(item)) {
      threads.push(...flattenPaginatedReviewThreads(item));
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
    throw new Error(
      "يلزم رقم طلب الدمج وبصمة الالتزام (headRefOid) لتنفيذ الدمج الآمن.",
    );
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

export function buildResolveReviewThreadArgs(threadId) {
  const cleanId = String(threadId ?? "").trim();
  if (!cleanId) {
    throw new Error("معرّف خيط المراجعة (threadId) مطلوب لإغلاق الخيط.");
  }
  const mutation = `mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }`;
  return [
    "api",
    "graphql",
    "-F",
    `threadId=${cleanId}`,
    "-f",
    `query=${mutation}`,
  ];
}

const CODEX_RUNNING_STATUSES = new Set([
  "running",
  "pending",
  "in_progress",
  "queued",
]);
const CODEX_FAILED_STATUSES = new Set(["failed", "error"]);

function extractCodexEntries(codexState) {
  if (!codexState || typeof codexState !== "object") return [];
  const rawEntries = [
    {
      status: codexState.state ?? codexState.status,
      sha: codexState.sha ?? codexState.commit_sha,
    },
    {
      status: codexState.code_review?.status ?? codexState.code_review?.state,
      sha: codexState.code_review?.commit_sha ?? codexState.code_review?.sha,
    },
    {
      status:
        codexState.security_review?.status ?? codexState.security_review?.state,
      sha:
        codexState.security_review?.commit_sha ??
        codexState.security_review?.sha,
    },
  ];
  return rawEntries
    .filter(
      (e) =>
        e.status !== null &&
        e.status !== undefined &&
        String(e.status).trim() !== "",
    )
    .map((e) => ({
      status: String(e.status).trim().toLowerCase(),
      sha:
        e.sha !== null && e.sha !== undefined && String(e.sha).trim() !== ""
          ? String(e.sha).trim()
          : null,
    }));
}

function selectPrimaryCodexEntry(codexState) {
  const entries = extractCodexEntries(codexState);
  const invalidEntry = entries.find((e) => e.status === "invalid");
  const runningEntry = entries.find((e) =>
    CODEX_RUNNING_STATUSES.has(e.status),
  );
  const failedEntry = entries.find((e) => CODEX_FAILED_STATUSES.has(e.status));
  const primary =
    invalidEntry ?? runningEntry ?? failedEntry ?? entries[0] ?? null;
  const fallbackSha =
    entries.find((e) => e.sha)?.sha ??
    codexState?.sha ??
    codexState?.commit_sha ??
    codexState?.code_review?.commit_sha ??
    codexState?.security_review?.commit_sha ??
    null;
  return {
    entries,
    statuses: entries.map((e) => e.status),
    state: primary?.status ?? null,
    sha: primary?.sha ?? fallbackSha,
  };
}

export function parseCodexReviewState(prComments = []) {
  if (!Array.isArray(prComments) || prComments.length === 0) {
    return null;
  }
  let latest = null;
  for (const comment of prComments) {
    const body = String(comment?.body ?? "");
    if (!body.includes(CODEX_STATE_MARKER)) continue;
    const match = body.match(CODEX_STATE_RE);
    if (!match) {
      latest = { state: "invalid", raw: body.slice(0, 160) };
      continue;
    }
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const selected = selectPrimaryCodexEntry(parsed);
        latest = {
          ...parsed,
          ...(selected.state !== null ? { state: selected.state } : {}),
          ...(selected.sha !== null ? { sha: selected.sha } : {}),
        };
      } else {
        latest = { state: "invalid", raw: body.slice(0, 160) };
      }
    } catch {
      latest = { state: "invalid", raw: body.slice(0, 160) };
    }
  }
  return latest;
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

function shouldReplaceCheckEntry(existing, candidate) {
  if (
    Number.isFinite(candidate.timestampMs) &&
    Number.isFinite(existing.timestampMs)
  ) {
    if (candidate.timestampMs > existing.timestampMs) return true;
    if (candidate.timestampMs < existing.timestampMs) return false;
  }
  if (candidate.status !== "COMPLETED" && existing.status === "COMPLETED") {
    return true;
  }
  if (candidate.status === "COMPLETED" && existing.status !== "COMPLETED") {
    return false;
  }
  if (!ACCEPTABLE_CONCLUSIONS.has(candidate.conclusion)) {
    return true;
  }
  if (
    Number.isFinite(candidate.id) &&
    Number.isFinite(existing.id) &&
    candidate.id !== existing.id
  ) {
    return candidate.id > existing.id;
  }
  return false;
}

export function evaluatePrMergeReadiness({
  prView,
  reviewThreads = null,
  reviewComments = [],
} = {}) {
  if (!prView || typeof prView !== "object") {
    return {
      ready: false,
      code: "PR_METADATA_MISSING",
      reason: "بيانات طلب الدمج غير متوفرة.",
    };
  }
  if (String(prView.state ?? "").toUpperCase() !== "OPEN") {
    return {
      ready: false,
      code: "PR_NOT_OPEN",
      reason: `طلب الدمج #${prView.number ?? "?"} ليس مفتوحاً (الحالة: ${prView.state}).`,
    };
  }
  const mergeStateStatus = String(prView.mergeStateStatus ?? "").toUpperCase();
  if (prView.isDraft === true || mergeStateStatus === "DRAFT") {
    return {
      ready: false,
      code: "PR_IS_DRAFT",
      reason: `طلب الدمج #${prView.number ?? "?"} لا يزال مسودّة (Draft) ولا يجوز دمجه.`,
    };
  }
  const baseRefName = String(prView.baseRefName ?? "").trim();
  if (baseRefName !== "main") {
    return {
      ready: false,
      code: "PR_INVALID_BASE_BRANCH",
      reason: `طلب الدمج #${prView.number ?? "?"} يستهدف الفرع «${baseRefName || "غير محدد"}» بدلاً من الفرع المحمي «main».`,
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

  const mergeable = String(prView.mergeable ?? "").toUpperCase();
  if (
    mergeable === "CONFLICTING" ||
    mergeable === "DIRTY" ||
    mergeStateStatus === "DIRTY"
  ) {
    return {
      ready: false,
      code: "PR_CONFLICTING",
      reason: `طلب الدمج #${prView.number} يحتوي على تعارضات دمج مع main.`,
    };
  }
  if (mergeStateStatus === "BEHIND") {
    return {
      ready: false,
      code: "PR_BEHIND_BASE_BRANCH",
      reason: `طلب الدمج #${prView.number} متأخر عن الفرع الأساسي main (BEHIND)؛ يجب تحديث الفرع وإعادة فحصه قبل الدمج.`,
    };
  }
  if (mergeable !== "MERGEABLE" || mergeStateStatus === "UNKNOWN") {
    return {
      ready: false,
      code: "PR_MERGEABLE_UNKNOWN",
      reason: `حالة قابلية الدمج لطلب #${prView.number} غير محسومة بعد (${prView.mergeable ?? "UNKNOWN"})؛ أعد المحاولة بعد اكتمال حساب GitHub.`,
    };
  }

  const threadsPayload = reviewThreads != null ? reviewThreads : reviewComments;
  if (hasIncompleteReviewThreadsPagination(threadsPayload)) {
    return {
      ready: false,
      code: "PR_REVIEW_THREADS_PAGINATION_INCOMPLETE",
      reason: `بيانات خيوط المراجعة لطلب #${prView.number} غير مكتملة (hasNextPage=true)؛ يجب جلب جميع الصفحات قبل الحكم على جاهزية الدمج.`,
    };
  }

  const rawThreads = flattenPaginatedReviewThreads(threadsPayload);
  const normalizedThreads = rawThreads
    .map(normalizeReviewThreadEntry)
    .filter(Boolean);
  const unresolved = normalizedThreads.filter((t) => !t.isResolved);
  const unaddressedExtras =
    unresolved.length > 0 ? { unaddressedComments: unresolved } : {};

  const rollup = Array.isArray(prView.statusCheckRollup)
    ? prView.statusCheckRollup
        .map(normalizeCheckEntry)
        .filter(
          (c) => Boolean(c.name) && !IGNORED_DIAGNOSTIC_CHECKS.has(c.name),
        )
    : [];

  if (rollup.length === 0) {
    return {
      ready: false,
      code: "PR_CI_MISSING",
      reason: "لم تبدأ فحوصات CI على رأس الفرع بعد.",
      ...unaddressedExtras,
    };
  }

  const byName = new Map();
  for (const check of rollup) {
    const existing = byName.get(check.name);
    if (!existing || shouldReplaceCheckEntry(existing, check)) {
      byName.set(check.name, check);
    }
  }

  const deduplicatedChecks = Array.from(byName.values());
  const pending = deduplicatedChecks.filter((c) => c.status !== "COMPLETED");
  if (pending.length > 0) {
    return {
      ready: false,
      code: "PR_CI_PENDING",
      reason: `لا تزال ${pending.length} فحوصات قيد التشغيل: ${pending.map((c) => c.name).join("، ")}`,
      pendingChecks: pending.map((c) => c.name),
      ...unaddressedExtras,
    };
  }

  const failed = deduplicatedChecks.filter(
    (c) => !ACCEPTABLE_CONCLUSIONS.has(c.conclusion),
  );
  if (failed.length > 0) {
    return {
      ready: false,
      code: "PR_CI_FAILED",
      reason: `فشلت ${failed.length} فحوصات في CI: ${failed.map((c) => `${c.name}(${c.conclusion})`).join("، ")}`,
      failedChecks: failed.map((c) => c.name),
      ...unaddressedExtras,
    };
  }

  for (const reqName of REQUIRED_CHECKS) {
    const entry = byName.get(reqName);
    if (
      !entry ||
      entry.status !== "COMPLETED" ||
      entry.conclusion !== "SUCCESS"
    ) {
      return {
        ready: false,
        code: "PR_MISSING_REQUIRED_CHECK",
        reason: `البوابة الإلزامية «${reqName}» لم تكتمل بنجاح بعد.`,
        ...unaddressedExtras,
      };
    }
  }

  const codexState = parseCodexReviewState(prView.comments);
  const selectedCodex = selectPrimaryCodexEntry(codexState);
  const codexSha = String(selectedCodex.sha ?? "").trim();
  const codexDisplaySha = codexSha
    ? codexSha.slice(0, 9)
    : headRefOid.slice(0, 9);
  if (selectedCodex.statuses.includes("invalid")) {
    return {
      ready: false,
      code: "PR_CODEX_REVIEW_STATE_INVALID",
      reason: `تعذّر تحليل حالة مراجعة Codex الآلية على طلب #${prView.number} (بيانات الحالة تالفة).`,
      ...unaddressedExtras,
    };
  }
  if (selectedCodex.statuses.some((s) => CODEX_RUNNING_STATUSES.has(s))) {
    return {
      ready: false,
      code: "PR_CODEX_REVIEW_RUNNING",
      reason: `مراجعة Codex الآلية لا تزال قيد التشغيل على الالتزام (${codexDisplaySha})؛ انتظر انتهاءها قبل الدمج.`,
      ...unaddressedExtras,
    };
  }
  if (selectedCodex.statuses.some((s) => CODEX_FAILED_STATUSES.has(s))) {
    return {
      ready: false,
      code: "PR_CODEX_REVIEW_FAILED",
      reason: `فشلت مراجعة Codex الآلية على الالتزام (${codexDisplaySha})؛ أعد تشغيل المراجعة أو تحقّق من سبب الفشل قبل الدمج.`,
      ...unaddressedExtras,
    };
  }

  if (unresolved.length > 0) {
    return {
      ready: false,
      code: "PR_UNADDRESSED_REVIEW_COMMENTS",
      reason: `توجد ${unresolved.length} خيوط مراجعة غير محلولة (unresolved) على طلب الدمج #${prView.number}. عالجها ذرّياً وأغلق الخيط (resolveReviewThread) قبل الدمج.`,
      unaddressedComments: unresolved,
    };
  }

  const reviewDecision = String(prView.reviewDecision ?? "").toUpperCase();
  if (reviewDecision === "CHANGES_REQUESTED") {
    return {
      ready: false,
      code: "PR_CHANGES_REQUESTED",
      reason: `طلب الدمج #${prView.number} عليه طلب تعديلات صريح (CHANGES_REQUESTED).`,
    };
  }
  if (reviewDecision === "REVIEW_REQUIRED") {
    return {
      ready: false,
      code: "PR_REVIEW_REQUIRED",
      reason: `طلب الدمج #${prView.number} يتطلّب مراجعة معتمدة (REVIEW_REQUIRED) قبل الدمج.`,
    };
  }
  if (mergeStateStatus === "BLOCKED") {
    return {
      ready: false,
      code: "PR_BLOCKED_BY_PROTECTION",
      reason: `طلب الدمج #${prView.number} محجوب بواسطة قواعد حماية الفرع الأساسي (BLOCKED).`,
    };
  }

  return { ready: true, code: "OK", headRefOid };
}

export function verifyPostMergeState(postMergeView, expectedHeadRefOid = "") {
  const state = String(postMergeView?.state ?? "").toUpperCase();
  const mergedAt = String(postMergeView?.mergedAt ?? "").trim();
  const mergeCommitOid = String(postMergeView?.mergeCommit?.oid ?? "").trim();
  const actualHeadRefOid = String(postMergeView?.headRefOid ?? "").trim();
  const expectedSha = String(expectedHeadRefOid ?? "").trim();

  if (state === "MERGED" && Boolean(mergedAt || mergeCommitOid)) {
    if (expectedSha && actualHeadRefOid && actualHeadRefOid !== expectedSha) {
      return {
        merged: false,
        code: "PR_POST_MERGE_SHA_MISMATCH",
        reason: `تم دمج الطلب على بصمة (${actualHeadRefOid}) مختلفة عن البصمة المتحقَّق منها (${expectedSha}).`,
      };
    }
    return {
      merged: true,
      code: "OK",
      mergeCommitOid: mergeCommitOid || null,
      mergedAt: mergedAt || null,
    };
  }
  if (postMergeView?.isInMergeQueue === true) {
    return {
      merged: false,
      code: "PR_QUEUED_NOT_MERGED_YET",
      reason:
        "أُدرج طلب الدمج في طابور الدمج (Merge Queue) لكنه لم يُدمج في main بعد؛ لا تبدأ النشر حتى تصبح حالته MERGED.",
    };
  }
  if (state === "CLOSED") {
    return {
      merged: false,
      code: "PR_CLOSED_WITHOUT_MERGE",
      reason: "أُغلق طلب الدمج دون دمجه في main.",
    };
  }
  return {
    merged: false,
    code: "PR_NOT_MERGED_YET",
    reason: `لم يكتمل دمج الطلب في main بعد (الحالة الحالية: ${state || "UNKNOWN"} — قد يكون في طابور الدمج). لا تنفّذ النشر الإنتاجي قبل اكتمال الدمج فعلياً.`,
  };
}

function defaultSleep(ms) {
  if (!ms || ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

export function verifyPostMergeCompletion(
  prNumber,
  expectedHeadRefOid,
  { fetchPrState, maxAttempts = 12, delayMs = 2500, sleep = defaultSleep } = {},
) {
  if (typeof fetchPrState !== "function") {
    throw new Error("دالة fetchPrState مطلوبة للتحقق من اكتمال الدمج.");
  }

  let lastState = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastState = fetchPrState(prNumber);
    const state = String(lastState?.state ?? "").toUpperCase();
    const mergedAt = String(lastState?.mergedAt ?? "").trim();
    const mergeCommitOid = String(lastState?.mergeCommit?.oid ?? "").trim();
    const actualHeadRefOid = String(lastState?.headRefOid ?? "").trim();
    const isInMergeQueue = lastState?.isInMergeQueue === true;

    if (state === "MERGED" && (mergedAt || mergeCommitOid)) {
      if (
        expectedHeadRefOid &&
        actualHeadRefOid &&
        actualHeadRefOid !== expectedHeadRefOid
      ) {
        return {
          merged: false,
          code: "PR_POST_MERGE_SHA_MISMATCH",
          reason: `تم دمج الطلب #${prNumber} على بصمة (${actualHeadRefOid}) مختلفة عن البصمة المتحقَّق منها (${expectedHeadRefOid}).`,
        };
      }
      return {
        merged: true,
        code: "MERGED",
        mergeCommitOid: mergeCommitOid || null,
        mergedAt: mergedAt || null,
        attempts: attempt,
      };
    }

    if (state === "CLOSED") {
      return {
        merged: false,
        code: "PR_CLOSED_WITHOUT_MERGE",
        reason: `أُغلق طلب الدمج #${prNumber} دون دمجه في main.`,
      };
    }

    if (attempt < maxAttempts) {
      if (!isInMergeQueue && attempt >= 3) {
        break;
      }
      sleep(delayMs);
    }
  }

  if (lastState?.isInMergeQueue === true) {
    return {
      merged: false,
      code: "PR_QUEUED_NOT_MERGED_YET",
      reason: `أُدرج طلب الدمج #${prNumber} في طابور الدمج (Merge Queue) لكنه لم يُدمج في main بعد؛ لا تبدأ النشر حتى تصبح حالته MERGED.`,
    };
  }

  return {
    merged: false,
    code: "PR_NOT_MERGED_AFTER_COMMAND",
    reason: `انتهى أمر الدمج لطلب #${prNumber} لكن حالة الطلب على GitHub لا تزال «${lastState?.state ?? "UNKNOWN"}» ولم يُدمج فعلياً في main.`,
  };
}

function defaultVerifyLocalGates() {
  const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  for (const scriptName of ["check", "check:guards"]) {
    const res = spawnSync(pnpmCmd, [scriptName], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    if (res.status !== 0) {
      return {
        ok: false,
        reason: `فشل الفحص المحلّي «pnpm ${scriptName}» بعد الالتزام الذرّي.`,
      };
    }
  }
  return { ok: true };
}

/**
 * ينفّذ دورة الإصلاح الذرّي وإعادة الفحص (Atomic Remediation & Re-check Cycle):
 * إذا وجدت البوّابة ملاحظات مراجعة أو فشل فحوصات، يُصلحها العامل ذرّياً في التزام جديد
 * (أو سلسلة التزامات ذرّية مستقلّة لكل ملاحظة)، يتحقق من البوّابات المحلّية، يغلق الخيوط
 * التي عولجت في ذلك الالتزام، ويتأكد من تحديث رأس الفرع عن بُعد إلى الالتزام الجديد
 * ثم يعيد الفحص حتى تصبح جميع البوّابات خضراء تماماً قبل السماح بالدمج.
 */
export async function runAtomicRemediationCycle({
  prNumber,
  initialPrView,
  initialReviewThreads = [],
  remediateAndCommit,
  resolveThread,
  verifyLocalGates = defaultVerifyLocalGates,
  fetchLatestState,
  maxCycles = 5,
} = {}) {
  let currentPrView = initialPrView;
  let currentThreads = initialReviewThreads;
  const seenHeadOids = new Set(
    [String(initialPrView?.headRefOid ?? "").trim()].filter(Boolean),
  );

  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    const decision = evaluatePrMergeReadiness({
      prView: currentPrView,
      reviewThreads: currentThreads,
    });

    if (decision.ready) {
      return {
        ready: true,
        cycles: cycle - 1,
        headRefOid: decision.headRefOid,
        decision,
      };
    }

    const isPendingOnly =
      decision.code === "PR_CI_PENDING" ||
      decision.code === "PR_CODEX_REVIEW_RUNNING" ||
      decision.code === "PR_MERGEABLE_UNKNOWN";

    if (isPendingOnly) {
      if (typeof fetchLatestState !== "function" || cycle === maxCycles) {
        return {
          ready: false,
          cycles: cycle,
          code: decision.code,
          reason: decision.reason,
          decision,
        };
      }
      const nextState = await fetchLatestState({ prNumber, cycle, decision });
      currentPrView = nextState?.prView;
      currentThreads = nextState?.reviewThreads;
      continue;
    }

    const isRemediable =
      decision.code === "PR_UNADDRESSED_REVIEW_COMMENTS" ||
      decision.code === "PR_CI_FAILED" ||
      decision.code === "PR_MISSING_REQUIRED_CHECK";

    if (!isRemediable || typeof remediateAndCommit !== "function") {
      return {
        ready: false,
        cycles: cycle,
        code: decision.code,
        reason: decision.reason,
        decision,
      };
    }

    if (typeof verifyLocalGates !== "function") {
      return {
        ready: false,
        cycles: cycle,
        code: "REMEDIATION_LOCAL_GATES_FAILED",
        reason:
          "دالّة التحقق من البوّابات المحلّية (verifyLocalGates) مطلوبة ولا يجوز تعطيلها.",
      };
    }

    const previousHeadOid = String(currentPrView?.headRefOid ?? "").trim();
    if (previousHeadOid) {
      seenHeadOids.add(previousHeadOid);
    }

    const remediation = await remediateAndCommit({
      cycle,
      prNumber,
      decision,
      prView: currentPrView,
      reviewThreads: currentThreads,
    });

    const atomicSteps =
      Array.isArray(remediation?.atomicCommits) &&
      remediation.atomicCommits.length > 0
        ? remediation.atomicCommits
        : [remediation];

    let latestCommitSha = "";
    for (const step of atomicSteps) {
      const stepSha = String(step?.newHeadRefOid ?? "").trim();
      if (!stepSha || seenHeadOids.has(stepSha)) {
        return {
          ready: false,
          cycles: cycle,
          code: "REMEDIATION_MISSING_ATOMIC_COMMIT",
          reason:
            "يجب معالجة الملاحظات بالتزام ذرّي جديد ومستقل (newHeadRefOid) لم يُستخدم من قبل قبل إغلاق خيوط المراجعة وإعادة الفحص.",
        };
      }
      seenHeadOids.add(stepSha);
      latestCommitSha = stepSha;

      const localGateRes = await verifyLocalGates({
        cycle,
        newHeadRefOid: stepSha,
        decision,
      });
      if (!localGateRes || localGateRes.ok !== true) {
        return {
          ready: false,
          cycles: cycle,
          code: "REMEDIATION_LOCAL_GATES_FAILED",
          reason:
            localGateRes?.reason ||
            "فشلت البوّابات المحلّية (pnpm check / pnpm check:guards) بعد الإصلاح الذرّي.",
        };
      }

      const resolvedIds = Array.isArray(step?.resolvedThreadIds)
        ? step.resolvedThreadIds
        : atomicSteps.length === 1
          ? (decision.unaddressedComments ?? []).map((c) => c.id)
          : [];

      if (typeof resolveThread === "function" && resolvedIds.length > 0) {
        for (const threadId of resolvedIds) {
          await resolveThread(threadId, stepSha);
        }
      }
    }

    if (typeof fetchLatestState !== "function") {
      return {
        ready: false,
        cycles: cycle,
        code: "REMEDIATION_STATE_FETCHER_MISSING",
        reason:
          "يلزم توفير fetchLatestState لإعادة فحص البوّابات بعد الإصلاح الذرّي.",
      };
    }

    const updated = await fetchLatestState({
      prNumber,
      cycle,
      newHeadRefOid: latestCommitSha,
      decision,
    });
    const remoteHeadOid = String(updated?.prView?.headRefOid ?? "").trim();
    if (!remoteHeadOid || remoteHeadOid !== latestCommitSha) {
      return {
        ready: false,
        cycles: cycle,
        code: "REMEDIATION_REMOTE_HEAD_MISMATCH",
        reason: `بصمة رأس الفرع على GitHub (${remoteHeadOid || "غير متوفرة"}) لا تطابق الالتزام الذرّي الجديد (${latestCommitSha})؛ يجب دفع الالتزام الجديد والتحقق من فحوصاته عن بُعد قبل الدمج.`,
      };
    }

    currentPrView = updated.prView;
    currentThreads = updated.reviewThreads;
  }

  return {
    ready: false,
    cycles: maxCycles,
    code: "REMEDIATION_MAX_CYCLES_EXCEEDED",
    reason: `لم تصل جميع البوّابات إلى اللون الأخضر بعد استنفاد ${maxCycles} دورات إصلاح وإعادة فحص.`,
  };
}

export function runSafeMergeSelftest() {
  const baseGreenRollup = [
    { name: "audit", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "authz-guard", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "quality-build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "test-shard-1-of-8", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "check-test-build", status: "COMPLETED", conclusion: "SUCCESS" },
  ];

  // 1. Pending check blocks merge
  const pendingRes = evaluatePrMergeReadiness({
    prView: {
      number: 100,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-1",
      statusCheckRollup: [
        ...baseGreenRollup.slice(0, 3),
        { name: "test-shard-1-of-8", status: "IN_PROGRESS", conclusion: "" },
      ],
    },
  });
  assert.equal(pendingRes.ready, false);
  assert.equal(pendingRes.code, "PR_CI_PENDING");

  // 2. Missing required check-test-build gate blocks merge ("false green" protection)
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

  // 3. Failed shard blocks merge
  const failedRes = evaluatePrMergeReadiness({
    prView: {
      number: 102,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-1",
      statusCheckRollup: [
        ...baseGreenRollup.slice(0, 3),
        {
          name: "test-shard-2-of-8",
          status: "COMPLETED",
          conclusion: "FAILURE",
        },
        {
          name: "check-test-build",
          status: "COMPLETED",
          conclusion: "FAILURE",
        },
      ],
    },
  });
  assert.equal(failedRes.ready, false);
  assert.equal(failedRes.code, "PR_CI_FAILED");

  // 4. Non-main baseRefName blocks merge
  const wrongBaseRes = evaluatePrMergeReadiness({
    prView: {
      number: 103,
      state: "OPEN",
      baseRefName: "develop",
      mergeable: "MERGEABLE",
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
    },
  });
  assert.equal(wrongBaseRes.ready, false);
  assert.equal(wrongBaseRes.code, "PR_INVALID_BASE_BRANCH");

  // 5. Draft or unknown mergeable or running Codex review blocks merge
  const unknownMergeableRes = evaluatePrMergeReadiness({
    prView: {
      number: 104,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "UNKNOWN",
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
    },
  });
  assert.equal(unknownMergeableRes.ready, false);
  assert.equal(unknownMergeableRes.code, "PR_MERGEABLE_UNKNOWN");

  const codexRunningRes = evaluatePrMergeReadiness({
    prView: {
      number: 105,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
      comments: [
        {
          body: '<!-- codex-review-state:v1 {"sha":"sha-2","state":"running"} -->',
        },
      ],
    },
  });
  assert.equal(codexRunningRes.ready, false);
  assert.equal(codexRunningRes.code, "PR_CODEX_REVIEW_RUNNING");

  // 6. Unresolved review thread blocks merge even if it has replies or newer commits
  const unresolvedThreadRes = evaluatePrMergeReadiness({
    prView: {
      number: 106,
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

  // 7. Multi-page reviewThreads where all threads are resolved passes
  const resolvedMultiPageRes = evaluatePrMergeReadiness({
    prView: {
      number: 107,
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

  // 8. Merge command args pin the validated headRefOid and never include --admin
  const mergeArgs = buildMergeCommandArgs(
    1530,
    "0bd1c2db9733578ae5ca4de6fd8d48883e503f02",
  );
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

  // 9. Post-merge verification rejects queued/unmerged state and confirms actual MERGED state
  const queuedOnlyRes = verifyPostMergeCompletion(1530, "sha-2", {
    maxAttempts: 2,
    delayMs: 0,
    sleep: () => {},
    fetchPrState: () => ({
      number: 1530,
      state: "OPEN",
      isInMergeQueue: true,
      headRefOid: "sha-2",
    }),
  });
  assert.equal(queuedOnlyRes.merged, false);
  assert.equal(queuedOnlyRes.code, "PR_QUEUED_NOT_MERGED_YET");

  let pollCount = 0;
  const eventuallyMergedRes = verifyPostMergeCompletion(1530, "sha-2", {
    maxAttempts: 3,
    delayMs: 0,
    sleep: () => {},
    fetchPrState: () => {
      pollCount += 1;
      if (pollCount === 1) {
        return {
          number: 1530,
          state: "OPEN",
          isInMergeQueue: true,
          headRefOid: "sha-2",
        };
      }
      return {
        number: 1530,
        state: "MERGED",
        mergedAt: "2026-10-22T10:30:00Z",
        mergeCommit: { oid: "merged-sha-999" },
        headRefOid: "sha-2",
      };
    },
  });
  assert.equal(eventuallyMergedRes.merged, true);
  assert.equal(eventuallyMergedRes.code, "MERGED");
  assert.equal(eventuallyMergedRes.mergeCommitOid, "merged-sha-999");

  // 10. BEHIND or BLOCKED mergeStateStatus blocks merge
  const behindBranchRes = evaluatePrMergeReadiness({
    prView: {
      number: 108,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BEHIND",
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
    },
  });
  assert.equal(behindBranchRes.ready, false);
  assert.equal(behindBranchRes.code, "PR_BEHIND_BASE_BRANCH");

  const blockedBranchRes = evaluatePrMergeReadiness({
    prView: {
      number: 109,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
    },
  });
  assert.equal(blockedBranchRes.ready, false);
  assert.equal(blockedBranchRes.code, "PR_BLOCKED_BY_PROTECTION");

  // 11. Truncated reviewThreads pagination (hasNextPage: true on last page) blocks merge
  const truncatedPaginationRes = evaluatePrMergeReadiness({
    prView: {
      number: 110,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
    },
    reviewThreads: {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              nodes: [{ id: "PRRT_1", isResolved: true }],
            },
          },
        },
      },
    },
  });
  assert.equal(truncatedPaginationRes.ready, false);
  assert.equal(
    truncatedPaginationRes.code,
    "PR_REVIEW_THREADS_PAGINATION_INCOMPLETE",
  );

  // 12. Superseded StatusContext PENDING is replaced by newer SUCCESS
  const supersededContextRes = evaluatePrMergeReadiness({
    prView: {
      number: 111,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-2",
      statusCheckRollup: [
        ...baseGreenRollup,
        {
          context: "external/security-scan",
          state: "PENDING",
          createdAt: "2026-10-22T10:00:00Z",
        },
        {
          context: "external/security-scan",
          state: "SUCCESS",
          createdAt: "2026-10-22T10:05:00Z",
        },
      ],
    },
  });
  assert.equal(supersededContextRes.ready, true);
  assert.equal(supersededContextRes.code, "OK");

  // 13. Corrupted codex-review-state:v1 JSON blocks merge
  const corruptedCodexRes = evaluatePrMergeReadiness({
    prView: {
      number: 112,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
      comments: [{ body: "<!-- codex-review-state:v1 {broken-json} -->" }],
    },
  });
  assert.equal(corruptedCodexRes.ready, false);
  assert.equal(corruptedCodexRes.code, "PR_CODEX_REVIEW_STATE_INVALID");

  // 14. Nested codex-review-state:v1 (code_review/security_review) running/failed/completed states
  const nestedCodexRunningRes = evaluatePrMergeReadiness({
    prView: {
      number: 113,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "90fb9671d55713f186742f7757481427fef726bd",
      statusCheckRollup: baseGreenRollup,
      comments: [
        {
          body: '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"90fb9671d55713f186742f7757481427fef726bd","has_any_findings":false,"has_unresolved_findings":false,"status":"in_progress"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->',
        },
      ],
    },
  });
  assert.equal(nestedCodexRunningRes.ready, false);
  assert.equal(nestedCodexRunningRes.code, "PR_CODEX_REVIEW_RUNNING");

  const nestedCodexFailedRes = evaluatePrMergeReadiness({
    prView: {
      number: 114,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "90fb9671d55713f186742f7757481427fef726bd",
      statusCheckRollup: baseGreenRollup,
      comments: [
        {
          body: '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"90fb9671d55713f186742f7757481427fef726bd","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"},"security_review":{"commit_sha":"90fb9671d55713f186742f7757481427fef726bd","has_any_findings":false,"has_unresolved_findings":false,"status":"failed"}} -->',
        },
      ],
    },
  });
  assert.equal(nestedCodexFailedRes.ready, false);
  assert.equal(nestedCodexFailedRes.code, "PR_CODEX_REVIEW_FAILED");

  const nestedCodexCompletedRes = evaluatePrMergeReadiness({
    prView: {
      number: 115,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "90fb9671d55713f186742f7757481427fef726bd",
      statusCheckRollup: baseGreenRollup,
      comments: [
        {
          body: '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"90fb9671d55713f186742f7757481427fef726bd","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->',
        },
      ],
    },
  });
  assert.equal(nestedCodexCompletedRes.ready, true);
  assert.equal(nestedCodexCompletedRes.code, "OK");

  const mixedNestedCodexComment = [
    {
      body: '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"1111111110000000000000000000000000000000","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"},"security_review":{"commit_sha":"2222222220000000000000000000000000000000","has_any_findings":false,"has_unresolved_findings":false,"status":"in_progress"}} -->',
    },
  ];
  const parsedMixedCodex = parseCodexReviewState(mixedNestedCodexComment);
  assert.equal(parsedMixedCodex?.state, "in_progress");
  assert.equal(
    parsedMixedCodex?.sha,
    "2222222220000000000000000000000000000000",
  );
  const mixedNestedCodexRes = evaluatePrMergeReadiness({
    prView: {
      number: 115,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "2222222220000000000000000000000000000000",
      statusCheckRollup: baseGreenRollup,
      comments: mixedNestedCodexComment,
    },
  });
  assert.equal(mixedNestedCodexRes.ready, false);
  assert.equal(mixedNestedCodexRes.code, "PR_CODEX_REVIEW_RUNNING");
  assert.equal(mixedNestedCodexRes.reason.includes("222222222"), true);

  // 15. mergeStateStatus === "BLOCKED" does not mask pending/failed CI or unresolved review threads
  const blockedWithPendingCiRes = evaluatePrMergeReadiness({
    prView: {
      number: 116,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      headRefOid: "sha-2",
      statusCheckRollup: [
        ...baseGreenRollup.slice(0, 3),
        { name: "test-shard-1-of-8", status: "IN_PROGRESS", conclusion: "" },
      ],
    },
  });
  assert.equal(blockedWithPendingCiRes.ready, false);
  assert.equal(blockedWithPendingCiRes.code, "PR_CI_PENDING");

  const blockedWithFailedCiRes = evaluatePrMergeReadiness({
    prView: {
      number: 116,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      headRefOid: "sha-2",
      statusCheckRollup: [
        ...baseGreenRollup.slice(0, 3),
        {
          name: "test-shard-1-of-8",
          status: "COMPLETED",
          conclusion: "FAILURE",
        },
      ],
    },
  });
  assert.equal(blockedWithFailedCiRes.ready, false);
  assert.equal(blockedWithFailedCiRes.code, "PR_CI_FAILED");

  const blockedWithUnresolvedThreadRes = evaluatePrMergeReadiness({
    prView: {
      number: 117,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
    },
    reviewThreads: [{ id: "PRRT_99", isResolved: false, body: "Fix this" }],
  });
  assert.equal(blockedWithUnresolvedThreadRes.ready, false);
  assert.equal(
    blockedWithUnresolvedThreadRes.code,
    "PR_UNADDRESSED_REVIEW_COMMENTS",
  );

  // 16. Omitted baseRefName fails closed with PR_INVALID_BASE_BRANCH
  const missingBaseRes = evaluatePrMergeReadiness({
    prView: {
      number: 118,
      state: "OPEN",
      mergeable: "MERGEABLE",
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
    },
  });
  assert.equal(missingBaseRes.ready, false);
  assert.equal(missingBaseRes.code, "PR_INVALID_BASE_BRANCH");

  // 17. verifyPostMergeState direct helper compatibility
  assert.equal(
    verifyPostMergeState({ state: "OPEN", mergedAt: null }).merged,
    false,
  );
  assert.equal(
    verifyPostMergeState({ state: "OPEN", mergedAt: null }).code,
    "PR_NOT_MERGED_YET",
  );
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

function fetchPostMergePrState(prNumber) {
  return captureJson("gh", [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "number,state,mergedAt,mergeCommit,isInMergeQueue,headRefOid",
  ]);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    runSafeMergeSelftest();
    return;
  }

  if (args.includes("--ack-reviews")) {
    console.error(
      "\n⛔ [PR_ACK_REVIEWS_FORBIDDEN] لا يُسمح بتجاوز خيوط المراجعة عبر --ack-reviews؛ يجب إصلاح الملاحظات ذرّياً وإغلاق كل خيط (resolveReviewThread) قبل الدمج.\n",
    );
    process.exit(1);
  }

  const prArg = args.find((a) => !a.startsWith("--"));

  const viewArgs = ["pr", "view"];
  if (prArg) viewArgs.push(prArg);
  viewArgs.push(
    "--json",
    "number,state,isDraft,baseRefName,headRefName,headRefOid,mergeStateStatus,mergeable,reviewDecision,statusCheckRollup,comments",
  );

  let prView;
  let reviewThreadsPages;
  try {
    prView = captureJson("gh", viewArgs);
    prView.baseRefName = String(prView?.baseRefName ?? "");
    reviewThreadsPages = fetchAllReviewThreads(prView.number);
  } catch (error) {
    console.error(
      `\n⛔ [PR_FETCH_FAILED] تعذّر جلب بيانات طلب الدمج أو خيوط المراجعة: ${error?.message ?? error}\n`,
    );
    process.exit(1);
  }

  const decision = evaluatePrMergeReadiness({
    prView,
    reviewThreads: reviewThreadsPages,
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

  let postMergeVerification;
  try {
    postMergeVerification = verifyPostMergeCompletion(
      prView.number,
      prView.headRefOid,
      {
        fetchPrState: fetchPostMergePrState,
      },
    );
  } catch (error) {
    console.error(
      `\n⛔ [PR_POST_MERGE_VERIFY_FAILED] تعذّر التحقق من حالة الطلب بعد الدمج: ${error?.message ?? error}\n`,
    );
    process.exit(1);
  }

  if (!postMergeVerification.merged) {
    console.error(
      `\n⛔ [${postMergeVerification.code}] ${postMergeVerification.reason}\n`,
    );
    process.exit(1);
  }

  const mergeShaInfo = postMergeVerification.mergeCommitOid
    ? ` — التزام الدمج: ${postMergeVerification.mergeCommitOid.slice(0, 9)}`
    : "";
  console.log(
    `✓ تم التأكد من دمج الطلب #${prView.number} فعلياً في main (مثبّت على ${prView.headRefOid.slice(0, 9)}${mergeShaInfo}).`,
  );
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main();
}
