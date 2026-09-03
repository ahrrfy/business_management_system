// posExternalPayment — إثباتُ القبض غير النقديّ: INITIATED ⇒ CONFIRMED ⇒ استهلاكٌ مرّةً واحدة.
//
// ⚠️ **قاعدةُ صياغةٍ حاكمة لكلّ رسالةٍ في هذا الملفّ:** رفضُه يقع **والزبون واقفٌ وبطاقتُه في
// يده**، ولذلك يجب أن يُميّز بلا لبس بين معنيَين يخلطهما الكاشير فيرفض بيعاً مشروعاً:
//   • «الطريقة ممنوعةٌ أصلاً» — ليست من هنا: تلك رسالةُ `assertInboundPaymentMethodEnabled`
//     (الصكّ والتيليكوم وحدهما)، ومصدرُها [`shared/inboundPaymentPolicy.ts`].
//   • «الطريقة مفتوحةٌ والإثبات ناقص» — كلُّ ما في هذا الملفّ. فالبطاقة والتحويل والمحفظة
//     **مفتوحةٌ للقبض** (سياسة ١٦/٨: بوّابةُ إثباتٍ لا إقفال)، والناقصُ شهادةُ نجاح العملية.
// ⇒ كلُّ `why` هنا يقول ما ينقص من الإثبات، ولا يقول أبداً إنّ الطريقة معطّلة؛ و`doThis` يحيل
//   إلى الزرّ باسمه في الشاشة («تأكيد نجاح الدفع لدى المزوّد») لا إلى «راجع المدير».
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { digitalSaleIntents, externalPaymentAttempts, invoices, receipts,
} from "../../drizzle/schema";
import { getDb, type Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { appErrorMessage } from "@shared/errors";
import { paymentMethodCompact } from "@shared/terms";
import { isDupEntry } from "@shared/errorMap.ar";
import { logger } from "../logger";
import { money, toDbMoney } from "./money";
import { assertPosPaymentMethodEnabled } from "./posPaymentPolicy";
import { createSaleInTx, DIGITAL_SALE_CAPABILITY, notifySaleCustomerAfterCommit,
} from "./sale/create";
import type { CreateSaleInput, CreateSaleResult } from "./sale/types";
import { withTx, type Actor } from "./tx";

export type PosExternalPaymentMethod = "CARD" | "CHECK" | "TRANSFER" | "WALLET";
export type PosExternalPaymentChannel =
  | "POS" | "PRINT_POS"
  | "SALES_COLLECTION";

export type ExternalPaymentVerificationPolicy =
  | "SELF_TERMINAL"
  | "INDEPENDENT_APPROVAL";

export type ExternalPaymentBusinessBinding = {
  type: "INSTALLMENT_LINE";
  id: number;
};

export interface ExternalPaymentAttemptInput {
  branchId: number;
  channel: PosExternalPaymentChannel;
  method: PosExternalPaymentMethod;
  amount: string;
  reference: string;
  requestId: string;
  deviceId: string;
  /** سياسة خادمية؛ راوتر الأقساط يفرضها ولا يأخذها من العميل. */
  verificationPolicy?: ExternalPaymentVerificationPolicy;
  /** مستند العمل الذي لا يجوز استهلاك المحاولة خارجه. */
  businessBinding?: ExternalPaymentBusinessBinding | null;
}

export interface ExternalPaymentBindingInput {
  branchId: number;
  channel: PosExternalPaymentChannel;
  method: string;
  amount: string;
  attemptId?: number | null;
  deviceId?: string | null;
  digitalSaleIntentId?: number | null;
  verificationPolicy?: ExternalPaymentVerificationPolicy;
  businessBinding?: ExternalPaymentBusinessBinding | null;
}

export type LockedExternalPaymentAttempt = typeof externalPaymentAttempts.$inferSelect;

export const INSTALLMENT_EXTERNAL_PAYMENT_PROVIDER =
  "INSTALLMENT_DUAL_CONTROL";

function verificationPolicyOf(
  row: LockedExternalPaymentAttempt,
): ExternalPaymentVerificationPolicy {
  return row.providerCode === INSTALLMENT_EXTERNAL_PAYMENT_PROVIDER
    ? "INDEPENDENT_APPROVAL"
    : "SELF_TERMINAL";
}

function providerCodeFor(input: ExternalPaymentAttemptInput): string {
  return input.verificationPolicy === "INDEPENDENT_APPROVAL"
    ? INSTALLMENT_EXTERNAL_PAYMENT_PROVIDER
    : input.method;
}

function accountReferenceFor(input: {
  branchId: number;
  method: string;
  businessBinding?: ExternalPaymentBusinessBinding | null;
}): string {
  const base = `BRANCH:${input.branchId}:${input.method}`;
  if (!input.businessBinding) return base;
  return `${base}:${input.businessBinding.type}:${input.businessBinding.id}`;
}

function assertVerificationInput(
  input: Pick<
    ExternalPaymentAttemptInput,
    "verificationPolicy" | "businessBinding"
  >,
): void {
  const policy = input.verificationPolicy ?? "SELF_TERMINAL";
  if (policy === "INDEPENDENT_APPROVAL") {
    if (
      input.businessBinding?.type !== "INSTALLMENT_LINE" ||
      !Number.isSafeInteger(input.businessBinding.id) ||
      input.businessBinding.id <= 0
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر فتح محاولة دفعٍ باعتمادٍ مستقلّ",
          why: "هذا المسار خاصٌّ بتحصيل الأقساط ويلزمه رقمُ القسط الذي يُسدَّد، والطلب وصل بلا رقمٍ صالح",
          doThis: "افتح خطة الأقساط واضغط تحصيل على القسط المطلوب — لا تفتح المحاولة من شاشة القبض العامّة",
        }),
      });
    }
    return;
  }
  if (input.businessBinding != null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر فتح محاولة الدفع",
        why: "الطلب يحمل ربطاً بقسطٍ بينما سياسة توثيقه «تأكيدٌ ذاتيّ من جهاز الكاشير»، والقسط لا يُسدَّد إلّا باعتماد موظّفٍ ثانٍ",
        doThis: "لتحصيل قسطٍ استعمل زرّ التحصيل داخل خطة الأقساط؛ ولقبضٍ عاديّ أعِد المحاولة بلا ربط قسط",
      }),
    });
  }
}

function assertVerificationBinding(
  row: LockedExternalPaymentAttempt,
  input: {
    branchId: number;
    method?: string;
    verificationPolicy?: ExternalPaymentVerificationPolicy;
    businessBinding?: ExternalPaymentBusinessBinding | null;
  },
): ExternalPaymentVerificationPolicy {
  const actualPolicy = verificationPolicyOf(row);
  const expectedPolicy = input.verificationPolicy ?? "SELF_TERMINAL";
  if (actualPolicy !== expectedPolicy) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر استعمال إثبات الدفع في هذه الشاشة",
        why: "الإثبات فُتح بسياسة توثيقٍ غير التي تطلبها هذه الشاشة (تحصيلُ قسطٍ باعتماد موظّفَين ≠ قبضٌ يؤكّده الكاشير على جهازه)",
        doThis: "أتمِم العملية من الشاشة التي فُتح منها الإثبات؛ وإن أردتَ القبض هنا فأكّد دفعاً جديداً بمرجع عمليةٍ جديد",
      }),
    });
  }
  if (
    row.accountReference !==
    accountReferenceFor({ ...input, method: input.method ?? row.paymentMethod })
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر استعمال إثبات الدفع على هذا المستند",
        why: "الإثبات مربوطٌ بفرعٍ أو طريقةٍ أو قسطٍ غير الذي يُستهلَك عليه الآن — والمرجع الواحد لا يُنسَب لمستندَين",
        doThis: "افتح المستند الذي فُتح له الإثبات وأتمِمه، أو أكّد دفعاً جديداً بمرجع العملية الصحيح لهذا المستند",
      }),
    });
  }
  return actualPolicy;
}

function assertAttemptActorAuthority(
  row: LockedExternalPaymentAttempt,
  policy: ExternalPaymentVerificationPolicy,
  actor: Actor,
  trustedDigitalRecovery: boolean,
): void {
  if (trustedDigitalRecovery) return;
  if (policy === "INDEPENDENT_APPROVAL") {
    if (
      row.confirmedBy == null ||
      Number(row.createdBy) === Number(row.confirmedBy)
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر سداد القسط",
          why: "تحصيل القسط يلزمه موظّفان: واحدٌ يفتح المحاولة وآخرُ يعتمدها — وهذه لم يعتمدها أحدٌ بعد، أو اعتمدها من فتحها",
          doThis: "اطلب من موظّفٍ آخر أن يعتمد المحاولة من شاشة خطة الأقساط، ثمّ أعِد السداد من حسابه",
        }),
      });
    }
    if (Number(row.createdBy) === actor.userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر سداد القسط بحسابك",
          why: "أنت من فتح محاولة التحصيل، وفصلُ المهام يمنع أن يكون الفاتحُ هو المُسدِّد",
          doThis: "اطلب من الموظّف الذي اعتمد المحاولة أن ينفّذ السداد من حسابه",
        }),
      });
    }
    if (Number(row.confirmedBy) !== actor.userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر سداد القسط بحسابك",
          why: "المحاولة اعتمدها موظّفٌ آخر، والاعتمادُ يستهلكه معتمِدُه وحده كي يبقى القبض منسوباً إلى من شهد به",
          doThis: "اطلب من الموظّف الذي اعتمد المحاولة أن يُتمّ السداد، أو افتح محاولةً جديدة يعتمدها من سيُسدّد",
        }),
      });
    }
    return;
  }
  if (Number(row.createdBy) !== actor.userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر إتمام القبض بهذا الإثبات",
        why: "الإثبات فتحه كاشيرٌ آخر، وهو يُستهلَك على يد من فتحه وأكّده كي يبقى القبض منسوباً إليه",
        doThis: "اطلب من الكاشير الذي فتحه أن يُتمّ البيع من جهازه؛ وإن تعذّر فألغِ العملية على جهاز الدفع وأعِدها من جهازك بمرجعٍ جديد",
      }),
    });
  }
  if (row.confirmedBy == null || Number(row.confirmedBy) !== actor.userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر إتمام القبض بهذا الإثبات",
        why: "الإثبات لم يُثبَّت مؤكَّداً باسمك — الفتحُ وحده لا يكفي، والتأكيدُ هو ما يشهد بنجاح العملية لدى المزوّد",
        doThis: "اضغط «تأكيد نجاح الدفع لدى المزوّد» بعد ظهور العملية ناجحةً على الجهاز، ثمّ أعِد إتمام البيع",
      }),
    });
  }
}

export type ConfirmedPosSaleInput = Omit<CreateSaleInput, "payment"> & {
  payment?:
    | (NonNullable<CreateSaleInput["payment"]> & {
    externalPaymentAttemptId?: number | null;
    /** حجز داخلي للبطاقات الرقمية؛ لا يقبله راوتر البيع العام. */
    externalPaymentIntentId?: number | null;
  }) | null;
  /** حارس القناة العامة؛ تُبقي الاستدعاءات الداخلية القديمة خارج نطاق شريحة POS. */
  requireExternalPaymentAttempt?: boolean;
};

function normalizedReference(value: string): string {
  const reference = value.trim();
  if (!reference) {
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
      what: "تعذّر تأكيد الدفع الخارجي",
      why: "حقل «مرجع العملية» فارغ، والقبضُ غير النقديّ لا يُقيَّد بلا رقم إشعارٍ يربطه بعملية المزوّد",
      doThis: "انسخ رقم الإشعار من شاشة جهاز الدفع (أو رقم التحويل أو عملية المحفظة) إلى حقل «مرجع العملية» ثمّ أكّد",
    }),
    });
  }
  if (reference.length > 100) {
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
      what: "تعذّر تأكيد الدفع الخارجي",
      why: `«مرجع العملية» طوله ${reference.length} محرفاً والحدّ 100 — الحقل لرقم الإشعار وحده لا لوصفٍ`,
      doThis: "اكتب رقم الإشعار كما يظهر على الجهاز فقط، وضع أيّ تفصيلٍ إضافيّ في ملاحظات الفاتورة",
    }),
    });
  }
  return reference.toUpperCase();
}

function accountReference(branchId: number, method: PosExternalPaymentMethod,
): string {
  // الحسابات الخارجية التفصيلية غير مُهيّأة بعد؛ هذا نطاق ثابت وصادق: حساب طريقة الدفع لهذا الفرع.
  return `BRANCH:${branchId}:${method}`;
}

function fingerprintMatches(
  row: LockedExternalPaymentAttempt,
  input: ExternalPaymentAttemptInput,
  actor: Actor,
): boolean {
  return (
    Number(row.branchId) === input.branchId
    && row.channel === input.channel
    && row.paymentMethod === input.method
    && money(row.amount).eq(money(input.amount))
    && row.normalizedReference === normalizedReference(input.reference)
    && row.deviceId === input.deviceId.trim()
    && Number(row.createdBy) === actor.userId
    && row.providerCode === providerCodeFor(input)
    && row.accountReference === accountReferenceFor(input)
  );
}

function publicAttempt(row: LockedExternalPaymentAttempt) {
  return {
    attemptId: Number(row.id),
    state: row.state,
    reference: row.externalReference,
    amount: row.amount,
    method: row.paymentMethod,
  };
}

/**
 * ينشئ INITIATED فقط. لا إيصال ولا فاتورة ولا ذمّة هنا؛ التأكيد والاستهلاك خطوتان منفصلتان.
 * requestId يجعل إعادة إرسال نفس النقرة idempotent، بينما قيد المرجع العالمي يحسم السباق الحقيقي.
 */
export async function initiateExternalPaymentAttempt(input: ExternalPaymentAttemptInput, actor: Actor,
) {
  // fail-closed قبل أي قراءة/كتابة: لا يوجد مزوّد موثوق أو تسوية تؤكد القبض.
  assertPosPaymentMethodEnabled(input.method);
  assertVerificationInput(input);
  const amount = money(input.amount);
  if (!amount.isFinite() || !amount.gt(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
      what: "تعذّر تأكيد الدفع الخارجي",
      why: `المبلغ المُرسَل «${String(input.amount)}» ليس عدداً موجباً، ولا يُفتَح إثباتُ قبضٍ بمبلغٍ صفريّ أو سالب`,
      doThis: "صحّح مبلغ الدفع في الشاشة ليكون أكبر من صفر، ثمّ اضغط «تأكيد نجاح الدفع لدى المزوّد» من جديد",
    }),
    });
  }
  const reference = input.reference.trim();
  const normalized = normalizedReference(reference);
  const requestId = input.requestId.trim();
  if (!requestId || requestId.length > 80) {
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
      what: "تعذّر تأكيد الدفع الخارجي",
      why: `الطلب وصل بلا معرّفٍ صالحٍ يمنع التكرار (طوله ${requestId.length} والحدّ 80، ولا يصحّ فارغاً) — وهو ما يمنع تسجيل قبضين لضغطةٍ واحدة`,
      doThis: "أعِد تحميل شاشة الكاشير ثمّ أعِد التأكيد؛ فإن تكرّر الرفض فأبلِغ مسؤول النظام — العطب في الشاشة لا في عمليّتك",
    }),
    });
  }
  const deviceId = input.deviceId.trim();
  if (!deviceId || deviceId.length > 64) {
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
      what: "تعذّر تأكيد الدفع الخارجي",
      why: `هويّة جهاز الكاشير غير صالحة (طولها ${deviceId.length} والحدّ 64، ولا تصحّ فارغة)، والإثبات يُقفَل على الجهاز الذي جرت عليه العملية`,
      doThis: "أعِد تحميل الشاشة على جهاز الكاشير نفسه ثمّ أعِد التأكيد؛ فإن تكرّر فأبلِغ مسؤول النظام بأنّ الجهاز لا يُصدِر هويّته",
    }),
    });
  }

  try {
    return await withTx(async (tx) => {
      const existing = (await tx
        .select()
        .from(externalPaymentAttempts)
        .where(and(
          eq(externalPaymentAttempts.createdBy, actor.userId),
          eq(externalPaymentAttempts.requestId, requestId),
        ),
          )
        .limit(1))[0];
      if (existing) {
        if (!fingerprintMatches(existing, input, actor)) {
          throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
            what: "تعذّر تأكيد الدفع الخارجي",
            why: `نفس معرّف الطلب سُجِّل قبل قليل بإثباتٍ آخر (مبلغه ${money(existing.amount).toFixed(2)} ومرجعه ${existing.externalReference})، وإعادةُ الإرسال لا تُبدّل إثباتاً قائماً`,
            doThis: "أعِد تحميل شاشة الكاشير لتبدأ محاولةً جديدة، ثمّ أدخِل مرجع العملية والمبلغ الصحيحين وأكّد",
          }),
          });
        }
        return publicAttempt(existing);
      }

      const inserted = await tx.insert(externalPaymentAttempts).values({
        branchId: input.branchId,
        channel: input.channel,
        paymentMethod: input.method,
        amount: toDbMoney(amount),
        providerCode: providerCodeFor(input),
        accountReference: accountReferenceFor(input),
        deviceId,
        externalReference: reference,
        normalizedReference: normalized,
        state: "INITIATED",
        requestId,
        createdBy: actor.userId,
      });
      const id = extractInsertId(inserted);
      const row = (await tx.select().from(externalPaymentAttempts).where(eq(externalPaymentAttempts.id, id)).limit(1))[0]!;
      return publicAttempt(row);
    });
  } catch (error) {
    if (!isDupEntry(error)) throw error;

    // سباق إعادة إرسال requestId نفسه: استرجع الفائز فقط إن كانت البصمة مطابقة.
    const db = getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: appErrorMessage({
      what: "تعذّر إكمال تأكيد الدفع الخارجي",
      why: "الاتصال بقاعدة البيانات منقطعٌ الآن، فلا سبيل للتحقّق من الإثبات المسجَّل",
      doThis: "لا تُمرّر البطاقة ثانيةً — تحقّق من حالة العملية على جهاز الدفع، وأبلِغ مسؤول النظام، وأعِد التأكيد بعد عودة الاتصال",
    }),
      });
    const existing = (await db
      .select()
      .from(externalPaymentAttempts)
      .where(and(
        eq(externalPaymentAttempts.createdBy, actor.userId),
        eq(externalPaymentAttempts.requestId, requestId),
      ),
        )
      .limit(1))[0];
    if (existing && fingerprintMatches(existing, input, actor)) return publicAttempt(existing);
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر تسجيل هذه العملية",
        why: `مرجع العملية «${normalized}» مسجَّلٌ سلفاً على إثبات دفعٍ آخر، والمرجع أحاديُّ الاستعمال كي لا يُقيَّد قبضٌ واحد مرّتين`,
        doThis: "افتح البيع السابق الذي يحمل هذا المرجع وأتمِمه؛ وإن كانت عمليةً جديدة فعلاً فأدخِل رقم الإشعار الصحيح من جهاز الدفع",
      }),
    });
  }
}

/** انتقال INITIATED→CONFIRMED مسجّل في الخادم؛ لا يغيّر الفاتورة أو الدفتر بعد. */
export async function confirmExternalPaymentAttempt(
  input: { attemptId: number; branchId: number; channel: PosExternalPaymentChannel; deviceId: string;
    verificationPolicy?: ExternalPaymentVerificationPolicy;
    businessBinding?: ExternalPaymentBusinessBinding | null;
  },
  actor: Actor,
) {
  // لا يجوز تحويل مرجعٍ ذاتي الإدخال إلى CONFIRMED مهما كان الدور.
  assertPosPaymentMethodEnabled("CARD");
  return withTx(async (tx) => {
    const row = (await tx
      .select()
      .from(externalPaymentAttempts)
      .where(eq(externalPaymentAttempts.id, input.attemptId))
      .for("update")
      .limit(1))[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({
      what: "تعذّر تأكيد الدفع الخارجي",
      why: `لا إثباتَ دفعٍ بالرقم ${input.attemptId} في السجلّ — يبدو أنّ الشاشة تحمل محاولةً قديمة`,
      doThis: "أعِد تحميل شاشة الكاشير، ثمّ أدخِل مرجع العملية واضغط «تأكيد نجاح الدفع لدى المزوّد» من جديد",
    }),
      });
    if (Number(row.branchId) !== input.branchId || row.channel !== input.channel) {
      throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({
        what: "تعذّر تأكيد الدفع الخارجي",
        why: "الإثبات فُتح على فرعٍ أو شاشةٍ أخرى، ولا يعبر بينهما كي لا يُنسَب قبضُ فرعٍ إلى غيره",
        doThis: "أكّده من الفرع والشاشة اللذين فُتح منهما، أو أكّد دفعاً جديداً هنا بمرجع عمليةٍ جديد",
      }),
      });
    }
    const policy = assertVerificationBinding(row, input);
    if (policy === "INDEPENDENT_APPROVAL") {
      if (Number(row.createdBy) === actor.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذّر اعتماد محاولة تحصيل القسط",
            why: "أنت من فتح المحاولة، وفصلُ المهام يوجب أن يعتمدها موظّفٌ آخر شهدَ نجاح العملية",
            doThis: "اطلب من زميلٍ مخوَّل أن يعتمد المحاولة من شاشة خطة الأقساط ثمّ يُتمّ السداد من حسابه",
          }),
        });
      }
    } else if (Number(row.createdBy) !== actor.userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر تأكيد الدفع الخارجي",
          why: "الإثبات فتحه كاشيرٌ آخر، والتأكيدُ شهادةٌ على نجاح العملية يوقّعها من فتحها",
          doThis: "اطلب من الكاشير الذي فتحه أن يؤكّده ويُتمّ البيع، أو ألغِ العملية على الجهاز وأعِدها من شاشتك بمرجعٍ جديد",
        }),
      });
    }
    if (row.deviceId !== input.deviceId.trim()) {
      throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({
        what: "تعذّر تأكيد الدفع الخارجي",
        why: "الإثبات مقفولٌ على الجهاز الذي مُرِّرت عليه العملية، والتأكيد يجري الآن من جهازٍ آخر",
        doThis: "أكمِل التأكيد والبيع من الجهاز الذي فُتح عليه الإثبات؛ وإن كان معطّلاً فألغِ العملية عليه وأعِدها من هنا بمرجعٍ جديد",
      }),
      });
    }
    if (row.state === "CONFIRMED") return publicAttempt(row);
    if (row.state !== "INITIATED") {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
        what: "تعذّر تأكيد الدفع الخارجي",
        why: `حالة الإثبات ${row.state} لا INITIATED، والتأكيد لا يقع إلّا على محاولةٍ ما تزال مفتوحة`,
        doThis: "أدخِل مرجع العملية من جديد لتُفتَح محاولةٌ جديدة ثمّ أكّدها؛ ولا تُمرّر البطاقة ثانيةً قبل التحقّق من الجهاز",
      }),
      });
    }
    if (row.invoiceId != null || row.receiptId != null) {
      // الشرط «أو» ⇒ قد يكون أحدُ الرقمين فارغاً: نذكر الموجود وحده بدل طباعة صفرٍ كاذب.
      const consumedOn = row.invoiceId != null
        ? `الفاتورة رقم ${Number(row.invoiceId)}`
        : `الإيصال رقم ${Number(row.receiptId)}`;
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
        what: "تعذّر تأكيد الدفع الخارجي",
        why: `الإثبات استُهلك سلفاً على ${consumedOn}، ولا يُقبض المرجع الواحد مرّتين`,
        doThis: "افتح ذلك المستند وتحقّق أنّه المطلوب؛ وإن كانت عمليةً جديدة فأدخِل مرجعاً جديداً وأكّده",
      }),
      });
    }
    await tx
      .update(externalPaymentAttempts)
      .set({ state: "CONFIRMED", confirmedBy: actor.userId, confirmedAt: new Date(),
      })
      .where(eq(externalPaymentAttempts.id, row.id));
    return publicAttempt({ ...row, state: "CONFIRMED", confirmedBy: actor.userId, confirmedAt: new Date(),
    });
  });
}

/**
 * يقفل محاولة مؤكدة قبل أي كتابة أعمال. صفّ المحاولة يبقى مقفولاً حتى التزام/تراجع معاملة البيع،
 * لذلك لا يستطيع POS وPrintPOS استهلاك المرجع نفسه بالتوازي.
 */
export async function lockConfirmedExternalPaymentAttempt(
  tx: Tx,
  input: ExternalPaymentBindingInput,
  actor: Actor,
): Promise<LockedExternalPaymentAttempt> {
  assertPosPaymentMethodEnabled(input.method);
  if (input.method === "CASH") {
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
      what: "تعذّر إتمام القبض النقديّ",
      why: "الطلب وصل نقداً ومعه إثبات دفعٍ خارجيّ، والنقدُ يدخل الدرج مباشرةً بلا جهاز",
      doThis: "إن قبضتَ نقداً فأتمِم البيع بلا تأكيد دفعٍ خارجيّ؛ وإن مرّرتَ البطاقة فاختر «بطاقة» ليُستهلَك إثبات الجهاز مع الإيصال",
    }),
    });
  }
  if (!input.attemptId) {
    // ⚠️ «أكّد الدفع الخارجي قبل إتمام البيع» أوّلَ النصّ: تُطابقه اختبارات fail-closed
    // (`posPaymentFailClosedApi`) بالتعبير النمطيّ — أعِد صياغة ما بعده لا هو.
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
      what: "أكّد الدفع الخارجي قبل إتمام البيع",
      why: `طريقة ${paymentMethodCompact(input.method)} مفتوحةٌ للقبض، لكنّ هذا البيع وصل بلا إثباتٍ مؤكَّدٍ من جهاز الدفع يُستهلَك مع الإيصال`,
      doThis: "أدخِل «مرجع العملية» واضغط «تأكيد نجاح الدفع لدى المزوّد» حتى تظهر «الدفع مؤكّد خادمياً»، ثمّ أتمِم البيع",
    }),
    });
  }
  const row = (await tx
    .select()
    .from(externalPaymentAttempts)
    .where(eq(externalPaymentAttempts.id, input.attemptId))
    .for("update")
    .limit(1))[0];
  if (!row) throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
    what: "تعذّر إتمام البيع",
    why: `الإثبات المُرفَق بالبيع (رقم ${input.attemptId}) غير موجودٍ في السجلّ`,
    doThis: "أعِد تحميل شاشة الكاشير وأكّد الدفع من جديد قبل إتمام البيع — ولا تُمرّر البطاقة ثانيةً قبل التحقّق من الجهاز",
  }),
    });
  if (Number(row.branchId) !== input.branchId || row.channel !== input.channel) {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: "تعذّر إتمام البيع بهذا الإثبات",
      why: "الإثبات فُتح على فرعٍ أو شاشةٍ أخرى، ولا يعبر بينهما كي لا يُنسَب قبضُ فرعٍ إلى غيره",
      doThis: "أتمِم البيع من الفرع والشاشة اللذين أُكّد فيهما الدفع، أو أكّد دفعاً جديداً هنا بمرجع عمليةٍ جديد",
    }),
    });
  }
  const verificationPolicy = assertVerificationBinding(row, input);
  if (row.paymentMethod !== input.method) {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: "تعذّر إتمام البيع",
      why: `الإثبات مؤكَّدٌ على «${paymentMethodCompact(row.paymentMethod)}» والبيع يُتمّ بـ«${paymentMethodCompact(input.method)}» — والقبضُ يُنسَب إلى طريقته لا إلى ما يُختار في الشاشة`,
      doThis: "اختر في الشاشة الطريقة التي أُكّد بها الدفع فعلاً؛ وإن كانت الطريقة الأخرى هي الصحيحة فألغِ العملية على الجهاز وأعِدها بها ثمّ أكّد",
    }),
    });
  }
  if (!money(row.amount).eq(money(input.amount))) {
    // فرقٌ باتّجاهه: الكاشير يحتاج أن يعرف أيّ الرقمين يُصحَّح، لا أنّهما «لا يتطابقان».
    const gap = money(input.amount).minus(money(row.amount));
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: "تعذّر إتمام البيع",
      why: `الإثبات مؤكَّدٌ على ${money(row.amount).toFixed(2)} والبيع يطلب ${money(input.amount).toFixed(2)} — الفرق ${gap.abs().toFixed(2)} ${gap.gt(0) ? "زيادةً في البيع" : "نقصاً عن الجهاز"}`,
      doThis: "إن كان الصحيح ما على الجهاز فصحّح مبلغ البيع ليطابقه؛ وإلّا ألغِ العملية على الجهاز وأعِد تمريرها بالمبلغ الصحيح ثمّ أكّد من جديد",
    }),
    });
  }
  if ((row.deviceId ?? null) !== (input.deviceId?.trim() || null)) {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: "تعذّر إتمام البيع",
      why: "الإثبات مقفولٌ على الجهاز الذي مُرِّرت عليه العملية، والبيع يُتمّ الآن من جهازٍ آخر",
      doThis: "أتمِم البيع من الجهاز الذي أُكّد عليه الدفع؛ وإن تعذّر فألغِ العملية على جهاز الدفع وأعِدها من هذا الجهاز بمرجعٍ جديد",
    }),
    });
  }
  if (row.state !== "CONFIRMED" || row.confirmedAt == null) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
      what: "تعذّر إتمام البيع — الدفع الخارجي غير مؤكّد بعد",
      why: `الطريقة نفسها مفتوحةٌ للقبض، والناقصُ شهادةُ نجاح العملية لدى المزوّد: حالة الإثبات ${row.state} لا CONFIRMED`,
      doThis: "اضغط «تأكيد نجاح الدفع لدى المزوّد» بعد ظهور العملية ناجحةً على الجهاز، ثمّ أتمِم البيع",
    }),
    });
  }
  if (row.invoiceId != null || row.receiptId != null || row.consumedAt != null) {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: "تعذّر إتمام البيع بهذا الإثبات",
      why: row.invoiceId != null
        ? `الإثبات استُهلك في الفاتورة رقم ${Number(row.invoiceId)}، والمرجع الواحد يُقبض مرّةً واحدة`
        : "الإثبات مُعلَّمٌ مستهلَكاً في بيعٍ سابق، والمرجع الواحد يُقبض مرّةً واحدة",
      doThis: "افتح البيع السابق وتحقّق أنّه هو المطلوب؛ وإن كانت عمليةً جديدة فمرّرها على الجهاز وأكّدها بمرجعٍ جديد",
    }),
    });
  }
  const linkedIntent = (await tx
    .select({ id: digitalSaleIntents.id })
    .from(digitalSaleIntents)
    .where(eq(digitalSaleIntents.externalPaymentAttemptId, row.id))
    .limit(1))[0];
  if (linkedIntent && Number(linkedIntent.id) !== input.digitalSaleIntentId) {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: "تعذّر إتمام البيع بهذا الإثبات",
      why: `الإثبات محجوزٌ لبيع بطاقاتٍ رقمية آخر (نيّة رقم ${Number(linkedIntent.id)})، ولا يُصرَف إلّا عليه`,
      doThis: "أكمِل بيع البطاقات الرقمية المرتبط به من شاشة البطاقات، أو أكّد دفعاً جديداً لهذا البيع بمرجعٍ جديد",
    }),
    });
  }
  if (input.digitalSaleIntentId != null && (!linkedIntent || Number(linkedIntent.id) !== input.digitalSaleIntentId)) {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: "تعذّر إصدار البطاقات الرقمية",
      why: `الإثبات المؤكَّد ليس المربوط بنيّة البيع الرقميّ رقم ${input.digitalSaleIntentId} — والربطُ بينهما أحاديٌّ كي لا تُصرَف كروتٌ بقبضٍ يخصّ بيعاً آخر`,
      doThis: "افتح النيّة من شاشة البطاقات الرقمية واستعمل إثباتها المرتبط بها؛ وإن ضاع الربط فأبلِغ المدير لإنقاذ النيّة",
    }),
    });
  }
  // إنقاذ نيّة رقمية NEEDS_REVIEW ينفّذه مدير بعد إصدار الكروت. الربط الفريد بالنيّة
  // هو التفويض هنا؛ نبقي createdBy/confirmedBy الأصليين ولا ننسب التأكيد إلى المدير.
  const trustedDigitalRecovery = input.digitalSaleIntentId != null
    && linkedIntent != null
    && Number(linkedIntent.id) === input.digitalSaleIntentId
    && (actor.role === "admin" || actor.role === "manager");
  assertAttemptActorAuthority(row, verificationPolicy, actor, trustedDigitalRecovery);
  return row;
}

/** بصمة idempotency: نفس المفتاح لا يجوز أن يعيد فاتورةً بمحاولة أخرى. */
export async function assertExternalPaymentReplay(
  tx: Tx,
  invoiceId: number,
  input: ExternalPaymentBindingInput,
  actor: Actor,
  expectedReceiptId?: number | null,
): Promise<void> {
  assertPosPaymentMethodEnabled(input.method);
  if (input.method === "CASH") {
    if (input.attemptId != null) throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: "تعذّر إعادة إرسال البيع النقديّ",
      why: "الفاتورة الأصلية نقديةٌ بلا إثباتٍ خارجيّ، والإعادة وصلت ومعها إثبات دفع — فالمفتاح الواحد يصف بيعَين مختلفَين",
      doThis: "أعِد تحميل الشاشة واقرأ حالة الفاتورة الأصلية أوّلاً؛ وإن أردتَ قبضاً بالبطاقة فسجّله دفعةً على تلك الفاتورة لا بيعاً جديداً",
    }),
      });
    return;
  }
  // ⚠️ «أكّد الدفع الخارجي» أوّلَ النصّ: يُطابقه `nonCashScreensEnabled` بالتعبير النمطيّ.
  if (!input.attemptId) throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
    what: "أكّد الدفع الخارجي قبل إعادة المحاولة",
    why: "الإعادة وصلت بلا رقم الإثبات، والمقارنةُ مع البيع الأصليّ تجري على الإثبات نفسه لا على المبلغ وحده",
    doThis: "أعِد تحميل الشاشة لتسترجع إثبات العملية الأصليّ ثمّ أعِد الإرسال — ولا تُمرّر البطاقة ثانيةً قبل ذلك",
  }),
    });
  const row = (await tx
    .select()
    .from(externalPaymentAttempts)
    .where(eq(externalPaymentAttempts.id, input.attemptId))
    .limit(1))[0];
  if (!row ||
    row.state !== "CONFIRMED" ||
    row.confirmedAt == null ||
    row.consumedAt == null ||
    Number(row.invoiceId) !== invoiceId || row.receiptId == null) {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: `تعذّر إعادة إرسال البيع (تعارض idempotency على الفاتورة ${invoiceId})`,
      why: "الإثبات المُرفَق ليس الذي قُبض به البيع الأصليّ، أو لم يُستهلَك عليه بعد",
      doThis: "أعِد تحميل الشاشة واقرأ الفاتورة من قائمة المبيعات: إن كانت مسجَّلةً فلا تُعِد الإرسال، وإلّا فابدأ بيعاً جديداً بإثباتٍ جديد",
    }),
    });
  }
  if (
    expectedReceiptId != null &&
    Number(row.receiptId) !== Number(expectedReceiptId)
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: `تعذّر إعادة إرسال البيع (تعارض idempotency على الفاتورة ${invoiceId})`,
        why: `الإثبات مرتبطٌ بالإيصال رقم ${Number(row.receiptId)} بينما المتوقَّع لهذه الإعادة الإيصال رقم ${Number(expectedReceiptId)}`,
        doThis: "افتح الفاتورة من قائمة المبيعات وراجع إيصالها قبل أيّ إعادة، وأبلِغ مسؤول النظام برقمَي الإيصال إن اختلفا فعلاً",
      }),
    });
  }
  const receipt = (
    await tx
      .select({
        id: receipts.id,
        invoiceId: receipts.invoiceId,
        amount: receipts.amount,
        paymentMethod: receipts.paymentMethod,
        referenceNumber: receipts.referenceNumber,
      })
      .from(receipts)
      .where(eq(receipts.id, Number(row.receiptId)))
      .limit(1)
  )[0];
  if (
    !receipt ||
    Number(receipt.invoiceId) !== invoiceId ||
    receipt.paymentMethod !== row.paymentMethod ||
    !money(receipt.amount).eq(money(row.amount)) ||
    (receipt.referenceNumber?.trim() || null) !== row.externalReference.trim()
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: `تعذّر إعادة إرسال البيع (تعارض idempotency على الفاتورة ${invoiceId})`,
        why: "إيصال الفاتورة لا يطابق الإثبات في فاتورته أو طريقته أو مبلغه أو مرجعه",
        doThis: "افتح الفاتورة وراجع إيصالها؛ ولا تُعِد الإرسال قبل أن يفحص مسؤول النظام سبب الاختلاف",
      }),
    });
  }
  if (
    Number(row.branchId) !== input.branchId || row.channel !== input.channel || row.paymentMethod !== input.method || !money(row.amount).eq(money(input.amount))) {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: `تعذّر إعادة إرسال البيع (تعارض idempotency على الفاتورة ${invoiceId})`,
      why: `بيانات هذه الإعادة تخالف البيع الأصليّ: المسجَّل ${paymentMethodCompact(row.paymentMethod)} بمبلغ ${money(row.amount).toFixed(2)}، والوارد ${paymentMethodCompact(input.method)} بمبلغ ${money(input.amount).toFixed(2)}`,
      doThis: "أعِد تحميل الشاشة واقرأ الفاتورة الأصلية؛ ولبيعٍ مختلف ابدأ عمليةً جديدة بمفتاحٍ وإثباتٍ جديدين",
    }),
    });
  }
  const verificationPolicy = assertVerificationBinding(row, input);
  if (row.deviceId !== (input.deviceId?.trim() || null)) {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: `تعذّر إعادة إرسال البيع (تعارض idempotency على الفاتورة ${invoiceId})`,
      why: "الإعادة وصلت من جهازٍ غير الذي مُرِّر عليه الدفع في البيع الأصليّ",
      doThis: "أعِد الإرسال من الجهاز الأصليّ؛ وإن كان معطّلاً فافتح الفاتورة من قائمة المبيعات وتأكّد من تسجيلها بدل إعادة الإرسال",
    }),
    });
  }
  let linkedIntentId: number | null = null;
  if (input.digitalSaleIntentId != null) {
    const linkedIntent = (await tx
      .select({ id: digitalSaleIntents.id })
      .from(digitalSaleIntents)
      .where(eq(digitalSaleIntents.externalPaymentAttemptId, row.id))
      .limit(1))[0];
    if (!linkedIntent || Number(linkedIntent.id) !== input.digitalSaleIntentId) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
        what: "تعذّر إعادة إرسال بيع البطاقات الرقمية (تعارض idempotency)",
        why: `الإثبات ليس المربوط بنيّة البيع الرقميّ رقم ${input.digitalSaleIntentId}`,
        doThis: "افتح النيّة من شاشة البطاقات الرقمية وأكمِلها بإثباتها المرتبط — ولا تُصدَر كروتٌ بإثباتٍ يخصّ بيعاً آخر",
      }),
      });
    }
    linkedIntentId = Number(linkedIntent.id);
  }
  const trustedDigitalRecovery = linkedIntentId != null && (actor.role === "admin" || actor.role === "manager");
  assertAttemptActorAuthority(row, verificationPolicy, actor, trustedDigitalRecovery);
}

/** يُستهلك الصف المقفول في نفس معاملة invoice+receipt+ledger؛ أي فشل لاحق يعيد الأربعة معاً. */
export async function bindExternalPaymentAttempt(
  tx: Tx,
  attemptId: number,
  invoiceId: number,
  receiptId: number,
): Promise<void> {
  const result: any = await tx
    .update(externalPaymentAttempts)
    .set({ invoiceId, receiptId, consumedAt: new Date() })
    .where(and(
      eq(externalPaymentAttempts.id, attemptId),
      eq(externalPaymentAttempts.state, "CONFIRMED"),
      sql`${externalPaymentAttempts.invoiceId} IS NULL`,
      sql`${externalPaymentAttempts.receiptId} IS NULL`,
    ),
    );
  if (Number(result?.[0]?.affectedRows ?? result?.affectedRows ?? 0) !== 1) {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: "تعذّر ربط القبض بالفاتورة — تراجعت العملية بالكامل",
      why: `الإثبات رقم ${attemptId} لم يعد قابلاً للاستهلاك مرّةً واحدة (استُهلك بالتوازي أو تغيّرت حالته أثناء الحفظ)`,
      doThis: "أعِد تحميل الشاشة وتحقّق من قائمة المبيعات أنّ الفاتورة لم تُسجَّل — ولا تُمرّر البطاقة ثانيةً قبل ذلك",
    }),
    });
  }
}

/**
 * منفذ الاستهلاك الحاكم لكل قبضٍ غير نقديّ في نواة المبيعات.
 *
 * يقفل المحاولة المؤكدة ويتحقق من الفرع/القناة/الطريقة/المبلغ/الجهاز/الفاعل، ثم يترك
 * للكاتب المالي إنشاء الفاتورة والإيصال داخل **المعاملة نفسها**، وأخيراً يربط المحاولة
 * بالإيصال مرةً واحدة. أي فشل في الكاتب أو الربط يُرجع القبض والفاتورة والقيد معاً.
 */
export async function consumeConfirmedExternalPaymentAttemptTx<T>(
  tx: Tx,
  input: ExternalPaymentBindingInput,
  actor: Actor,
  consume: (attempt: LockedExternalPaymentAttempt) => Promise<{
    invoiceId: number;
    receiptId: number;
    value: T;
  }>,
): Promise<T> {
  const attempt = await lockConfirmedExternalPaymentAttempt(tx, input, actor);
  const consumed = await consume(attempt);
  await bindExternalPaymentAttempt(
    tx,
    Number(attempt.id),
    consumed.invoiceId,
    consumed.receiptId,
  );
  return consumed.value;
}

function coreSaleInput(input: ConfirmedPosSaleInput, reference?: string,
): CreateSaleInput {
  const { requireExternalPaymentAttempt: _required, payment, ...rest } = input;
  return {
    ...rest,
    payment: payment
      ? {
          amount: payment.amount,
          method: payment.method,
          reference: reference ?? payment.reference ?? null,
        }
      : null,
  };
}

/**
 * تركيب قناة POS: التأكيد الخارجي + الفاتورة + الإيصال + الاستهلاك في معاملة واحدة.
 * نواة البيع العامة تبقى قابلةً لمساراتها الداخلية، أمّا الراوتر العام والبطاقات الرقمية فيمران هنا.
 */
export async function createConfirmedPosSaleInTx(
  tx: Tx,
  input: ConfirmedPosSaleInput,
  actor: Actor,
  capability?: typeof DIGITAL_SALE_CAPABILITY,
): Promise<CreateSaleResult> {
  const payment = input.payment;
  if (payment) assertPosPaymentMethodEnabled(payment.method);
  if (!payment) {
    return createSaleInTx(tx, coreSaleInput(input), actor, capability);
  }
  // اشتراط المحاولة يُشتق من **الدفع نفسه** لا من علامةٍ يرسلها المستدعي: علامةٌ منسيّةٌ
  // (أو مستدعٍ جديد) كانت تكفي لتثبيت قبضٍ غير نقديّ بلا أيّ إثبات. النقد وحده يعبُر بلا محاولة.
  if (payment.method === "CASH") {
    if (payment.externalPaymentAttemptId != null) {
      throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
        what: "تعذّر إتمام البيع النقديّ",
        why: "الطلب اختار النقد ومعه إثبات دفعٍ خارجيّ، والنقدُ يدخل الدرج مباشرةً بلا جهاز",
        doThis: "إن قبضتَ نقداً فأعِد إتمام البيع بلا تأكيد دفعٍ خارجيّ؛ وإن مرّرتَ البطاقة فاختر «بطاقة» ليُستهلَك إثبات الجهاز",
      }),
      });
    }
    return createSaleInTx(tx, coreSaleInput(input), actor, capability);
  }

  // الإعادة التسلسلية تُعيد الفاتورة فقط إن كانت محاولة القبض نفسها مرتبطة بها.
  // نترك createSaleInTx يعيد فحص بصمة السلة/العميل/الطريقة قبل كشف النتيجة.
  const existingInvoice = input.clientRequestId
    ? (await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(eq(invoices.sourceId, input.clientRequestId))
        .limit(1))[0]
    : null;
  if (existingInvoice) {
    const replay = await createSaleInTx(tx, coreSaleInput(input), actor, capability,
    );
    await assertExternalPaymentReplay(tx, replay.invoiceId, {
      branchId: input.branchId,
      channel: "POS",
      method: payment.method,
      amount: payment.amount,
      attemptId: payment.externalPaymentAttemptId,
      deviceId: input.deviceId,
      digitalSaleIntentId: payment.externalPaymentIntentId,
    }, actor,
    );
    return replay;
  }

  return consumeConfirmedExternalPaymentAttemptTx(tx, {
    branchId: input.branchId,
    channel: "POS",
    method: payment.method,
    amount: payment.amount,
    attemptId: payment.externalPaymentAttemptId,
    deviceId: input.deviceId,
    digitalSaleIntentId: payment.externalPaymentIntentId,
  }, actor,
    async (attempt) => {
      const sale = await createSaleInTx(tx, coreSaleInput(input, attempt.externalReference), actor, capability,
      );
  if (sale.idempotentReplay) {
    await assertExternalPaymentReplay(tx, sale.invoiceId, {
      branchId: input.branchId,
      channel: "POS",
      method: payment.method,
      amount: payment.amount,
      attemptId: payment.externalPaymentAttemptId,
      deviceId: input.deviceId,
      digitalSaleIntentId: payment.externalPaymentIntentId,
    }, actor,
        );
        // هذه الحالة لا تصل عملياً بعد lockConfirmed (المحاولة المستهلكة تُرفض)، لكن إبقاء
        // الحارس يجعل انحراف idempotency صريحاً بدل ربطٍ ثانٍ إن تغير ترتيب الاستدعاءات.
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إتمام البيع — تراجعت الفاتورة بالكامل (تعارض idempotency أثناء استهلاك الإثبات)",
            why: "نواةُ البيع أعادت فاتورةً سابقة بينما الإثبات لم يُستهلَك بعد، وربطُه ثانيةً يُنتج قبضاً مزدوجاً",
            doThis: "أعِد تحميل الشاشة واقرأ الفاتورة من قائمة المبيعات قبل أيّ إعادة، وأبلِغ مسؤول النظام برقم مرجع العملية",
          }),
        });
  }

  const receipt = (await tx
    .select({ id: receipts.id, amount: receipts.amount, paymentMethod: receipts.paymentMethod,
          })
    .from(receipts)
    .where(eq(receipts.invoiceId, sale.invoiceId))
    .orderBy(desc(receipts.id))
    .limit(1))[0];
  if (!receipt || receipt.paymentMethod !== payment.method || !money(receipt.amount).eq(money(attempt.amount))) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: appErrorMessage({
        what: "تعذّر إتمام البيع — تراجعت الفاتورة بالكامل",
        why: `لم يُنشأ إيصالٌ يطابق الإثبات: المتوقَّع ${paymentMethodCompact(payment.method)} بمبلغ ${money(attempt.amount).toFixed(2)}، ولا تُقفَل فاتورةٌ بقبضٍ لا يطابق إثباته`,
        doThis: "لا تُمرّر البطاقة ثانيةً — تحقّق من حالة العملية على الجهاز، وأبلِغ مسؤول النظام بمرجع العملية قبل أيّ إعادة بيع",
      }),
    });
  }
      return {
        invoiceId: sale.invoiceId,
        receiptId: Number(receipt.id),
        value: sale,
      };
},
  );
}

export async function createConfirmedPosSale(
  input: ConfirmedPosSaleInput,
  actor: Actor,
): Promise<CreateSaleResult> {
  const result = await withTx((tx) => createConfirmedPosSaleInTx(tx, input, actor),
  );

  // حافظ على عقد createSale: الإشعار best-effort وبعد الالتزام، حتى في المسار النقدي.
  try {
    await notifySaleCustomerAfterCommit(coreSaleInput(input), result);
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error), invoiceId: result.invoiceId,
      },
      "confirmed POS sale: تعذّر إرسال إشعار الشكر — تُجوهل",
    );
  }

  return result;
}
