/**
 * ═══ صندوق «مطلوب مني الآن» — التجميع والحسم (م٧ ق٢) ═══
 *
 * `listDecisionInbox` يجمع من كلّ مصدرٍ يعبر الفاعلُ بوّابتَه، ويُرتّب بالـSLA ثمّ العمر؛
 * و`decideDecision` يوجّه الحسم إلى مصدر النوع بعد فحص البوّابة والطزاجة — فلا يُبلَّغ نجاحٌ
 * على طلبٍ لم يعد معلَّقاً (`STALE`)، ولا يُكتب حسمٌ ثانٍ خارج خدمة المجال.
 *
 * ⚠️ **التغطية ليست كلَّ السجلّ.** `decisionSourceCoverage()` يقول أيُّ الأنواع موصولٌ فعلاً؛
 * النوعُ المُسجَّل غيرُ الموصول يُرفَض حسمُه هنا برسالةٍ تقود إلى شاشته — لا يُخفى ولا يُدّعى.
 */
import { TRPCError } from "@trpc/server";
import {
  DECISION_ACTIONS,
  decisionSpec,
  filterDecisionRows,
  sortDecisionRows,
  type DecisionDecideResult,
  type DecisionInboxFilter,
  type DecisionKind,
  type DecisionRowModel,
} from "@shared/decisionRegistry";
import { appErrorMessage } from "@shared/errors";
import { assertGate } from "./gate";
import { currentDecisionActor, sourceAuthorityPasses, sourceOperationPaths } from "./authority";
import { DECISION_SOURCE_CONTINUATIONS } from "./continuation";
import { sourceCursorSchema, validScanPositions, type SourceCursor, type ScanPosition } from "./scan";
import { decisionKey, MAX_DELIVERED_KEYS, pageBinding, pageCursorSchema, samePageBinding, type PageCursor } from "./paging";
import { loadOperationUserTx, assertOperationAuthorityTx } from "../authorization/operationAuthority";
import { withOperationAuthority } from "../authorization/operationExecutionScope";
import { withTx } from "../tx";
import { assertActionSupported, decided, defaultMessage } from "./rows";
import { OTHER_SOURCES } from "./sources/others";
import { FULFILLMENT_SOURCES } from "./sources/fulfillment";
import { PURCHASING_SOURCES } from "./sources/purchasing";
import { SALES_SOURCES } from "./sources/sales";
import { TREASURY_SOURCES } from "./sources/treasury";
import { costRevaluationSource, costWaveSource, stockAdjustmentSource } from "./sources/inventory";
import type { DecideInput, DecideOptions, DecisionActor, DecisionScope, DecisionSource } from "./types";
import { publishRealtimeEvent } from "../../realtime";
import { REALTIME_EVENT_TYPES, type ApprovalResolvedPayload } from "@shared/realtimeEvents";

export type { DecideInput, DecisionActor, DecisionSource } from "./types";

/** كلُّ المصادر الموصولة — ترتيبُها ترتيبُ الإدراج في الصندوق قبل الفرز. */
export const DECISION_SOURCES: readonly DecisionSource[] = [
  ...PURCHASING_SOURCES,
  stockAdjustmentSource,
  costRevaluationSource,
  costWaveSource,
  ...TREASURY_SOURCES,
  ...SALES_SOURCES,
  ...OTHER_SOURCES,
  ...FULFILLMENT_SOURCES,
];

const SOURCE_BY_KIND: ReadonlyMap<DecisionKind, DecisionSource> = new Map(
  DECISION_SOURCES.flatMap((s) => s.kinds.map((k) => [k, s] as const)),
);

/** الأنواعُ الموصولة بالصندوق فعلاً (تُقاس في الاختبار مقابل السجلّ). */
export function decisionSourceCoverage(): { wired: DecisionKind[]; sources: number } {
  return { wired: Array.from(SOURCE_BY_KIND.keys()), sources: DECISION_SOURCES.length };
}

export function sourceForKind(kind: string): DecisionSource | undefined {
  return SOURCE_BY_KIND.get(kind);
}

export interface DecisionInboxInput extends DecisionInboxFilter {
  sourceCursor?: SourceCursor;
  pageCursor?: PageCursor;
  limit?: number;
  now?: Date;
}

export interface DecisionInboxResult {
  rows: DecisionRowModel[];
  /** عددُ الصفوف قبل القصّ — كي لا يكذب العدّاد حين يُقتطع الصندوق. */
  total: number;
  /** False means total is a lower bound: a domain source clipped candidates, or failed. */
  totalIsExact: boolean;
  hasMore: boolean;
  nextPageCursor: PageCursor | null;
  scanPage: boolean;
  truncatedSources: Array<{ key: string; title: string; limit: number; href: string; cursor?: SourceCursor }>;
  /** الأنواعُ التي يملك الفاعل بوّابتها (للفلتر) — بلا صفوفٍ لها لا يعني أنّها لا تخصّه. */
  kinds: DecisionKind[];
  /** مصادرُ تعثّر سردُها — تُعرَض لا تُبتلَع (الصندوقُ الذي يُخفي فشلَ مصدرٍ يُخفي طابوراً). */
  failedSources: Array<{ key: string; message: string }>;
}

function scopeFor(actor: DecisionActor, filter: DecisionInboxFilter, now: Date): DecisionScope {
  if (filter.branchId != null) {
    if (!actor.crossBranch && actor.branchId !== filter.branchId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر ترشيح الصندوق بهذا الفرع",
          why: `الفرع المطلوب (${filter.branchId}) ليس فرعك المُسنَد`,
          doThis: "اختر فرعك من القائمة، أو اطلب من المالك عبور الفروع",
        }),
      });
    }
    return { branchIds: [filter.branchId], now };
  }
  return { branchIds: null, now };
}

/** يجمع الطلبات المعلَّقة التي يملك الفاعل حقّ حسمها من مصادرها الفعلية. */
export async function listDecisionInbox(actor: DecisionActor, input: DecisionInboxInput = {}): Promise<DecisionInboxResult> {
  actor = currentDecisionActor(actor, await withTx(tx => loadOperationUserTx(tx, actor.userId), { gate: "NONE" }));
  const now = input.now ?? new Date();
  const scope = scopeFor(actor, input, now);
  const eligible = DECISION_SOURCES.filter((s) => sourceAuthorityPasses(s, actor));
  const cursor = input.sourceCursor == null ? undefined : sourceCursorSchema.parse(input.sourceCursor);
  if (cursor && (cursor.userId !== actor.userId || cursor.branchId !== (input.branchId ?? null) ||
      cursor.actorBranchId !== actor.branchId || cursor.crossBranch !== actor.crossBranch ||
      !DECISION_SOURCE_CONTINUATIONS[cursor.source] || !validScanPositions(cursor, input.branchId ?? (actor.crossBranch ? null : actor.branchId)) ||
      cursor.kind !== (input.kind ?? null) || cursor.minAgeHours !== (input.minAgeHours ?? null) ||
      !eligible.some(source => source.key === cursor.source && (!input.kind || source.kinds.includes(input.kind))))) {
    throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({ what: "تعذر متابعة مصدر القرارات", why: "تغير نطاق المصدر أو صلاحية المستخدم", doThis: "أعد تحميل الصندوق لبدء قراءة جديدة" }) });
  }
  if ("offset" in input) {
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذر متابعة صفحة القرارات", why: "لم يعد ترقيم الإزاحة مدعوماً", doThis: "أعد تحميل الصندوق واستعمل مؤشر الصفحة الحالي" }) });
  }
  const binding = pageBinding(actor, input, cursor);
  const parsedPage = input.pageCursor == null ? null : pageCursorSchema.safeParse(input.pageCursor);
  if (parsedPage && (!parsedPage.success || !samePageBinding(parsedPage.data, binding))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذر متابعة صفحة القرارات", why: "مؤشر الصفحة غير صالح أو تغير نطاقه", doThis: "أعد تحميل الصندوق لبدء قراءة جديدة" }) });
  }
  const delivered = new Set(parsedPage?.success ? parsedPage.data.delivered.map(([kind, id]) => `${kind}:${id}`) : []);
  const kinds = eligible.flatMap((s) => [...s.kinds]);
  const failedSources: DecisionInboxResult["failedSources"] = [];
  const truncatedSources: DecisionInboxResult["truncatedSources"] = [];
  const settled = await Promise.all(
    eligible.map(async (s) => {
      if (cursor && cursor.source !== s.key) return [];
      if (input.kind && !s.kinds.includes(input.kind)) return [];
      try {
        const positions: Record<string, ScanPosition | null> = { ...cursor?.positions };
        const rows = await s.list(actor, { ...scope, scanPositions: cursor?.positions,
          reportScan(partition, next) { positions[partition] = next; }, reportLimit(count, limit, hasMore) {
          if (!(hasMore ?? count >= limit)) return;
          if (truncatedSources.some(item => item.key === s.key)) return;
          const href = DECISION_SOURCE_CONTINUATIONS[s.key];
          if (!href) throw new Error(`Missing decision source continuation: ${s.key}`);
          truncatedSources.push({ key: s.key, title: decisionSpec(s.kinds[0]!)!.title, limit, href });
        } });
        const truncated = truncatedSources.find(item => item.key === s.key);
        if (truncated && Object.values(positions).some(position => position != null)) {
          truncated.cursor = { source: s.key, userId: actor.userId, branchId: input.branchId ?? null,
            actorBranchId: actor.branchId, crossBranch: actor.crossBranch,
            kind: input.kind ?? null, minAgeHours: input.minAgeHours ?? null, positions };
        }
        return rows.map(row => ({ ...row,
          allowedActions: row.allowedActions.filter(action => sourceAuthorityPasses(s, actor, action)),
        }));
      } catch (err) {
        // مصدرٌ يتعثّر لا يُسقط الصندوق كلّه ولا يختفي صامتاً — يُبلَّغ باسمه.
        failedSources.push({ key: s.key, message: err instanceof Error ? err.message : String(err) });
        return [] as DecisionRowModel[];
      }
    }),
  );
  const all = filterDecisionRows(settled.flat(), { kind: input.kind ?? null, branchId: null, minAgeHours: input.minAgeHours ?? null });
  const sorted = sortDecisionRows(all);
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  const undelivered = sorted.filter(row => !delivered.has(decisionKey(row)));
  const rows = undelivered.slice(0, limit);
  let nextPageCursor: PageCursor | null = null;
  if (undelivered.length > rows.length) {
    // Compact disappeared/ineligible rows; retain current-window delivered membership before slicing again.
    const progress = new Map(sorted.filter(row => delivered.has(decisionKey(row))).map(row => [decisionKey(row), row]));
    for (const row of rows) progress.set(decisionKey(row), row);
    if (progress.size > MAX_DELIVERED_KEYS) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({ what: "تعذر متابعة صفحة القرارات", why: "بلغ مؤشر الصفحة حد التقدم المحفوظ", doThis: "اختر نوعاً وفرعاً محددين ثم أعد تحميل الصندوق" }) });
    }
    nextPageCursor = { ...binding, delivered: Array.from(progress.values(), row => [row.kind, row.id]) };
    // Advancing a raw source boundary here would skip loaded rows the user has not received.
    for (const source of truncatedSources) delete source.cursor;
  }
  return { rows, total: sorted.length, kinds, failedSources,
    scanPage: cursor != null,
    totalIsExact: truncatedSources.length === 0 && failedSources.length === 0 && !cursor,
    truncatedSources, hasMore: nextPageCursor != null || truncatedSources.length > 0, nextPageCursor };
}

function subjectOf(input: DecideInput): string {
  return `${decisionSpec(input.kind)?.title ?? input.kind} (رقم ${input.id})`;
}


/**
 * يحسم طلباً في مكانه: بوّابةُ المصدر ← طزاجةُ الطلب ← دالّةُ الحسم القائمة داخل خدمتها.
 * `CONFLICT` من الخدمة يُترجَم إلى `STALE` مُهيكَل (تغيّرُ المستند/حُسم من غيرك) لا إلى خطأٍ أحمر.
 */
export async function decideDecision(input: DecideInput, actor: DecisionActor, options: DecideOptions = {}): Promise<DecisionDecideResult> {
  const spec = decisionSpec(input.kind);
  if (!spec) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({ what: "تعذّر حسم القرار", why: `النوع «${input.kind}» غير مُسجَّل في سجلّ القرارات`, doThis: "أعد تحميل الصندوق — قد يكون النوع أُزيل من السجلّ" }),
    });
  }
  const source = SOURCE_BY_KIND.get(input.kind);
  if (!source) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: `تعذّر حسم ${spec.title} من الصندوق`,
        why: "هذا النوع مُسجَّل لكنّه لم يُوصَل بالحسم في مكانه بعد",
        doThis: `افتح شاشته (${spec.href(input.id)}) وقرّر منها`,
      }),
    });
  }
  if (!DECISION_ACTIONS.includes(input.action)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر حسم القرار", why: `الفعل «${String(input.action)}» غير معروف`, doThis: "استعمل اعتماداً أو رفضاً أو سحباً" }) });
  }
  const subject = subjectOf(input);
  assertActionSupported(source, input, subject);
  const current = await withTx(tx => loadOperationUserTx(tx, actor.userId), { gate: "NONE" });
  actor = currentDecisionActor(actor, current);
  const path = sourceOperationPaths(source, input.action)[0];
  if (!path || !sourceAuthorityPasses(source, actor, input.action)) {
    if (source.gate.type === "OWNER" && !actor.isOwner) assertGate(source.gate, actor, subject);
    await withTx(tx => assertOperationAuthorityTx(tx, actor, path ?? "", false), { gate: "NONE" });
    throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({ what: `تعذّر حسم ${subject}`, why: "لا تحمل سلطة الإجراء الأصلي الحالية", doThis: "راجع الإدارة لتحديد صلاحية هذه العملية" }) });
  }

  const freshness = await source.freshness(input.id);
  if (freshness !== "PENDING") {
    return decided(input, "STALE", freshness === "GONE" ? `${subject}: لم يعد موجوداً — أُزيل أو حُذف مستنده.` : defaultMessage("STALE", subject));
  }
  try {
    actor = { ...actor, operationPath: path };
    const res = await withOperationAuthority({ actor, path,
      legacyAllowed: snapshot => sourceAuthorityPasses(source, currentDecisionActor(actor, snapshot), input.action),
      assertCurrent: snapshot => {
        if (!sourceAuthorityPasses(source, currentDecisionActor(actor, snapshot), input.action)) {
          throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({ what: `تعذّر حسم ${subject}`, why: "تغيّرت سلطة العملية الأصلية أو صفة المعتمد", doThis: "حدّث الصندوق وراجع الإدارة لتحديد الصلاحية الحالية" }) });
        }
      },
    }, () => source.decide(input, actor, options));
    try {
      publishRealtimeEvent<ApprovalResolvedPayload>(
        REALTIME_EVENT_TYPES.APPROVAL_RESOLVED,
        {
          entityType: input.kind,
          entityId: input.id,
          decision: res.outcome,
          outcome: res.outcome,
          action: input.action,
          actorUserId: actor.userId,
          managerId: actor.userId,
          branchId: actor.branchId ?? null,
          reason: input.reason ?? null,
        },
      );
    } catch {
      // fail-safe: لا يؤثر فشل البث اللحظي على سلامة حفظ القرار
    }
    return res;
  } catch (err) {
    if (err instanceof TRPCError && err.code === "CONFLICT") {
      return decided(input, "STALE", `${subject}: ${err.message}`);
    }
    throw err;
  }
}
