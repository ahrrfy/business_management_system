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
import { assertGate, gatePasses } from "./gate";
import { decided, defaultMessage } from "./rows";
import { OTHER_SOURCES } from "./sources/others";
import { PURCHASING_SOURCES } from "./sources/purchasing";
import { SALES_SOURCES } from "./sources/sales";
import { TREASURY_SOURCES } from "./sources/treasury";
import { costRevaluationSource, stockAdjustmentSource } from "./sources/inventory";
import type { DecideInput, DecideOptions, DecisionActor, DecisionScope, DecisionSource } from "./types";

export type { DecideInput, DecisionActor, DecisionSource } from "./types";

/** كلُّ المصادر الموصولة — ترتيبُها ترتيبُ الإدراج في الصندوق قبل الفرز. */
export const DECISION_SOURCES: readonly DecisionSource[] = [
  ...PURCHASING_SOURCES,
  stockAdjustmentSource,
  costRevaluationSource,
  ...TREASURY_SOURCES,
  ...SALES_SOURCES,
  ...OTHER_SOURCES,
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
  limit?: number;
  now?: Date;
}

export interface DecisionInboxResult {
  rows: DecisionRowModel[];
  /** عددُ الصفوف قبل القصّ — كي لا يكذب العدّاد حين يُقتطع الصندوق. */
  total: number;
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
  const now = input.now ?? new Date();
  const scope = scopeFor(actor, input, now);
  const eligible = DECISION_SOURCES.filter((s) => gatePasses(s.gate, actor));
  const kinds = eligible.flatMap((s) => [...s.kinds]);
  const failedSources: DecisionInboxResult["failedSources"] = [];
  const settled = await Promise.all(
    eligible.map(async (s) => {
      try {
        return await s.list(actor, scope);
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
  return { rows: sorted.slice(0, limit), total: sorted.length, kinds, failedSources };
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
  assertGate(source.gate, actor, subject);

  const freshness = await source.freshness(input.id);
  if (freshness !== "PENDING") {
    return decided(input, "STALE", freshness === "GONE" ? `${subject}: لم يعد موجوداً — أُزيل أو حُذف مستنده.` : defaultMessage("STALE", subject));
  }
  try {
    return await source.decide(input, actor, options);
  } catch (err) {
    if (err instanceof TRPCError && err.code === "CONFLICT") {
      return decided(input, "STALE", `${subject}: ${err.message}`);
    }
    throw err;
  }
}
