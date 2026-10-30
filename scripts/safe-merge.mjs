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

function parseIsoTimestampMs(raw) {
  const str = String(raw ?? "").trim();
  if (!str || str.startsWith("0001-01-01")) return NaN;
  const parsed = Date.parse(str);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : NaN;
}

function normalizeCheckEntry(item) {
  const name = String(item?.name ?? item?.context ?? "").trim();
  const startedAt = String(
    item?.startedAt ||
      item?.createdAt ||
      item?.started_at ||
      item?.created_at ||
      "",
  ).trim();
  const completedAt = String(
    item?.completedAt || item?.completed_at || "",
  ).trim();
  const timestamp = completedAt || startedAt;
  const startedAtMs = parseIsoTimestampMs(startedAt);
  const completedAtMs = parseIsoTimestampMs(completedAt);
  const timestampMs = Number.isFinite(startedAtMs)
    ? startedAtMs
    : completedAtMs;
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
      startedAtMs,
      completedAtMs,
      timestampMs,
    };
  }
  return {
    id,
    name,
    status: String(item?.status ?? "").toUpperCase(),
    conclusion: String(item?.conclusion ?? "").toUpperCase(),
    timestamp,
    startedAtMs,
    completedAtMs,
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

export function hasIncompleteIssueCommentsPagination(pagesPayload) {
  if (!pagesPayload) return false;
  if (!Array.isArray(pagesPayload)) {
    return (
      pagesPayload?.data?.repository?.pullRequest?.comments?.pageInfo
        ?.hasNextPage === true ||
      pagesPayload?.pageInfo?.hasNextPage === true
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
        item?.data?.repository?.pullRequest?.comments
      ) {
        pageObjects.push(item.data.repository.pullRequest.comments);
      } else if (
        item &&
        typeof item === "object" &&
        item?.pageInfo &&
        Array.isArray(item?.nodes)
      ) {
        pageObjects.push(item);
      }
    }
  };
  collectPageObjects(pagesPayload);
  if (pageObjects.length === 0) return false;
  const lastPage = pageObjects[pageObjects.length - 1];
  return lastPage?.pageInfo?.hasNextPage === true;
}

export function flattenPaginatedIssueComments(pagesPayload) {
  if (!pagesPayload) return [];
  if (!Array.isArray(pagesPayload)) {
    const singleNodes =
      pagesPayload?.data?.repository?.pullRequest?.comments?.nodes ??
      pagesPayload?.nodes;
    return Array.isArray(singleNodes) ? singleNodes : [];
  }
  const comments = [];
  for (const item of pagesPayload) {
    if (Array.isArray(item)) {
      comments.push(...flattenPaginatedIssueComments(item));
      continue;
    }
    const nodes =
      item?.data?.repository?.pullRequest?.comments?.nodes ??
      (Array.isArray(item?.nodes) ? item.nodes : null);
    if (Array.isArray(nodes)) {
      comments.push(...nodes);
      continue;
    }
    if (
      item &&
      typeof item === "object" &&
      ("body" in item || "author" in item || "user" in item)
    ) {
      comments.push(item);
    }
  }
  return comments;
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
    "--match-head-commit",
    cleanSha,
  ];
}

export function buildEnqueuePullRequestArgs(pullRequestId, headRefOid) {
  const cleanId = String(pullRequestId ?? "").trim();
  const cleanSha = String(headRefOid ?? "").trim();
  if (!cleanId || !cleanSha) {
    throw new Error(
      "يلزم معرّف العقدة لطلب الدمج (pullRequestId) وبصمة الالتزام (headRefOid) لإدراج الطلب في طابور الدمج.",
    );
  }
  const mutation =
    "mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) { enqueuePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid }) { mergeQueueEntry { id state } } }";
  return [
    "api",
    "graphql",
    "-F",
    `pullRequestId=${cleanId}`,
    "-F",
    `expectedHeadOid=${cleanSha}`,
    "-f",
    `query=${mutation}`,
  ];
}

export function selectMergeExecutionArgs({
  prNumber,
  pullRequestId,
  headRefOid,
  isMergeQueueEnabled = false,
  isInMergeQueue = false,
} = {}) {
  if (isMergeQueueEnabled === true) {
    if (isInMergeQueue === true) {
      return null;
    }
    return buildEnqueuePullRequestArgs(pullRequestId, headRefOid);
  }
  return buildMergeCommandArgs(prNumber, headRefOid);
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
const CODEX_COMPLETED_STATUSES = new Set(["completed", "success", "passed"]);

function doesCodexShaMatchHead(entrySha, headRefOid) {
  const cleanEntry = String(entrySha ?? "")
    .trim()
    .toLowerCase();
  const cleanHead = String(headRefOid ?? "")
    .trim()
    .toLowerCase();
  if (!cleanEntry || !cleanHead) return false;
  if (cleanEntry === cleanHead) return true;
  const minLen = Math.min(cleanEntry.length, cleanHead.length);
  if (minLen < 7) return false;
  return cleanHead.startsWith(cleanEntry) || cleanEntry.startsWith(cleanHead);
}

function extractCodexEntries(codexState) {
  if (!codexState || typeof codexState !== "object") return [];
  const hasNestedSubReviews = Boolean(
    (codexState.code_review && typeof codexState.code_review === "object") ||
    (codexState.security_review &&
      typeof codexState.security_review === "object"),
  );
  const rawEntries = hasNestedSubReviews
    ? [
        ...(String(codexState.state ?? "").toLowerCase() === "invalid"
          ? [{ status: "invalid", sha: codexState.sha ?? null }]
          : []),
        {
          status:
            codexState.code_review?.status ?? codexState.code_review?.state,
          sha:
            codexState.code_review?.commit_sha ?? codexState.code_review?.sha,
          hasUnresolvedFindings:
            codexState.code_review?.has_unresolved_findings === true ||
            codexState.code_review?.hasUnresolvedFindings === true,
        },
        {
          status:
            codexState.security_review?.status ??
            codexState.security_review?.state,
          sha:
            codexState.security_review?.commit_sha ??
            codexState.security_review?.sha,
          hasUnresolvedFindings:
            codexState.security_review?.has_unresolved_findings === true ||
            codexState.security_review?.hasUnresolvedFindings === true,
        },
      ]
    : [
        {
          status: codexState.state ?? codexState.status,
          sha: codexState.sha ?? codexState.commit_sha,
          hasUnresolvedFindings:
            codexState.has_unresolved_findings === true ||
            codexState.hasUnresolvedFindings === true,
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
      hasUnresolvedFindings: e.hasUnresolvedFindings === true,
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
    hasUnresolvedFindings: entries.some((e) => e.hasUnresolvedFindings === true),
  };
}

const TRUSTED_CODEX_BOT_LOGINS = new Set([
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
]);

function isTrustedCodexComment(comment) {
  const login = String(comment?.author?.login ?? comment?.user?.login ?? "")
    .trim()
    .toLowerCase();
  return TRUSTED_CODEX_BOT_LOGINS.has(login);
}

export function parseCodexReviewState(prComments = []) {
  if (hasIncompleteIssueCommentsPagination(prComments)) {
    return { state: "invalid", paginationIncomplete: true };
  }
  const flatComments = flattenPaginatedIssueComments(prComments);
  if (flatComments.length === 0) {
    return null;
  }
  let latest = null;
  for (const comment of flatComments) {
    if (!isTrustedCodexComment(comment)) continue;
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
          has_unresolved_findings: selected.hasUnresolvedFindings,
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

// Native reviews must come from the complete GraphQL connection, never a
// truncated `gh pr view --json reviews` list or a comment claiming approval.
function completeReviewConnectionNodes(payload, field) {
  const pages = Array.isArray(payload) ? payload.flat(Infinity) : [payload];
  if (pages.length === 0) return null;
  const nodes = [];
  let totalCount;
  for (const [index, page] of pages.entries()) {
    const connection = page?.data?.repository?.pullRequest?.[field];
    if (
      page?.errors?.length ||
      !connection ||
      !Array.isArray(connection.nodes) ||
      !Number.isSafeInteger(connection.totalCount) ||
      connection.totalCount < 0 ||
      (totalCount !== undefined && connection.totalCount !== totalCount) ||
      connection.pageInfo?.hasNextPage !== index < pages.length - 1 ||
      (index < pages.length - 1 && !connection.pageInfo?.endCursor)
    )
      return null;
    totalCount = connection.totalCount;
    nodes.push(...connection.nodes);
  }
  const ids = nodes.map((node) => node?.id);
  if (
    nodes.length !== totalCount ||
    ids.some((id) => typeof id !== "string" || !id) ||
    new Set(ids).size !== ids.length
  )
    return null;
  return nodes;
}

function parseNativeCodexReviewState(reviews) {
  const trusted = reviews.filter((review) =>
    TRUSTED_CODEX_BOT_LOGINS.has(
      String(review?.author?.login ?? "").toLowerCase(),
    ),
  );
  if (trusted.length === 0) return null;
  const pending = trusted.find((review) => review.state === "PENDING");
  if (pending)
    return { state: "running", sha: pending.commit?.oid, source: "native" };
  if (
    trusted.some(
      (review) =>
        !Number.isFinite(parseIsoTimestampMs(review.submittedAt)) ||
        !Number.isSafeInteger(review.databaseId),
    )
  )
    return { state: "invalid" };
  const latest = [...trusted].sort(
    (a, b) =>
      parseIsoTimestampMs(b.submittedAt) - parseIsoTimestampMs(a.submittedAt) ||
      b.databaseId - a.databaseId,
  )[0];
  return {
    source: "native",
    sha: latest.commit?.oid,
    state: ["APPROVED", "COMMENTED"].includes(latest.state)
      ? "completed"
      : ["CHANGES_REQUESTED", "DISMISSED"].includes(latest.state)
        ? "failed"
        : "invalid",
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

function shouldReplaceCheckEntry(existing, candidate) {
  if (
    Number.isFinite(candidate.startedAtMs) &&
    Number.isFinite(existing.startedAtMs) &&
    candidate.startedAtMs !== existing.startedAtMs
  ) {
    return candidate.startedAtMs > existing.startedAtMs;
  }
  if (
    Number.isFinite(candidate.id) &&
    Number.isFinite(existing.id) &&
    candidate.id !== existing.id
  ) {
    return candidate.id > existing.id;
  }
  if (
    !Number.isFinite(candidate.startedAtMs) &&
    !Number.isFinite(existing.startedAtMs) &&
    Number.isFinite(candidate.completedAtMs) &&
    Number.isFinite(existing.completedAtMs) &&
    candidate.completedAtMs !== existing.completedAtMs
  ) {
    return candidate.completedAtMs > existing.completedAtMs;
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
  return false;
}

export function evaluatePrMergeReadiness({
  prView,
  reviewThreads = null,
  reviewComments = [],
  issueComments = null,
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
  if (
    mergeStateStatus === "BEHIND" &&
    prView?.isMergeQueueEnabled !== true
  ) {
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

  const commentsPayload =
    issueComments != null ? issueComments : prView.comments;
  if (
    hasIncompleteIssueCommentsPagination(commentsPayload) ||
    prView?.commentsPageInfo?.hasNextPage === true
  ) {
    return {
      ready: false,
      code: "PR_ISSUE_COMMENTS_PAGINATION_INCOMPLETE",
      reason: `بيانات تعليقات طلب الدمج #${prView.number} غير مكتملة (hasNextPage=true)؛ يجب جلب جميع صفحات التعليقات قبل الاعتماد على حالة مراجعة Codex الآلية.`,
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

  let codexState = parseCodexReviewState(commentsPayload);
  // Explicit marker state remains authoritative, including stale/failing state.
  if (codexState === null && prView.nativeReviews != null) {
    const nativeReviews = completeReviewConnectionNodes(
      prView.nativeReviews,
      "reviews",
    );
    if (nativeReviews === null) {
      return {
        ready: false,
        code: "PR_NATIVE_REVIEWS_PAGINATION_INCOMPLETE",
        reason:
          "بيانات مراجعات GitHub الأصلية غير مكتملة أو تالفة؛ يجب جلب جميع الصفحات قبل الدمج.",
        ...unaddressedExtras,
      };
    }
    if (
      completeReviewConnectionNodes(threadsPayload, "reviewThreads") === null
    ) {
      return {
        ready: false,
        code: "PR_REVIEW_THREADS_PAGINATION_INCOMPLETE",
        reason:
          "يلزم إثبات جلب جميع خيوط المراجعة قبل اعتماد مراجعة Codex الأصلية.",
        ...unaddressedExtras,
      };
    }
    codexState = parseNativeCodexReviewState(nativeReviews);
  }
  if (codexState === null) {
    if (unresolved.length > 0) {
      return {
        ready: false,
        code: "PR_UNADDRESSED_REVIEW_COMMENTS",
        reason: `توجد ${unresolved.length} خيوط مراجعة غير محلولة (unresolved) على طلب الدمج #${prView.number}. عالجها ذرّياً وأغلق الخيط (resolveReviewThread) قبل الدمج.`,
        unaddressedComments: unresolved,
      };
    }
    return {
      ready: false,
      code: "PR_CODEX_REVIEW_MISSING",
      reason: `لم تُسجَّل حالة مراجعة Codex الآلية الموثوقة (chatgpt-codex-connector) على طلب #${prView.number} للالتزام (${headRefOid.slice(0, 9)}) بعد؛ انتظر بدء المراجعة واكتمالها قبل الدمج.`,
    };
  }

  const selectedCodex = selectPrimaryCodexEntry(codexState);
  const codexSha = String(selectedCodex.sha ?? "").trim();
  const codexDisplaySha = codexSha
    ? codexSha.slice(0, 9)
    : headRefOid.slice(0, 9);
  if (
    selectedCodex.entries.length === 0 ||
    selectedCodex.statuses.includes("invalid")
  ) {
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
  if (
    selectedCodex.entries.some((e) => !CODEX_COMPLETED_STATUSES.has(e.status))
  ) {
    return {
      ready: false,
      code: "PR_CODEX_REVIEW_STATE_INVALID",
      reason: `حالة مراجعة Codex الآلية غير معروفة على طلب #${prView.number}.`,
      ...unaddressedExtras,
    };
  }
  const staleCodexEntry = selectedCodex.entries.find((e) =>
    codexState.source === "native"
      ? !/^[a-f0-9]{40}$/.test(e.sha ?? "") || e.sha !== headRefOid
      : !doesCodexShaMatchHead(e.sha, headRefOid),
  );
  if (staleCodexEntry) {
    const staleShaLabel = staleCodexEntry.sha
      ? staleCodexEntry.sha.slice(0, 9)
      : "غير محدد";
    return {
      ready: false,
      code: "PR_CODEX_REVIEW_STALE",
      reason: `مراجعة Codex الآلية المكتملة مرتبطة بالالتزام (${staleShaLabel}) ولا تطابق رأس الفرع الحالي (${headRefOid.slice(0, 9)})؛ يجب انتظار أو تشغيل مراجعة Codex على الالتزام الحالي قبل الدمج.`,
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

  if (selectedCodex.entries.some((e) => e.hasUnresolvedFindings === true)) {
    return {
      ready: false,
      code: "PR_UNADDRESSED_REVIEW_COMMENTS",
      reason: `مراجعة Codex الآلية المكتملة على الالتزام (${codexDisplaySha}) لا تزال تبلّغ عن ملاحظات غير محلولة (has_unresolved_findings: true)؛ عالج الملاحظات بالتزام ذرّي جديد وأعد فحص المراجعة قبل الدمج.`,
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
  if (
    mergeStateStatus === "BLOCKED" &&
    prView?.isMergeQueueEnabled !== true
  ) {
    return {
      ready: false,
      code: "PR_BLOCKED_BY_PROTECTION",
      reason: `طلب الدمج #${prView.number} محجوب بواسطة قواعد حماية الفرع الأساسي (BLOCKED).`,
    };
  }

  return { ready: true, code: "OK", headRefOid };
}

export function shouldCleanupMergedHeadBranch(
  prView,
  expectedHeadRefOid = "",
) {
  const headRefName = String(prView?.headRefName ?? "").trim();
  if (!headRefName || headRefName === "main") {
    return false;
  }
  if (prView?.isCrossRepository !== false) {
    return false;
  }
  const ownerLogin = String(prView?.headRepositoryOwner?.login ?? "")
    .trim()
    .toLowerCase();
  const repoName = String(prView?.headRepository?.name ?? "")
    .trim()
    .toLowerCase();
  if (
    ownerLogin !== "ahrrfy" ||
    repoName !== "business_management_system"
  ) {
    return false;
  }
  const expectedSha = String(expectedHeadRefOid ?? "").trim();
  if (expectedSha) {
    const candidateHeadOid = String(prView?.headRefOid ?? "").trim();
    if (!candidateHeadOid || candidateHeadOid !== expectedSha) {
      return false;
    }
    if (prView?.headRef === null) {
      return false;
    }
    const liveRefOid = String(prView?.headRef?.target?.oid ?? "").trim();
    if (liveRefOid && liveRefOid !== expectedSha) {
      return false;
    }
  }
  return true;
}

export function buildMergedHeadRefDeleteEndpoint(headRefName) {
  const cleanRefName = String(headRefName ?? "").trim();
  return `repos/ahrrfy/business_management_system/git/refs/heads/${encodeURIComponent(cleanRefName)}`;
}

export function buildMergedHeadRefCleanupGitArgs(
  headRefName,
  expectedHeadRefOid,
) {
  const cleanRefName = String(headRefName ?? "").trim();
  const cleanSha = String(expectedHeadRefOid ?? "").trim();
  if (!cleanRefName || cleanRefName === "main") {
    throw new Error(
      "لا يجوز بناء أمر حذف لفرع فارغ أو للفرع المحمي main.",
    );
  }
  if (!cleanSha) {
    throw new Error(
      "يلزم تمرير البصمة المتحقَّق منها (expectedHeadRefOid) لحذف الفرع المدمج بأمان (--force-with-lease).",
    );
  }
  return [
    "push",
    "origin",
    `--force-with-lease=refs/heads/${cleanRefName}:${cleanSha}`,
    `:refs/heads/${cleanRefName}`,
  ];
}

const MERGE_QUEUE_PENDING_STATES = new Set([
  "QUEUED",
  "AWAITING_CHECKS",
  "LOCKED",
  "MERGEABLE",
]);

function isMergeQueuePendingState(postMergeView) {
  if (postMergeView?.isInMergeQueue === true) return true;
  const queueEntryState = String(postMergeView?.mergeQueueEntry?.state ?? "")
    .trim()
    .toUpperCase();
  if (MERGE_QUEUE_PENDING_STATES.has(queueEntryState)) {
    return true;
  }
  const mergeStateStatus = String(
    postMergeView?.mergeStateStatus ?? "",
  ).toUpperCase();
  return (
    mergeStateStatus === "QUEUED" || mergeStateStatus === "AWAITING_CHECKS"
  );
}

export function verifyPreMergeTargetState({
  prNumber,
  expectedHeadRefOid,
  fetchState,
} = {}) {
  if (typeof fetchState !== "function") {
    throw new Error(
      "دالة fetchState مطلوبة لإعادة التحقق من حالة الطلب والفرع الأساسي قبل الدمج.",
    );
  }
  const latest = fetchState(prNumber);
  const prView = latest?.prView ?? latest;
  const reviewThreads =
    latest?.reviewThreads !== undefined ? latest.reviewThreads : [];
  const issueComments =
    latest?.issueComments !== undefined ? latest.issueComments : null;
  const baseRefName = String(prView?.baseRefName ?? "").trim();
  if (baseRefName !== "main") {
    return {
      ok: false,
      code: "PR_INVALID_BASE_BRANCH",
      reason: `تم تغيير الفرع الأساسي لطلب الدمج #${prNumber} إلى «${baseRefName || "غير معروف"}» قبيل الدمج؛ يُسمح بالدمج في main فقط.`,
    };
  }
  const expectedSha = String(expectedHeadRefOid ?? "").trim();
  const actualHeadRefOid = String(prView?.headRefOid ?? "").trim();
  if (!expectedSha || actualHeadRefOid !== expectedSha) {
    return {
      ok: false,
      code: "PR_HEAD_MOVED_BEFORE_MERGE",
      reason: `تغيّر رأس طلب الدمج #${prNumber} إلى «${actualHeadRefOid || "غير معروف"}» قبيل الدمج ولا يطابق البصمة المتحقَّق منها (${expectedSha || "غير محددة"}).`,
    };
  }
  const readiness = evaluatePrMergeReadiness({
    prView,
    reviewThreads,
    issueComments,
  });
  if (!readiness.ready) {
    return {
      ok: false,
      code: readiness.code,
      reason: readiness.reason,
      decision: readiness,
    };
  }
  return {
    ok: true,
    code: "OK",
    baseRefName: "main",
    headRefOid: expectedSha,
    pullRequestId: String(prView?.id ?? "").trim() || null,
    isMergeQueueEnabled: prView?.isMergeQueueEnabled === true,
    isInMergeQueue: prView?.isInMergeQueue === true,
  };
}

export function verifyPostMergeState(postMergeView, expectedHeadRefOid = "") {
  const state = String(postMergeView?.state ?? "").toUpperCase();
  const mergedAt = String(postMergeView?.mergedAt ?? "").trim();
  const mergeCommitOid = String(postMergeView?.mergeCommit?.oid ?? "").trim();
  const actualHeadRefOid = String(postMergeView?.headRefOid ?? "").trim();
  const baseRefName = String(postMergeView?.baseRefName ?? "").trim();
  const expectedSha = String(expectedHeadRefOid ?? "").trim();

  if (baseRefName && baseRefName !== "main") {
    return {
      merged: false,
      code: "PR_INVALID_BASE_BRANCH",
      reason: `الفرع الأساسي لطلب الدمج هو «${baseRefName}» وليس main؛ لا يُعتمد الدمج خارج الفرع الرئيسي.`,
    };
  }

  if (state === "MERGED" && Boolean(mergedAt || mergeCommitOid)) {
    if (baseRefName !== "main") {
      return {
        merged: false,
        code: "PR_INVALID_BASE_BRANCH",
        reason: `لم يتم التحقق من أن الفرع الأساسي للدمج هو main (الحالي: «${baseRefName || "غير معروف"}»).`,
      };
    }
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
      baseRefName: "main",
      mergeCommitOid: mergeCommitOid || null,
      mergedAt: mergedAt || null,
    };
  }
  if (isMergeQueuePendingState(postMergeView)) {
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
  {
    fetchPrState,
    maxAttempts = 720,
    delayMs = 15_000,
    nonQueueMaxAttempts = 3,
    nonQueueDelayMs = 2500,
    sleep = defaultSleep,
  } = {},
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
    const baseRefName = String(lastState?.baseRefName ?? "").trim();
    const isInMergeQueue = isMergeQueuePendingState(lastState);

    if (baseRefName && baseRefName !== "main") {
      return {
        merged: false,
        code: "PR_INVALID_BASE_BRANCH",
        reason: `الفرع الأساسي لطلب الدمج #${prNumber} هو «${baseRefName}» وليس main؛ لا يُعتمد الدمج خارج الفرع الرئيسي.`,
      };
    }

    if (state === "MERGED" && (mergedAt || mergeCommitOid)) {
      if (baseRefName !== "main") {
        return {
          merged: false,
          code: "PR_INVALID_BASE_BRANCH",
          reason: `لم يتم التحقق من أن الفرع الأساسي لطلب الدمج #${prNumber} هو main (الحالي: «${baseRefName || "غير معروف"}»).`,
        };
      }
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
        baseRefName: "main",
        mergeCommitOid: mergeCommitOid || null,
        mergedAt: mergedAt || null,
        prState: lastState,
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
      if (!isInMergeQueue && attempt >= nonQueueMaxAttempts) {
        break;
      }
      sleep(isInMergeQueue ? delayMs : Math.min(delayMs, nonQueueDelayMs));
    }
  }

  if (isMergeQueuePendingState(lastState)) {
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

export function verifyLocalCheckoutMatchesCommit(
  expectedSha,
  {
    finalHeadSha = "",
    isFinalStep = true,
    cwd = REPO_ROOT,
    spawn = spawnSync,
  } = {},
) {
  const targetSha = String(expectedSha ?? "")
    .trim()
    .toLowerCase();
  const checkoutTargetSha = String(finalHeadSha || expectedSha || "")
    .trim()
    .toLowerCase();
  if (!targetSha || !checkoutTargetSha) {
    return {
      ok: false,
      code: "REMEDIATION_LOCAL_HEAD_MISMATCH",
      reason: "بصمة التزام الإصلاح الذرّي (newHeadRefOid) غير محددة.",
    };
  }
  const headRes = spawn("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  const localHeadSha =
    headRes.status === 0
      ? String(headRes.stdout ?? "")
          .trim()
          .toLowerCase()
      : "";
  if (
    !localHeadSha ||
    (localHeadSha !== checkoutTargetSha &&
      !localHeadSha.startsWith(checkoutTargetSha))
  ) {
    return {
      ok: false,
      code: "REMEDIATION_LOCAL_HEAD_MISMATCH",
      reason: `رأس شجرة العمل المحلّية (${localHeadSha || "غير متوفر"}) لا يطابق التزام الإصلاح الذرّي (${checkoutTargetSha})؛ يجب أن تفحص البوّابات المحلّية نفس الالتزام الذرّي.`,
    };
  }
  if (!isFinalStep && targetSha !== checkoutTargetSha) {
    const ancestorRes = spawn(
      "git",
      ["merge-base", "--is-ancestor", targetSha, "HEAD"],
      {
        cwd,
        encoding: "utf8",
      },
    );
    if (ancestorRes.status !== 0) {
      return {
        ok: false,
        code: "REMEDIATION_LOCAL_HEAD_MISMATCH",
        reason: `التزام الإصلاح الذرّي المرحلي (${targetSha}) ليس سلفاً لرأس شجرة العمل الحالي (${localHeadSha}).`,
      };
    }
  }
  const statusRes = spawn(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    {
      cwd,
      encoding: "utf8",
    },
  );
  if (statusRes.status !== 0 || String(statusRes.stdout ?? "").trim() !== "") {
    return {
      ok: false,
      code: "REMEDIATION_DIRTY_WORKTREE",
      reason:
        "شجرة العمل المحلّية تحتوي على تعديلات غير ملتزمة أثناء فحص التزام الإصلاح الذرّي.",
    };
  }
  return { ok: true, localHeadSha };
}

export function defaultVerifyLocalGates({
  newHeadRefOid,
  finalHeadRefOid = "",
  isFinalStep = true,
  cwd = REPO_ROOT,
  spawn = spawnSync,
} = {}) {
  const checkoutCheck = verifyLocalCheckoutMatchesCommit(newHeadRefOid, {
    finalHeadSha: finalHeadRefOid,
    isFinalStep,
    cwd,
    spawn,
  });
  if (!checkoutCheck.ok) {
    return checkoutCheck;
  }
  if (!isFinalStep) {
    return { ok: true };
  }
  const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  for (const scriptName of ["check", "check:guards"]) {
    const res = spawn(pnpmCmd, [scriptName], {
      cwd,
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

const PENDING_READINESS_CODES = new Set([
  "PR_CI_MISSING",
  "PR_CI_PENDING",
  "PR_CODEX_REVIEW_RUNNING",
  "PR_CODEX_REVIEW_STALE",
  "PR_CODEX_REVIEW_MISSING",
  "PR_MERGEABLE_UNKNOWN",
]);

function defaultAsyncSleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasUnaddressedComments(decision) {
  return (
    Array.isArray(decision?.unaddressedComments) &&
    decision.unaddressedComments.length > 0
  );
}

/**
 * ينفّذ دورة الإصلاح الذرّي وإعادة الفحص (Atomic Remediation & Re-check Cycle):
 * إذا وجدت البوّابة ملاحظات مراجعة أو فشل فحوصات، يُصلحها العامل ذرّياً في التزام جديد
 * (أو سلسلة التزامات ذرّية مستقلّة لكل ملاحظة)، يتحقق من البوّابات المحلّية، يتأكد من تحديث
 * رأس الفرع عن بُعد إلى الالتزام الجديد، ثم يغلق الخيوط المحدّدة صراحةً ويعيد الفحص حتى تصبح
 * جميع البوّابات خضراء تماماً قبل السماح بالدمج.
 */
export async function runAtomicRemediationCycle({
  prNumber,
  initialPrView,
  initialReviewThreads = [],
  remediateAndCommit,
  remediateFinding,
  resolveThread,
  verifyLocalGates = defaultVerifyLocalGates,
  fetchLatestState,
  maxCycles = 5,
  pollIntervalMs = 15_000,
  maxPollAttempts = 720,
  sleep = defaultAsyncSleep,
} = {}) {
  const remediateFn = remediateAndCommit ?? remediateFinding;
  let currentPrView = initialPrView;
  let currentThreads = initialReviewThreads;
  const seenHeadOids = new Set(
    [String(initialPrView?.headRefOid ?? "").trim()].filter(Boolean),
  );

  for (let cycle = 1; cycle <= maxCycles + 1; cycle += 1) {
    let decision = evaluatePrMergeReadiness({
      prView: currentPrView,
      reviewThreads: currentThreads,
    });

    let pollAttempt = 0;
    while (
      !decision.ready &&
      PENDING_READINESS_CODES.has(decision.code) &&
      !hasUnaddressedComments(decision) &&
      typeof fetchLatestState === "function" &&
      pollAttempt < maxPollAttempts
    ) {
      pollAttempt += 1;
      await sleep(pollIntervalMs);
      const nextState = await fetchLatestState({
        prNumber,
        cycle,
        pollAttempt,
        decision,
      });
      currentPrView = nextState?.prView;
      currentThreads = nextState?.reviewThreads;
      decision = evaluatePrMergeReadiness({
        prView: currentPrView,
        reviewThreads: currentThreads,
      });
    }

    if (decision.ready) {
      return {
        ready: true,
        cycles: cycle - 1,
        headRefOid: decision.headRefOid,
        decision,
      };
    }

    if (
      PENDING_READINESS_CODES.has(decision.code) &&
      hasUnaddressedComments(decision)
    ) {
      decision = {
        ...decision,
        code: "PR_UNADDRESSED_REVIEW_COMMENTS",
        reason: `توجد ${decision.unaddressedComments.length} خيوط مراجعة غير محلولة (unresolved) على طلب الدمج #${prNumber ?? currentPrView?.number ?? "?"}. عالجها ذرّياً وأغلق الخيط (resolveReviewThread) قبل الدمج.`,
      };
    }

    if (PENDING_READINESS_CODES.has(decision.code)) {
      return {
        ready: false,
        cycles: Math.min(cycle, maxCycles),
        code: decision.code,
        reason: decision.reason,
        decision,
      };
    }

    const isRemediable =
      decision.code === "PR_UNADDRESSED_REVIEW_COMMENTS" ||
      decision.code === "PR_CI_FAILED" ||
      decision.code === "PR_MISSING_REQUIRED_CHECK";

    if (!isRemediable || typeof remediateFn !== "function") {
      return {
        ready: false,
        cycles: Math.min(cycle, maxCycles),
        code: decision.code,
        reason: decision.reason,
        decision,
      };
    }

    if (cycle > maxCycles) {
      break;
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

    const remediation = await remediateFn({
      cycle,
      prNumber,
      decision,
      prView: currentPrView,
      reviewThreads: currentThreads,
    });

    const atomicSteps = Array.isArray(remediation)
      ? remediation
      : Array.isArray(remediation?.atomicCommits) &&
          remediation.atomicCommits.length > 0
        ? remediation.atomicCommits
        : [remediation];

    const finalStep = atomicSteps[atomicSteps.length - 1];
    const finalStepSha = String(
      finalStep?.newHeadRefOid ?? finalStep?.commitSha ?? "",
    ).trim();

    const currentPrUnresolvedThreadIds = new Set(
      flattenPaginatedReviewThreads(currentThreads)
        .map(normalizeReviewThreadEntry)
        .filter((t) => t && !t.isResolved)
        .map((t) => String(t.id ?? "").trim())
        .filter((id) => id && id !== "unknown"),
    );

    let latestCommitSha = "";
    const pendingResolutions = [];
    for (let stepIdx = 0; stepIdx < atomicSteps.length; stepIdx += 1) {
      const step = atomicSteps[stepIdx];
      const stepSha = String(
        step?.newHeadRefOid ?? step?.commitSha ?? "",
      ).trim();
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
        finalHeadRefOid: finalStepSha,
        isFinalStep: stepIdx === atomicSteps.length - 1,
        decision,
      });
      if (!localGateRes || localGateRes.ok !== true) {
        return {
          ready: false,
          cycles: cycle,
          code: localGateRes?.code || "REMEDIATION_LOCAL_GATES_FAILED",
          reason:
            localGateRes?.reason ||
            "فشلت البوّابات المحلّية (pnpm check / pnpm check:guards) بعد الإصلاح الذرّي.",
        };
      }

      const resolvedIds = Array.isArray(step?.resolvedThreadIds)
        ? step.resolvedThreadIds
            .map((id) => String(id ?? "").trim())
            .filter(Boolean)
        : [];
      for (const threadId of resolvedIds) {
        if (!currentPrUnresolvedThreadIds.has(threadId)) {
          return {
            ready: false,
            cycles: cycle,
            code: "REMEDIATION_INVALID_RESOLVED_THREAD_ID",
            reason: `معرّف خيط المراجعة (${threadId}) لا ينتمي إلى خيوط المراجعة غير المحلولة الحالية على طلب الدمج #${prNumber ?? currentPrView?.number ?? "?"}.`,
          };
        }
        pendingResolutions.push({ threadId, stepSha });
      }
    }

    if (
      decision.code === "PR_UNADDRESSED_REVIEW_COMMENTS" &&
      currentPrUnresolvedThreadIds.size > 0 &&
      pendingResolutions.length === 0
    ) {
      return {
        ready: false,
        cycles: cycle,
        code: "REMEDIATION_MISSING_RESOLVED_THREADS",
        reason:
          "يجب تحديد معرّفات خيوط المراجعة المعالجة صراحةً (resolvedThreadIds) في كل خطوة إصلاح ذرّي لمنع إغلاق خيوط غير معالجة.",
      };
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

    let updated = await fetchLatestState({
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
        reason: `بصمة رأس الفرع على GitHub (${remoteHeadOid || "غير متوفرة"}) لا تطابق الالتزام الذرّي الجديد (${latestCommitSha})؛ يجب دفع الالتزام الجديد والتحقق من فحوصاته عن بُعد قبل إغلاق خيوط المراجعة أو الدمج.`,
      };
    }

    if (typeof resolveThread === "function" && pendingResolutions.length > 0) {
      for (const { threadId, stepSha } of pendingResolutions) {
        await resolveThread(threadId, stepSha);
      }
      const resolvedIdSet = new Set(
        pendingResolutions.map((item) => item.threadId),
      );
      const preResolveThreads = flattenPaginatedReviewThreads(
        updated?.reviewThreads,
      );
      const needsPostResolveRefresh = preResolveThreads.some(
        (t) => resolvedIdSet.has(t?.id) && t?.isResolved !== true,
      );
      if (needsPostResolveRefresh) {
        const refreshed = await fetchLatestState({
          prNumber,
          cycle,
          newHeadRefOid: latestCommitSha,
          decision,
        });
        if (refreshed?.prView) {
          updated = refreshed;
        }
      }
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
  const makeTrustedCodexComments = (sha = "sha-2") => [
    {
      author: { login: "chatgpt-codex-connector" },
      body: `<!-- codex-review-state:v1 {"sha":"${sha}","state":"completed"} -->`,
    },
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
          author: { login: "chatgpt-codex-connector" },
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
      comments: makeTrustedCodexComments("sha-2"),
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
      comments: makeTrustedCodexComments("sha-2"),
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
    "--match-head-commit",
    "0bd1c2db9733578ae5ca4de6fd8d48883e503f02",
  ]);
  assert.equal(mergeArgs.includes("--admin"), false);
  assert.equal(mergeArgs.includes("--delete-branch"), false);

  // 9. Post-merge verification rejects queued/unmerged state and confirms actual MERGED state
  const queuedOnlyRes = verifyPostMergeCompletion(1530, "sha-2", {
    maxAttempts: 2,
    delayMs: 0,
    sleep: () => {},
    fetchPrState: () => ({
      number: 1530,
      state: "OPEN",
      mergeQueueEntry: { state: "QUEUED" },
      headRefOid: "sha-2",
    }),
  });
  assert.equal(queuedOnlyRes.merged, false);
  assert.equal(queuedOnlyRes.code, "PR_QUEUED_NOT_MERGED_YET");

  let pollCount = 0;
  const eventuallyMergedRes = verifyPostMergeCompletion(1530, "sha-2", {
    maxAttempts: 5,
    delayMs: 0,
    sleep: () => {},
    fetchPrState: () => {
      pollCount += 1;
      if (pollCount < 4) {
        return {
          number: 1530,
          state: "OPEN",
          baseRefName: "main",
          mergeQueueEntry: { state: "AWAITING_CHECKS" },
          headRefOid: "sha-2",
        };
      }
      return {
        number: 1530,
        state: "MERGED",
        baseRefName: "main",
        mergedAt: "2026-10-22T10:30:00Z",
        mergeCommit: { oid: "merged-sha-999" },
        headRefOid: "sha-2",
      };
    },
  });
  assert.equal(eventuallyMergedRes.merged, true);
  assert.equal(eventuallyMergedRes.code, "MERGED");
  assert.equal(eventuallyMergedRes.mergeCommitOid, "merged-sha-999");

  const retargetedPostMergeRes = verifyPostMergeCompletion(1530, "sha-2", {
    maxAttempts: 2,
    delayMs: 0,
    sleep: () => {},
    fetchPrState: () => ({
      number: 1530,
      state: "MERGED",
      baseRefName: "develop",
      mergedAt: "2026-10-22T10:30:00Z",
      mergeCommit: { oid: "merged-sha-999" },
      headRefOid: "sha-2",
    }),
  });
  assert.equal(retargetedPostMergeRes.merged, false);
  assert.equal(retargetedPostMergeRes.code, "PR_INVALID_BASE_BRANCH");

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
      comments: makeTrustedCodexComments("sha-2"),
    },
  });
  assert.equal(behindBranchRes.ready, false);
  assert.equal(behindBranchRes.code, "PR_BEHIND_BASE_BRANCH");

  const queueEnabledBehindRes = evaluatePrMergeReadiness({
    prView: {
      number: 108,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BEHIND",
      isMergeQueueEnabled: true,
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
      comments: makeTrustedCodexComments("sha-2"),
    },
  });
  assert.equal(queueEnabledBehindRes.ready, true);
  assert.equal(queueEnabledBehindRes.code, "OK");

  const blockedBranchRes = evaluatePrMergeReadiness({
    prView: {
      number: 109,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
      comments: makeTrustedCodexComments("sha-2"),
    },
  });
  assert.equal(blockedBranchRes.ready, false);
  assert.equal(blockedBranchRes.code, "PR_BLOCKED_BY_PROTECTION");

  const queueEnabledBlockedRes = evaluatePrMergeReadiness({
    prView: {
      number: 109,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      isMergeQueueEnabled: true,
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
      comments: makeTrustedCodexComments("sha-2"),
    },
  });
  assert.equal(queueEnabledBlockedRes.ready, true);
  assert.equal(queueEnabledBlockedRes.code, "OK");

  assert.equal(
    shouldCleanupMergedHeadBranch({
      headRefName: "feature/test",
      isCrossRepository: false,
      headRepositoryOwner: { login: "ahrrfy" },
      headRepository: { name: "business_management_system" },
    }),
    true,
  );
  assert.equal(
    shouldCleanupMergedHeadBranch({
      headRefName: "feature/test",
      isCrossRepository: true,
      headRepositoryOwner: { login: "external-contributor" },
      headRepository: { name: "business_management_system" },
    }),
    false,
  );
  assert.equal(
    shouldCleanupMergedHeadBranch({
      headRefName: "main",
      isCrossRepository: false,
      headRepositoryOwner: { login: "ahrrfy" },
      headRepository: { name: "business_management_system" },
    }),
    false,
  );
  assert.equal(
    buildMergedHeadRefDeleteEndpoint("topic#123"),
    "repos/ahrrfy/business_management_system/git/refs/heads/topic%23123",
  );
  assert.equal(
    buildMergedHeadRefDeleteEndpoint("feature/topic?a=1%2"),
    "repos/ahrrfy/business_management_system/git/refs/heads/feature%2Ftopic%3Fa%3D1%252",
  );
  assert.equal(
    shouldCleanupMergedHeadBranch(
      {
        headRefName: "feature/test",
        headRefOid: "sha-merged-1",
        headRef: { target: { oid: "sha-merged-1" } },
        isCrossRepository: false,
        headRepositoryOwner: { login: "ahrrfy" },
        headRepository: { name: "business_management_system" },
      },
      "sha-merged-1",
    ),
    true,
  );
  assert.equal(
    shouldCleanupMergedHeadBranch(
      {
        headRefName: "feature/test",
        headRefOid: "sha-merged-1",
        headRef: { target: { oid: "sha-new-unmerged-commit-2" } },
        isCrossRepository: false,
        headRepositoryOwner: { login: "ahrrfy" },
        headRepository: { name: "business_management_system" },
      },
      "sha-merged-1",
    ),
    false,
  );
  assert.deepEqual(
    buildMergedHeadRefCleanupGitArgs("feature/topic#123", "sha-merged-1"),
    [
      "push",
      "origin",
      "--force-with-lease=refs/heads/feature/topic#123:sha-merged-1",
      ":refs/heads/feature/topic#123",
    ],
  );
  assert.deepEqual(
    selectMergeExecutionArgs({
      prNumber: 1532,
      pullRequestId: "PR_kwDO12345",
      headRefOid: "sha-merged-1",
      isMergeQueueEnabled: true,
      isInMergeQueue: false,
    }),
    buildEnqueuePullRequestArgs("PR_kwDO12345", "sha-merged-1"),
  );
  assert.equal(
    selectMergeExecutionArgs({
      prNumber: 1532,
      pullRequestId: "PR_kwDO12345",
      headRefOid: "sha-merged-1",
      isMergeQueueEnabled: true,
      isInMergeQueue: true,
    }),
    null,
  );

  // 11. Truncated reviewThreads pagination (hasNextPage: true on last page) blocks merge
  const truncatedPaginationRes = evaluatePrMergeReadiness({
    prView: {
      number: 110,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
      comments: makeTrustedCodexComments("sha-2"),
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
      comments: makeTrustedCodexComments("sha-2"),
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
      comments: [
        {
          author: { login: "chatgpt-codex-connector" },
          body: "<!-- codex-review-state:v1 {broken-json} -->",
        },
      ],
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
          author: { login: "chatgpt-codex-connector" },
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
          author: { login: "chatgpt-codex-connector" },
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
          author: { login: "chatgpt-codex-connector" },
          body: '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"90fb9671d55713f186742f7757481427fef726bd","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->',
        },
      ],
    },
  });
  assert.equal(nestedCodexCompletedRes.ready, true);
  assert.equal(nestedCodexCompletedRes.code, "OK");

  const nestedCodexUnresolvedFindingsRes = evaluatePrMergeReadiness({
    prView: {
      number: 115,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "90fb9671d55713f186742f7757481427fef726bd",
      statusCheckRollup: baseGreenRollup,
      comments: [
        {
          author: { login: "chatgpt-codex-connector" },
          body: '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"90fb9671d55713f186742f7757481427fef726bd","has_any_findings":true,"has_unresolved_findings":true,"status":"completed"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->',
        },
      ],
    },
    reviewThreads: [],
  });
  assert.equal(nestedCodexUnresolvedFindingsRes.ready, false);
  assert.equal(
    nestedCodexUnresolvedFindingsRes.code,
    "PR_UNADDRESSED_REVIEW_COMMENTS",
  );

  const mixedNestedCodexComment = [
    {
      author: { login: "chatgpt-codex-connector" },
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
    verifyPostMergeState({ state: "OPEN", baseRefName: "main", mergedAt: null })
      .merged,
    false,
  );
  assert.equal(
    verifyPostMergeState({ state: "OPEN", baseRefName: "main", mergedAt: null })
      .code,
    "PR_NOT_MERGED_YET",
  );
  assert.equal(
    verifyPostMergeState({
      state: "OPEN",
      baseRefName: "main",
      mergeQueueEntry: { state: "QUEUED" },
      mergedAt: null,
    }).code,
    "PR_QUEUED_NOT_MERGED_YET",
  );
  assert.equal(
    verifyPostMergeState({
      state: "MERGED",
      baseRefName: "main",
      mergedAt: "2026-10-22T10:30:00Z",
      mergeCommit: { oid: "merged-sha-1" },
    }).merged,
    true,
  );
  assert.equal(
    verifyPostMergeState({
      state: "MERGED",
      baseRefName: "develop",
      mergedAt: "2026-10-22T10:30:00Z",
      mergeCommit: { oid: "merged-sha-1" },
    }).code,
    "PR_INVALID_BASE_BRANCH",
  );
  assert.equal(
    verifyPreMergeTargetState({
      prNumber: 1530,
      expectedHeadRefOid: "sha-2",
      fetchState: () => ({
        prView: {
          number: 1530,
          state: "OPEN",
          baseRefName: "develop",
          headRefOid: "sha-2",
        },
        reviewThreads: [],
      }),
    }).code,
    "PR_INVALID_BASE_BRANCH",
  );
  assert.equal(
    verifyPreMergeTargetState({
      prNumber: 1530,
      expectedHeadRefOid: "sha-2",
      fetchState: () => ({
        prView: {
          number: 1530,
          state: "OPEN",
          baseRefName: "main",
          mergeable: "MERGEABLE",
          headRefOid: "sha-2",
          statusCheckRollup: baseGreenRollup,
          comments: makeTrustedCodexComments("sha-2"),
        },
        reviewThreads: [],
      }),
    }).ok,
    true,
  );

  // 18. Stale or missing Codex commit_sha fails closed with PR_CODEX_REVIEW_STALE
  const staleFlatCodexRes = evaluatePrMergeReadiness({
    prView: {
      number: 119,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "new-head-sha-999",
      statusCheckRollup: baseGreenRollup,
      comments: [
        {
          author: { login: "chatgpt-codex-connector" },
          body: '<!-- codex-review-state:v1 {"sha":"old-head-sha-111","state":"completed"} -->',
        },
      ],
    },
  });
  assert.equal(staleFlatCodexRes.ready, false);
  assert.equal(staleFlatCodexRes.code, "PR_CODEX_REVIEW_STALE");

  const staleNestedCodexRes = evaluatePrMergeReadiness({
    prView: {
      number: 120,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "new-head-sha-999",
      statusCheckRollup: baseGreenRollup,
      comments: [
        {
          author: { login: "chatgpt-codex-connector" },
          body: '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"old-head-sha-111","status":"completed"},"security_review":{"commit_sha":null,"status":null}} -->',
        },
      ],
    },
  });
  assert.equal(staleNestedCodexRes.ready, false);
  assert.equal(staleNestedCodexRes.code, "PR_CODEX_REVIEW_STALE");

  // 19. Overlapping rerun started after previous run started (even before previous run finished) supersedes it
  const overlappingRerunRes = evaluatePrMergeReadiness({
    prView: {
      number: 121,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-2",
      statusCheckRollup: [
        ...baseGreenRollup.slice(0, 4),
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
      comments: makeTrustedCodexComments("sha-2"),
    },
  });
  assert.equal(overlappingRerunRes.ready, false);
  assert.equal(overlappingRerunRes.code, "PR_CI_PENDING");

  // 20. Missing Codex review state or untrusted author forged comment fails closed
  const missingCodexStateRes = evaluatePrMergeReadiness({
    prView: {
      number: 124,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
      comments: [],
    },
  });
  assert.equal(missingCodexStateRes.ready, false);
  assert.equal(missingCodexStateRes.code, "PR_CODEX_REVIEW_MISSING");

  const forgedCodexCommentRes = evaluatePrMergeReadiness({
    prView: {
      number: 125,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
      comments: [
        {
          author: { login: "chatgpt-codex-connector" },
          body: '<!-- codex-review-state:v1 {"sha":"sha-2","state":"running"} -->',
        },
        {
          author: { login: "malicious-contributor" },
          body: '<!-- codex-review-state:v1 {"sha":"sha-2","state":"completed"} -->',
        },
      ],
    },
  });
  assert.equal(forgedCodexCommentRes.ready, false);
  assert.equal(forgedCodexCommentRes.code, "PR_CODEX_REVIEW_RUNNING");

  // 21. Incomplete issue comments pagination (hasNextPage=true) fails closed before trusting older Codex markers
  const incompleteIssueCommentsPage = [
    {
      data: {
        repository: {
          pullRequest: {
            comments: {
              pageInfo: { hasNextPage: true, endCursor: "cursor-100" },
              nodes: makeTrustedCodexComments("sha-2"),
            },
          },
        },
      },
    },
  ];
  assert.equal(
    hasIncompleteIssueCommentsPagination(incompleteIssueCommentsPage),
    true,
  );
  const incompleteCommentsRes = evaluatePrMergeReadiness({
    prView: {
      number: 126,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
      comments: incompleteIssueCommentsPage,
    },
  });
  assert.equal(incompleteCommentsRes.ready, false);
  assert.equal(
    incompleteCommentsRes.code,
    "PR_ISSUE_COMMENTS_PAGINATION_INCOMPLETE",
  );

  // 22. Multi-page issue comments (>100 comments across slurped GraphQL pages) inspect the latest Codex marker on later pages
  const fillerComments = Array.from({ length: 100 }, (_, idx) => ({
    id: `IC_${idx + 1}`,
    author: { login: "contributor" },
    body: `Discussion comment #${idx + 1}`,
  }));
  fillerComments[0] = {
    id: "IC_OLD_CODEX",
    author: { login: "chatgpt-codex-connector" },
    body: '<!-- codex-review-state:v1 {"sha":"sha-old","state":"completed"} -->',
  };
  const multiPageCommentsRunning = [
    {
      data: {
        repository: {
          pullRequest: {
            comments: {
              pageInfo: { hasNextPage: true, endCursor: "cursor-100" },
              nodes: fillerComments,
            },
          },
        },
      },
    },
    {
      data: {
        repository: {
          pullRequest: {
            comments: {
              pageInfo: { hasNextPage: false, endCursor: "cursor-105" },
              nodes: [
                {
                  id: "IC_101",
                  author: { login: "chatgpt-codex-connector" },
                  body: '<!-- codex-review-state:v1 {"sha":"sha-2","state":"running"} -->',
                },
              ],
            },
          },
        },
      },
    },
  ];
  const multiPageRunningRes = evaluatePrMergeReadiness({
    prView: {
      number: 127,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
      comments: multiPageCommentsRunning,
    },
  });
  assert.equal(multiPageRunningRes.ready, false);
  assert.equal(multiPageRunningRes.code, "PR_CODEX_REVIEW_RUNNING");

  const multiPageCommentsCompleted = [
    multiPageCommentsRunning[0],
    {
      data: {
        repository: {
          pullRequest: {
            comments: {
              pageInfo: { hasNextPage: false, endCursor: "cursor-106" },
              nodes: makeTrustedCodexComments("sha-2"),
            },
          },
        },
      },
    },
  ];
  const multiPageCompletedRes = evaluatePrMergeReadiness({
    prView: {
      number: 127,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-2",
      statusCheckRollup: baseGreenRollup,
      comments: multiPageCommentsCompleted,
    },
  });
  assert.equal(multiPageCompletedRes.ready, true);
  assert.equal(multiPageCompletedRes.code, "OK");

  console.log("safe-merge selftest: OK");
}

export async function runSafeMergeAsyncSelftest() {
  const baseGreenRollup = [
    { name: "audit", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "authz-guard", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "quality-build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "test-shard-1-of-8", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "check-test-build", status: "COMPLETED", conclusion: "SUCCESS" },
  ];
  const makeTrustedCodexComments = (sha) => [
    {
      author: { login: "chatgpt-codex-connector" },
      body: `<!-- codex-review-state:v1 {"sha":"${sha}","state":"completed"} -->`,
    },
  ];

  // Missing explicit resolvedThreadIds fails closed
  const missingThreadIdsRes = await runAtomicRemediationCycle({
    prNumber: 122,
    pollIntervalMs: 0,
    initialPrView: {
      number: 122,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-1",
      statusCheckRollup: baseGreenRollup,
      comments: makeTrustedCodexComments("sha-1"),
    },
    initialReviewThreads: [{ id: "PRRT_1", isResolved: false, body: "Fix" }],
    remediateFinding: async () => [{ commitSha: "sha-2" }],
    verifyLocalGates: async () => ({ ok: true }),
    fetchLatestState: async () => ({
      prView: {
        number: 122,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        headRefOid: "sha-2",
        statusCheckRollup: baseGreenRollup,
        comments: makeTrustedCodexComments("sha-2"),
      },
      reviewThreads: [{ id: "PRRT_1", isResolved: false, body: "Fix" }],
    }),
  });
  assert.equal(missingThreadIdsRes.ready, false);
  assert.equal(
    missingThreadIdsRes.code,
    "REMEDIATION_MISSING_RESOLVED_THREADS",
  );

  // Foreign or stale resolvedThreadIds not in current PR's unresolved threads fails closed
  let foreignResolveCalled = false;
  const foreignThreadIdRes = await runAtomicRemediationCycle({
    prNumber: 122,
    pollIntervalMs: 0,
    initialPrView: {
      number: 122,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-1",
      statusCheckRollup: baseGreenRollup,
      comments: makeTrustedCodexComments("sha-1"),
    },
    initialReviewThreads: [{ id: "PRRT_1", isResolved: false, body: "Fix" }],
    remediateFinding: async () => [
      { commitSha: "sha-2", resolvedThreadIds: ["PRRT_OTHER_PR_999"] },
    ],
    verifyLocalGates: async () => ({ ok: true }),
    resolveThread: async () => {
      foreignResolveCalled = true;
    },
    fetchLatestState: async () => ({
      prView: {
        number: 122,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        headRefOid: "sha-2",
        statusCheckRollup: baseGreenRollup,
        comments: makeTrustedCodexComments("sha-2"),
      },
      reviewThreads: [{ id: "PRRT_1", isResolved: false, body: "Fix" }],
    }),
  });
  assert.equal(foreignThreadIdRes.ready, false);
  assert.equal(
    foreignThreadIdRes.code,
    "REMEDIATION_INVALID_RESOLVED_THREAD_ID",
  );
  assert.equal(foreignResolveCalled, false);

  // Remote head mismatch aborts BEFORE resolveThread is called
  let resolveCalledOnMismatch = false;
  const mismatchBeforeResolveRes = await runAtomicRemediationCycle({
    prNumber: 123,
    pollIntervalMs: 0,
    initialPrView: {
      number: 123,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-1",
      statusCheckRollup: baseGreenRollup,
      comments: makeTrustedCodexComments("sha-1"),
    },
    initialReviewThreads: [{ id: "PRRT_1", isResolved: false, body: "Fix" }],
    remediateFinding: async () => [
      { commitSha: "sha-2-local-unpushed", resolvedThreadIds: ["PRRT_1"] },
    ],
    verifyLocalGates: async () => ({ ok: true }),
    resolveThread: async () => {
      resolveCalledOnMismatch = true;
    },
    fetchLatestState: async () => ({
      prView: {
        number: 123,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        headRefOid: "sha-1",
        statusCheckRollup: baseGreenRollup,
        comments: makeTrustedCodexComments("sha-1"),
      },
      reviewThreads: [{ id: "PRRT_1", isResolved: false, body: "Fix" }],
    }),
  });
  assert.equal(mismatchBeforeResolveRes.ready, false);
  assert.equal(
    mismatchBeforeResolveRes.code,
    "REMEDIATION_REMOTE_HEAD_MISMATCH",
  );
  assert.equal(resolveCalledOnMismatch, false);

  // Bounded polling with delay waits for pending Codex/CI before becoming ready
  const sleepDelays = [];
  let pendingPollCalls = 0;
  const boundedPollRes = await runAtomicRemediationCycle({
    prNumber: 126,
    pollIntervalMs: 25,
    maxPollAttempts: 3,
    sleep: async (ms) => {
      sleepDelays.push(ms);
    },
    initialPrView: {
      number: 126,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-poll-1",
      statusCheckRollup: baseGreenRollup,
      comments: [],
    },
    initialReviewThreads: [],
    fetchLatestState: async () => {
      pendingPollCalls += 1;
      return {
        prView: {
          number: 126,
          state: "OPEN",
          baseRefName: "main",
          mergeable: "MERGEABLE",
          headRefOid: "sha-poll-1",
          statusCheckRollup: baseGreenRollup,
          comments:
            pendingPollCalls >= 2 ? makeTrustedCodexComments("sha-poll-1") : [],
        },
        reviewThreads: [],
      };
    },
  });
  assert.equal(boundedPollRes.ready, true);
  assert.deepEqual(sleepDelays, [25, 25]);

  // Bounded polling also polls when statusCheckRollup is empty (PR_CI_MISSING) immediately after push
  let ciMissingPolls = 0;
  const ciMissingPollRes = await runAtomicRemediationCycle({
    prNumber: 127,
    pollIntervalMs: 10,
    maxPollAttempts: 2,
    sleep: async () => {},
    initialPrView: {
      number: 127,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-ci-missing-1",
      statusCheckRollup: [],
      comments: makeTrustedCodexComments("sha-ci-missing-1"),
    },
    initialReviewThreads: [],
    fetchLatestState: async () => {
      ciMissingPolls += 1;
      return {
        prView: {
          number: 127,
          state: "OPEN",
          baseRefName: "main",
          mergeable: "MERGEABLE",
          headRefOid: "sha-ci-missing-1",
          statusCheckRollup: baseGreenRollup,
          comments: makeTrustedCodexComments("sha-ci-missing-1"),
        },
        reviewThreads: [],
      };
    },
  });
  assert.equal(ciMissingPollRes.ready, true);
  assert.equal(ciMissingPolls, 1);

  // defaultVerifyLocalGates verifies checkout HEAD matches stepSha before running local gates
  const mismatchedCheckoutRes = defaultVerifyLocalGates({
    newHeadRefOid: "deadbeef00000000000000000000000000000000",
    spawn: (cmd, args) => {
      if (cmd === "git" && args[0] === "rev-parse") {
        return {
          status: 0,
          stdout: "1111111100000000000000000000000000000000\n",
        };
      }
      return { status: 0, stdout: "" };
    },
  });
  assert.equal(mismatchedCheckoutRes.ok, false);
  assert.equal(mismatchedCheckoutRes.code, "REMEDIATION_LOCAL_HEAD_MISMATCH");

  // Multi-commit series with maxCycles: 1 succeeds after the final remediation cycle and validates intermediate ancestry
  const multiCommitMaxOneRes = await runAtomicRemediationCycle({
    prNumber: 128,
    maxCycles: 1,
    pollIntervalMs: 0,
    initialPrView: {
      number: 128,
      state: "OPEN",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      headRefOid: "sha-base-0",
      statusCheckRollup: baseGreenRollup,
      comments: makeTrustedCodexComments("sha-base-0"),
    },
    initialReviewThreads: [
      { id: "PRRT_A", isResolved: false, body: "Fix A" },
      { id: "PRRT_B", isResolved: false, body: "Fix B" },
    ],
    remediateFinding: async () => [
      { commitSha: "sha-step-1", resolvedThreadIds: ["PRRT_A"] },
      { commitSha: "sha-step-2", resolvedThreadIds: ["PRRT_B"] },
    ],
    verifyLocalGates: ({ newHeadRefOid, finalHeadRefOid, isFinalStep }) =>
      defaultVerifyLocalGates({
        newHeadRefOid,
        finalHeadRefOid,
        isFinalStep,
        spawn: (cmd, args) => {
          if (cmd === "git" && args[0] === "rev-parse") {
            return { status: 0, stdout: "sha-step-2\n" };
          }
          if (cmd === "git" && args[0] === "merge-base") {
            return { status: 0, stdout: "" };
          }
          return { status: 0, stdout: "" };
        },
      }),
    resolveThread: async () => {},
    fetchLatestState: async () => ({
      prView: {
        number: 128,
        state: "OPEN",
        baseRefName: "main",
        mergeable: "MERGEABLE",
        headRefOid: "sha-step-2",
        statusCheckRollup: baseGreenRollup,
        comments: makeTrustedCodexComments("sha-step-2"),
      },
      reviewThreads: [
        { id: "PRRT_A", isResolved: true },
        { id: "PRRT_B", isResolved: true },
      ],
    }),
  });
  assert.equal(multiCommitMaxOneRes.ready, true);
  assert.equal(multiCommitMaxOneRes.cycles, 1);
  assert.equal(multiCommitMaxOneRes.headRefOid, "sha-step-2");
}

function isTransientGhNetworkError(stderr = "") {
  return /dial tcp|connectex|TLS handshake timeout|i\/o timeout|EOF|connection reset|Bad Gateway|Service Unavailable|Gateway Timeout/i.test(
    String(stderr ?? ""),
  );
}

function captureJson(cmd, args, { maxAttempts = 4, retryDelayMs = 3000 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = spawnSync(cmd, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    if (res.status === 0) {
      return JSON.parse(res.stdout);
    }
    const errText = res.stderr?.trim() || `${cmd} ${args.join(" ")} failed`;
    if (attempt < maxAttempts && isTransientGhNetworkError(errText)) {
      defaultSleep(retryDelayMs);
      continue;
    }
    throw new Error(errText);
  }
}

const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      id
      isMergeQueueEnabled
      isInMergeQueue
      isCrossRepository
      headRefName
      headRepository {
        name
      }
      headRepositoryOwner {
        login
      }
      reviewThreads(first: 100, after: $endCursor) {
        totalCount
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

const ISSUE_COMMENTS_QUERY = `
query($owner: String!, $name: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      comments(first: 100, after: $endCursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          databaseId
          body
          createdAt
          author {
            login
          }
        }
      }
    }
  }
}
`.trim();

function fetchAllIssueComments(prNumber) {
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
    `query=${ISSUE_COMMENTS_QUERY}`,
  ]);
}

const NATIVE_REVIEWS_QUERY = `
query($owner: String!, $name: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviews(first: 100, after: $endCursor) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          databaseId
          state
          submittedAt
          author { login }
          commit { oid }
        }
      }
    }
  }
}
`.trim();

function fetchAllNativeReviews(prNumber) {
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
    `query=${NATIVE_REVIEWS_QUERY}`,
  ]);
}

const POST_MERGE_PR_STATE_QUERY = `
query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      id
      number
      state
      mergedAt
      baseRefName
      headRefName
      headRefOid
      headRef {
        target {
          oid
        }
      }
      isCrossRepository
      headRepository {
        name
      }
      headRepositoryOwner {
        login
      }
      mergeStateStatus
      isInMergeQueue
      mergeQueueEntry {
        state
      }
      mergeCommit {
        oid
      }
    }
  }
}
`.trim();

function fetchPostMergePrState(prNumber) {
  const payload = captureJson("gh", [
    "api",
    "graphql",
    "-F",
    "owner=ahrrfy",
    "-F",
    "name=business_management_system",
    "-F",
    `pr=${Number(prNumber)}`,
    "-f",
    `query=${POST_MERGE_PR_STATE_QUERY}`,
  ]);
  return payload?.data?.repository?.pullRequest ?? null;
}

function fetchPrStateAndThreads(prArg) {
  const viewArgs = ["pr", "view"];
  if (prArg != null && String(prArg).trim() !== "") {
    viewArgs.push(String(prArg));
  }
  viewArgs.push(
    "--json",
    "id,number,state,isDraft,baseRefName,headRefName,headRefOid,isCrossRepository,headRepository,headRepositoryOwner,mergeStateStatus,mergeable,reviewDecision,statusCheckRollup",
  );
  const prView = captureJson("gh", viewArgs);
  prView.baseRefName = String(prView?.baseRefName ?? "");
  prView.comments = fetchAllIssueComments(prView.number);
  if (parseCodexReviewState(prView.comments) === null) {
    prView.nativeReviews = fetchAllNativeReviews(prView.number);
  }
  const reviewThreads = fetchAllReviewThreads(prView.number);
  const prMeta = Array.isArray(reviewThreads)
    ? reviewThreads[0]?.data?.repository?.pullRequest
    : reviewThreads?.data?.repository?.pullRequest;
  if (prMeta && typeof prMeta === "object") {
    if (!prView.id && prMeta.id) {
      prView.id = prMeta.id;
    }
    if (typeof prMeta.isMergeQueueEnabled === "boolean") {
      prView.isMergeQueueEnabled = prMeta.isMergeQueueEnabled;
    }
    if (typeof prMeta.isInMergeQueue === "boolean") {
      prView.isInMergeQueue = prMeta.isInMergeQueue;
    }
    if (
      prView.isCrossRepository === undefined &&
      typeof prMeta.isCrossRepository === "boolean"
    ) {
      prView.isCrossRepository = prMeta.isCrossRepository;
    }
    if (!prView.headRepository && prMeta.headRepository) {
      prView.headRepository = prMeta.headRepository;
    }
    if (!prView.headRepositoryOwner && prMeta.headRepositoryOwner) {
      prView.headRepositoryOwner = prMeta.headRepositoryOwner;
    }
  }
  return { prView, reviewThreads };
}

function resolveReviewThreadViaGh(threadId) {
  return captureJson("gh", buildResolveReviewThreadArgs(threadId));
}

function extractOptionValue(args, flagName) {
  const idx = args.indexOf(flagName);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  const prefixed = args.find((a) => a.startsWith(`${flagName}=`));
  if (prefixed) {
    return prefixed.slice(flagName.length + 1);
  }
  return "";
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    runSafeMergeSelftest();
    await runSafeMergeAsyncSelftest();
    return;
  }

  if (args.includes("--ack-reviews")) {
    console.error(
      "\n⛔ [PR_ACK_REVIEWS_FORBIDDEN] لا يُسمح بتجاوز خيوط المراجعة عبر --ack-reviews؛ يجب إصلاح الملاحظات ذرّياً وإغلاق كل خيط (resolveReviewThread) قبل الدمج.\n",
    );
    process.exit(1);
  }

  const remediateCmd =
    extractOptionValue(args, "--remediate-cmd") ||
    String(process.env.SAFE_MERGE_REMEDIATE_CMD ?? "").trim();

  const positionalArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--remediate-cmd") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    positionalArgs.push(arg);
  }
  const prArg = positionalArgs[0];

  let initialState;
  try {
    initialState = fetchPrStateAndThreads(prArg);
  } catch (error) {
    console.error(
      `\n⛔ [PR_FETCH_FAILED] تعذّر جلب بيانات طلب الدمج أو خيوط المراجعة: ${error?.message ?? error}\n`,
    );
    process.exit(1);
  }

  const { prView: initialPrView, reviewThreads: initialReviewThreads } =
    initialState;

  const remediateFinding = remediateCmd
    ? async ({ prNumber, cycle, decision }) => {
        const res = spawnSync(remediateCmd, {
          cwd: REPO_ROOT,
          shell: true,
          encoding: "utf8",
          env: {
            ...process.env,
            SAFE_MERGE_PR_NUMBER: String(prNumber),
            SAFE_MERGE_CYCLE: String(cycle),
            SAFE_MERGE_DECISION_JSON: JSON.stringify(decision),
          },
        });
        if (res.status !== 0) {
          throw new Error(
            res.stderr?.trim() ||
              res.stdout?.trim() ||
              "فشل تنفيذ أمر الإصلاح الذرّي (--remediate-cmd).",
          );
        }
        return JSON.parse(String(res.stdout ?? "").trim());
      }
    : undefined;

  let cycleResult;
  try {
    cycleResult = await runAtomicRemediationCycle({
      prNumber: initialPrView.number,
      initialPrView,
      initialReviewThreads,
      remediateFinding,
      verifyLocalGates: defaultVerifyLocalGates,
      resolveThread: async (threadId) => {
        resolveReviewThreadViaGh(threadId);
      },
      fetchLatestState: async ({ prNumber }) =>
        fetchPrStateAndThreads(prNumber),
    });
  } catch (error) {
    console.error(
      `\n⛔ [PR_REMEDIATION_FAILED] فشل مسار الإصلاح الذرّي وإعادة الفحص: ${error?.message ?? error}\n`,
    );
    process.exit(1);
  }

  if (!cycleResult.ready) {
    const decision = cycleResult.decision ?? cycleResult;
    console.error(`\n⛔ [${cycleResult.code}] ${cycleResult.reason}`);
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

  const validatedHeadRefOid =
    cycleResult.headRefOid || initialPrView.headRefOid;

  let preMergeVerification;
  try {
    preMergeVerification = verifyPreMergeTargetState({
      prNumber: initialPrView.number,
      expectedHeadRefOid: validatedHeadRefOid,
      fetchState: fetchPrStateAndThreads,
    });
  } catch (error) {
    console.error(
      `\n⛔ [PR_PRE_MERGE_VERIFY_FAILED] تعذّر إعادة التحقق من حالة الطلب والفرع الأساسي قبل الدمج: ${error?.message ?? error}\n`,
    );
    process.exit(1);
  }

  if (!preMergeVerification.ok) {
    console.error(
      `\n⛔ [${preMergeVerification.code}] ${preMergeVerification.reason}\n`,
    );
    process.exit(1);
  }

  console.log(
    `✓ طلب الدمج #${initialPrView.number} (${validatedHeadRefOid.slice(0, 9)}) اجتاز جميع بوابات CI والمراجعة الآلية.`,
  );

  const mergeArgs = selectMergeExecutionArgs({
    prNumber: initialPrView.number,
    pullRequestId: preMergeVerification.pullRequestId || initialPrView.id,
    headRefOid: validatedHeadRefOid,
    isMergeQueueEnabled:
      preMergeVerification.isMergeQueueEnabled ||
      initialPrView.isMergeQueueEnabled === true,
    isInMergeQueue:
      preMergeVerification.isInMergeQueue ||
      initialPrView.isInMergeQueue === true,
  });
  if (mergeArgs !== null) {
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
  }

  let postMergeVerification;
  try {
    postMergeVerification = verifyPostMergeCompletion(
      initialPrView.number,
      validatedHeadRefOid,
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

  const cleanupCandidate = postMergeVerification.prState ?? initialPrView;
  if (shouldCleanupMergedHeadBranch(cleanupCandidate, validatedHeadRefOid)) {
    const headRefName = String(cleanupCandidate.headRefName ?? "").trim();
    spawnSync(
      "git",
      buildMergedHeadRefCleanupGitArgs(headRefName, validatedHeadRefOid),
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
      },
    );
  }

  const mergeShaInfo = postMergeVerification.mergeCommitOid
    ? ` — التزام الدمج: ${postMergeVerification.mergeCommitOid.slice(0, 9)}`
    : "";
  console.log(
    `✓ تم التأكد من دمج الطلب #${initialPrView.number} فعلياً في main (مثبّت على ${validatedHeadRefOid.slice(0, 9)}${mergeShaInfo}).`,
  );
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
