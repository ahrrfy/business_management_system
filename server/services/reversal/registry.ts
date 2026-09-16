/**
 * ═══ سجلُّ المنفّذين الافتراضيّين ═══
 *
 * نوعُ الأثر الذي لا منفّذَ له **يرمي صراحةً** (`NOT_IMPLEMENTED`) — لا يُتخطّى صامتاً ولا يُكتب
 * له صفُّ REVERSE بلا تعويض: صفُّ مرآةٍ بلا فعلٍ هو الكذبةُ التي أمسكها Codex (LC06).
 *
 * الأنواعُ المنفَّذة اليوم هي التي تستعملها مساراتُ الفاتورة الثلاثة فعلاً؛ الباقي
 * (عمولة · عربون · قسط · بطاقة · أوفلاين) يُضاف حين يُوصَل مسارُه بمنفّذٍ مُختبَر.
 *
 * والمستدعي يمرّر منفّذين **يخصّون مستندَه** (قيدُ الفاتورة يختلف عن قيد أمر الشغل) عبر
 * `executors` في خيارات `reverse()` — تُقدَّم على الافتراضيّ.
 */
import { TRPCError } from "@trpc/server";

import { appErrorMessage } from "@shared/errors";
import {
  DOCUMENT_EFFECT_KIND_LABEL_AR,
  type DocumentEffectKind,
} from "@shared/documentEffects";

import {
  customerBalanceExecutor,
  deliveryCustodyExecutor,
  supplierBalanceExecutor,
} from "./executors/balances";
import { couponExecutor } from "./executors/coupon";
import type { EffectExecutor, ExecutorRegistry } from "./types";

/** المنفّذون العامّون — تعويضٌ ميكانيكيٌّ لا يعتمد على نوع المستند. */
export const DEFAULT_EXECUTORS: ExecutorRegistry = {
  CUSTOMER_BALANCE: customerBalanceExecutor,
  SUPPLIER_BALANCE: supplierBalanceExecutor,
  DELIVERY_CUSTODY: deliveryCustodyExecutor,
  COUPON: couponExecutor,
};

export function notImplementedError(kind: DocumentEffectKind): TRPCError {
  return new TRPCError({
    code: "NOT_IMPLEMENTED",
    message: appErrorMessage({
      what: `تعذّر عكس أثرٍ من نوع «${DOCUMENT_EFFECT_KIND_LABEL_AR[kind]}»`,
      why: `محرّك العكس لا يملك منفّذَ تعويضٍ لهذا النوع بعد، ولا يُغلق أثراً ماليّاً بصفّ مرآةٍ بلا تعويضٍ فعليّ`,
      doThis: "أوقف العمليّة وأبلغ مسؤول النظام — يلزم بناءُ منفّذ تعويضٍ لهذا النوع قبل عكس المستند آلياً",
    }),
  });
}

export function resolveExecutor(
  kind: DocumentEffectKind,
  overrides: ExecutorRegistry | undefined,
): EffectExecutor {
  const executor = overrides?.[kind] ?? DEFAULT_EXECUTORS[kind];
  if (!executor) throw notImplementedError(kind);
  return executor;
}
