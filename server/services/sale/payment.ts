// تسجيل دفعة لاحقة على فاتورة آجلة؛ يُحدّث الحالة والذمم.
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { invoices, receipts, shifts } from "../../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
import { invoiceStatusLabel } from "@shared/invoiceStatus";
import { paymentMethodCompact } from "@shared/terms";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { adjustCustomerBalance, computeInvoiceStatus, postEntry,
} from "../ledgerService";
import { createPostingIntent, creditLine, debitLine,
} from "../accounting/postingEngine";
import { money, toDbMoney } from "../money";
import { openShiftIdTx } from "../shiftService";
import { lockCashSourceForUpdate } from "../cash/cashAvailability";
import { type Actor, withTx } from "../tx";
import type { Tx } from "../../db";
import { assertPosPaymentMethodEnabled } from "../posPaymentPolicy";
import type { PaymentMethod } from "./types";
import { paymentAssetRole } from "./paymentPosting";
import {
  assertExternalPaymentReplay,
  consumeConfirmedExternalPaymentAttemptTx,
} from "../posExternalPayment";

export interface ProcessPaymentInput {
  invoiceId: number;
  amount: string;
  method: PaymentMethod;
  reference?: string | null;
  shiftId?: number | null;
  /** إن حُدِّد، يُرفض الدفع على فاتورة فرعٍ مغاير (عزل الفروع لغير المدير). */
  enforceBranchId?: number | null;
  /** Idempotency: نفس الـmagic key يُعاد تشغيله بنتيجة العملية الأولى (لا تكرّر دفعة عند النقر المزدوج). */
  clientRequestId?: string | null;
  /** إثبات غير نقدي مؤكّد؛ إلزامي لكل CARD/TRANSFER/WALLET ويُستهلك مع الإيصال. */
  externalPaymentAttemptId?: number | null;
  externalPaymentDeviceId?: string | null;
  /**
   * فحصٌ حارس يُنفَّذ **داخل** معاملة الدفع بعد مسار الـreplay وقبل إدراج الإيصال (ش٥):
   * فحصه في معاملةٍ مستقلّة قبل النداء يفتح TOCTOU (الحارس يلتزم ويحرّر أقفال فجوته قبل أن
   * يُدرَج الإيصال ⇒ كودُ كارتٍ يُقبَض مرّتين تحت التزامن)، ويصطدم بإيصال العملية نفسها عند
   * إعادة الإرسال المشروعة. هنا يتخطّاه الـreplay وتبقى أقفاله حيّةً حتى التزام الإدراج.
   */
  preInsertCheck?: (tx: Tx) => Promise<void>;
}

/** Record a later payment against a credit invoice; updates status + AR. */
export async function processPayment(input: ProcessPaymentInput, actor: Actor) {
  // يسبق idempotency وقراءة الفاتورة؛ المرجع اليدوي ليس تسوية بنكية أو مزوّداً موثوقاً.
  assertPosPaymentMethodEnabled(input.method);
  if (input.method === "CASH") {
    if (
      input.externalPaymentAttemptId != null ||
      input.externalPaymentDeviceId?.trim()
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تسجيل الدفعة النقدية",
          why: "الطلب يحمل محاولة دفعٍ خارجية (بطاقة/تحويل)، والنقد يدخل الدرج مباشرةً بلا جهاز",
          doThis: "إن قبضتَ نقداً فأعِد المحاولة بلا ربط جهاز؛ وإن قبضتَ بالبطاقة فاختر «بطاقة» لتُستهلَك محاولة الجهاز مع الإيصال",
        }),
      });
    }
  } else if (
    !input.externalPaymentAttemptId ||
    !input.externalPaymentDeviceId?.trim()
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        // ⚠️ «أكّد الدفع الخارجي» أوّلَ النصّ: تُطابقه اختبارات fail-closed في `nonCashScreensEnabled`
        // و`posPaymentFailClosedApi` بالتعبير النمطيّ — أعِد صياغة ما بعده لا هو.
        what: "أكّد الدفع الخارجي على هذا الجهاز قبل تسجيل الدفعة",
        why: "غير النقد لا يُقيَّد بإقرار الموظّف وحده — يلزمه إثباتٌ مؤكَّدٌ من جهاز الدفع يُستهلَك مرّةً واحدة مع الإيصال",
        doThis: "نفّذ العملية على جهاز الدفع حتى تظهر «تأكّد الدفع الخارجي»، ثمّ اضغط تسجيل الدفعة؛ وإن رفض الجهاز فاقبض نقداً بدل تسجيل قبضٍ بلا إثبات",
      }),
    });
  }
  return withTx(async (tx) => {
    // Idempotency (نمط جذري ١): قبل أيّ replay، نتحقّق أنّ الإيصال المخزَّن يخصّ نفس الفاتورة
    // وفرع المستخدم الحقيقي. كان الـreplay يَعود قبل enforceBranchId وقبل أيّ ربط بـinput.invoiceId
    // ⇒ مفتاح يُعاد استعماله على فاتورة مختلفة كان يُرجع نجاحاً صامتاً (no-op) فيتلقّى الكاشير «مدفوع»
    // ولا تُسجَّل دفعةٌ ثانية فعلياً ⇒ منفذ سرقة نقد. التأكيد يغلق الفئة بأكملها.
    if (input.clientRequestId) {
      const existingRefId = await findIdempotentRefId(tx, "sale.pay", input.clientRequestId,
      );
      if (existingRefId != null) {
        const r = (await tx.select().from(receipts).where(eq(receipts.id, existingRefId)).limit(1))[0];
        if (!r || Number(r.invoiceId) !== Number(input.invoiceId)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "تعذّر تسجيل الدفعة",
              why: `تعارض idempotency: مفتاح هذه العملية مستعمَلٌ سلفاً لدفعةٍ على فاتورةٍ أخرى (${r ? `رقم ${Number(r.invoiceId)}` : "لم يعد إيصالها موجوداً"})`,
              doThis: "أعِد تحميل شاشة الفاتورة وابدأ عملية تحصيلٍ جديدة — لا تُعِد إرسال الطلب نفسه؛ وتحقّق أولاً من كشف الفاتورة أنّ المبلغ لم يُقبَض فعلاً",
            }),
          });
        }
        if (money(r.amount).toFixed(2) !== money(input.amount).toFixed(2)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "تعذّر تسجيل الدفعة",
              why: `تعارض idempotency: المفتاح نفسه سُجِّل به مبلغ ${money(r.amount).toFixed(2)} والآن يُرسَل ${money(input.amount).toFixed(2)}`,
              doThis: `الدفعة الأولى (${money(r.amount).toFixed(2)}) مُثبَتةٌ فعلاً — أعِد تحميل الفاتورة، وإن بقي مستحقٌّ فسجّل الفرق بعملية تحصيلٍ جديدة`,
            }),
          });
        }
        if ((r.paymentMethod ?? null) !== (input.method ?? null)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "تعذّر تسجيل الدفعة",
              why: `تعارض idempotency: المفتاح نفسه سُجِّل بطريقة «${paymentMethodCompact(r.paymentMethod)}» والآن يُرسَل بطريقة «${paymentMethodCompact(input.method)}»`,
              doThis: "أعِد تحميل الفاتورة وتحقّق من الإيصال المُثبَت؛ ولتصحيح طريقة السداد المسجَّلة اعكس الإيصال وسجّله بطريقته الصحيحة",
            }),
          });
        }
        if (input.method !== "CASH") {
          await assertExternalPaymentReplay(
            tx,
            input.invoiceId,
            {
              branchId: Number(r.branchId),
              channel: "SALES_COLLECTION",
              method: input.method,
              amount: input.amount,
              attemptId: input.externalPaymentAttemptId,
              deviceId: input.externalPaymentDeviceId,
            },
            actor,
            Number(r.id),
          );
        } else if (
          (r.referenceNumber ?? null) !== (input.reference?.trim() || null)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "تعذّر تسجيل الدفعة",
              why: `تعارض idempotency: الإيصال المُثبَت بهذا المفتاح يحمل مرجعاً مختلفاً (${r.referenceNumber ?? "بلا مرجع"})`,
              doThis: "أعِد تحميل الفاتورة وراجع الإيصال المُثبَت؛ ولتصحيح المرجع وحده عدّله على الإيصال بدل إعادة إرسال دفعةٍ ثانية",
            }),
          });
        }
        // أعِد قراءة الفاتورة لإرجاع حالتها الحديثة (replay آمن، لا كتابة).
        const inv = (await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1))[0];
        if (input.enforceBranchId != null && inv && Number(inv.branchId) !== input.enforceBranchId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "لا تملك صلاحية على فاتورة فرع آخر",
              why: `الفاتورة تخصّ الفرع رقم ${Number(inv.branchId)} وأنت مقيَّدٌ بالفرع رقم ${input.enforceBranchId} — عزل الفروع يمنع دخول تحصيل فرعٍ في درج فرعٍ آخر`,
              doThis: "حصّل الفاتورة من كاشير فرعها، أو اطلب من المدير تحصيلها (عبورُ الفروع له وحده)",
            }),
          });
        }
        return {
          invoiceId: input.invoiceId,
          paidAmount: inv?.paidAmount ?? "0.00",
          status: inv?.status ?? "PENDING",
          idempotentReplay: true as const,
        };
      }
    }

    const amount = money(input.amount);
    if (amount.lte(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تسجيل الدفعة",
          why: `المبلغ يجب أن يكون موجباً، والمُرسَل ${amount.toFixed(2)}`,
          doThis: "أدخِل المبلغ المقبوض فعلاً؛ ولإرجاع مالٍ إلى الزبون استعمل المرتجع أو سند الصرف لا دفعةً بالسالب",
        }),
      });
    }

    // ترتيب الأقفال العام يشمل CASH IN: source→document→receipt. إلغاء/مرتجع الفاتورة
    // يحتاج المصدر أولاً كي يرد النقد؛ إبقاء الدفع invoice→shift يصنع دورة معه.
    const invPreview = (
      await tx.select({ branchId: invoices.branchId }).from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1)
    )[0];
    if (!invPreview) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تسجيل الدفعة",
          why: `الفاتورة رقم ${input.invoiceId} غير موجودة — يبدو أنها حُذفت أو أنّ الرابط قديم`,
          doThis: "ابحث عن الفاتورة برقمها أو باسم الزبون من قائمة المبيعات وحصّلها من هناك",
        }),
      });
    }
    if (input.enforceBranchId != null && Number(invPreview.branchId) !== input.enforceBranchId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "لا تملك صلاحية على فاتورة فرع آخر",
          why: `الفاتورة تخصّ الفرع رقم ${Number(invPreview.branchId)} وأنت مقيَّدٌ بالفرع رقم ${input.enforceBranchId} — عزل الفروع يمنع دخول تحصيل فرعٍ في درج فرعٍ آخر`,
          doThis: "حصّل الفاتورة من كاشير فرعها، أو اطلب من المدير تحصيلها (عبورُ الفروع له وحده)",
        }),
      });
    }
    let prelockedShiftId: number | null = null;
    if (input.method === "CASH") {
      prelockedShiftId = input.shiftId ??
        (await openShiftIdTx(tx, actor.userId, Number(invPreview.branchId)));
      if (prelockedShiftId == null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "تعذّر تحصيل الدفعة نقداً",
            why: "لا وردية مفتوحة لك على هذا الفرع، والنقد لا يُقبَض بلا درجٍ يدخله فيُحاسَب عليه في تسوية اليوم",
            doThis: "افتح وردية على درجك من شاشة الخزينة ← الورديات ثمّ أعِد التحصيل، أو اقبض بالبطاقة/التحويل (لا يمسّان الدرج)",
          }),
        });
      }
      await lockCashSourceForUpdate(tx, {
        branchId: Number(invPreview.branchId),
        cashBucket: "DRAWER",
        shiftId: prelockedShiftId,
      });
    }

    const writePayment = async (paymentReference: string | null) => {
      const rows = await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).for("update").limit(1);
    const inv = rows[0];
    if (!inv) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تسجيل الدفعة",
          why: `الفاتورة رقم ${input.invoiceId} لم تعد موجودة — حُذفت بين فتح الشاشة وحفظ الدفعة`,
          doThis: "أعِد تحميل قائمة المبيعات وابحث عن الفاتورة برقمها أو باسم الزبون، ولا تسلّم إيصالاً قبل ثبوت القبض",
        }),
      });
    }
    if (Number(inv.branchId) !== Number(invPreview.branchId)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر تسجيل الدفعة",
          why: `تغيّر فرع الفاتورة أثناء الدفع (كان ${Number(invPreview.branchId)} وصار ${Number(inv.branchId)}) — والدفع يُقفل على فرعٍ واحد كي لا يدخل النقد درج فرعٍ غير فرعها`,
          doThis: "أعِد تحميل الفاتورة وتحقّق من فرعها ثمّ أعِد التحصيل",
        }),
      });
    }
    // عزل الفرع: غير المدير لا يدفع على فاتورة فرع آخر (منع IDOR).
    if (input.enforceBranchId != null && Number(inv.branchId) !== input.enforceBranchId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "لا تملك صلاحية على فاتورة فرع آخر",
          why: `الفاتورة تخصّ الفرع رقم ${Number(inv.branchId)} وأنت مقيَّدٌ بالفرع رقم ${input.enforceBranchId} — عزل الفروع يمنع دخول تحصيل فرعٍ في درج فرعٍ آخر`,
          doThis: "حصّل الفاتورة من كاشير فرعها، أو اطلب من المدير تحصيلها (عبورُ الفروع له وحده)",
        }),
      });
    }
    if (inv.status === "CANCELLED" || inv.status === "RETURNED" || inv.status === "SUPERSEDED") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّر التحصيل على الفاتورة ${inv.invoiceNumber}`,
          why: `حالتها «${invoiceStatusLabel(inv.status)}» — والمستند المنتهي لا يقبل قبضاً جديداً عليه`,
          doThis:
            inv.status === "SUPERSEDED"
              ? "حصّل على الفاتورة البديلة التي حلّت محلّها (تجدها من كشف الفاتورة)"
              : "أنشئ فاتورةً جديدة بما يُباع فعلاً وحصّل عليها؛ ولردّ مالٍ قُبض سابقاً استعمل المرتجع أو سند الصرف",
        }),
      });
    }
    if (inv.status === "PAID") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          // ⚠️ «مدفوعة بالكامل» متعاقَدٌ عليها: يطابقها `voucherInvoiceAllocation.test.ts` حارساً
          // لِبابِ التحصيل المزدوج. أعِد صياغة ما حولها لا هي.
          what: `الفاتورة ${inv.invoiceNumber} مدفوعة بالكامل`,
          why: `المسدَّد ${money(inv.paidAmount).toFixed(2)} من إجمالي ${money(inv.total).toFixed(2)} — ولا يُقبض على مستندٍ لا مستحقَّ عليه (بابُ تحصيلٍ مزدوج)`,
          doThis: "راجع كشف الفاتورة قبل قبض أيّ مبلغ؛ وإن كان الزبون يسدّد فاتورةً أخرى فافتحها من كشف حسابه وحصّل عليها",
        }),
      });
    }
    const remaining = money(inv.total)
      .minus(money(inv.returnedTotal ?? "0"))
      .minus(money(inv.paidAmount));
    if (remaining.lte(0)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `لا يوجد مبلغ مستحق على الفاتورة ${inv.invoiceNumber}`,
          why: `الإجمالي ${money(inv.total).toFixed(2)} والمرتجع منه ${money(inv.returnedTotal ?? "0").toFixed(2)} والمسدَّد ${money(inv.paidAmount).toFixed(2)}، فالمتبقّي ${remaining.toFixed(2)}`,
          doThis: remaining.lt(0)
            ? "الزبون دفع زيادةً عن المستحقّ — ردّ الفرق بسند صرفٍ على حسابه بدل قبض المزيد"
            : "لا تقبض شيئاً على هذه الفاتورة؛ افتح كشف حساب الزبون وحصّل على فاتورةٍ ما تزال مستحقّة",
        }),
      });
    }
    if (amount.gt(remaining)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          // ⚠️ «تتجاوز المتبقي» متعاقَدٌ عليها: تطابقها ثلاثة اختبارات لحارس الدفع الزائد.
          what: `الدفعة (${amount.toFixed(2)}) تتجاوز المتبقي على الفاتورة ${inv.invoiceNumber} (${remaining.toFixed(2)})`,
          why: `الفرق ${amount.minus(remaining).toFixed(2)} زائدٌ عن المستحقّ، وقبضُه يقلب ذمّة الزبون إلى دائنٍ بلا مستند`,
          doThis: `أنقص المبلغ إلى ${remaining.toFixed(2)}، واقبض الزائد على فاتورةٍ أخرى مستحقّة أو سجّله دفعةً مقدَّمة بسند قبضٍ على حساب الزبون`,
        }),
      });
    }

    // إن مُرِّر shiftId: تَحقّق من حالة الوردية وملكيتها (M5 + M9).
    if (input.method === "CASH" && input.shiftId != null) {
      const sRows = await tx
        .select()
        .from(shifts)
        .where(eq(shifts.id, input.shiftId))
        .for("update")
        .limit(1);
      const s = sRows[0];
      if (!s) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذّر تحصيل الدفعة نقداً",
            why: `الوردية رقم ${input.shiftId} المرسَلة مع الطلب غير موجودة — يبدو أنّ الشاشة تحمل وردية قديمة`,
            doThis: "أعِد تحميل الشاشة لتلتقط ورديتك المفتوحة، أو افتح وردية على درجك من الخزينة ← الورديات ثمّ أعِد التحصيل",
          }),
        });
      }
      if (s.status !== "OPEN") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "تعذّر تحصيل الدفعة نقداً — الوردية مغلقة",
            why: `الوردية رقم ${Number(s.id)} أُقفِلت وصدر تقريرها (Z)، والمغلقة لا تقبل حركة نقدٍ جديدة وإلّا انحرف نقدُها المعدود عمّا يُظهره التقرير`,
            doThis: "افتح وردية جديدة على درجك من الخزينة ← الورديات ثمّ أعِد التحصيل؛ ولا تُدخِل النقد في الدرج قبل أن يُثبَّت الإيصال",
          }),
        });
      }
      // لا يكفي أن تكون الوردية مفتوحة ومملوكة للفاعل: يجب أن تكون درجاً من
      // الفرع نفسه للفـاتورة. من دون ذلك يمكن تمرير وردية فرعٍ آخر فتُسجّل
      // مقبوضات الفرع A في Z-report للفرع B (مع receipt.branchId=A)، وهو
      // انحراف نقدي لا يمكن تسويته على مستوى الفرع.
      if (Number(s.branchId) !== Number(inv.branchId)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر تحصيل الدفعة نقداً — الوردية لا تخص فرع الفاتورة",
            why: `الوردية درجٌ في الفرع رقم ${Number(s.branchId)} والفاتورة في الفرع رقم ${Number(inv.branchId)} — وقبضُها هنا يُدرِج نقد فرعٍ في تقرير فرعٍ آخر فلا يُسوّى`,
            doThis: "حصّل من وردية فرع الفاتورة نفسه؛ وإن كنتَ في فرعٍ آخر فاتركها لكاشير فرعها",
          }),
        });
      }
      const role = actor.role;
      if (role !== "admin" && role !== "manager") {
        if (Number(s.userId) !== Number(actor.userId)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "لا تَستطيع التسجيل على وردية مستخدم آخر",
              why: `الوردية رقم ${Number(s.id)} مفتوحةٌ لموظّفٍ آخر، ونقدُها يُحاسَب عليه هو في تسوية درجه`,
              doThis: "افتح وردية على درجك من الخزينة ← الورديات وحصّل عليها، أو سلّم النقد إلى صاحب الوردية ليقبض هو",
            }),
          });
        }
      }
    }
    // انسب الدفع النقدي لوردية الموظّف المفتوحة إن لم يُمرَّر صراحةً (تسوية الصندوق).
    const shiftId = prelockedShiftId;
    if (input.preInsertCheck) await input.preInsertCheck(tx);
    const rRes = await tx.insert(receipts).values({
      invoiceId: input.invoiceId,
      branchId: Number(inv.branchId),
      shiftId,
      // cashBucket=DRAWER للنقد، NULL لغير النقد — مرآة لـcreateSale ولـvoucherService.
      cashBucket: input.method === "CASH" ? "DRAWER" : null,
      direction: "IN",
      amount: toDbMoney(amount),
      paymentMethod: input.method,
      referenceNumber: paymentReference,
      status: "COMPLETED",
      createdBy: actor.userId,
    });
    const receiptId = extractInsertId(rRes);
    if (input.clientRequestId) await recordIdempotencyKey(tx, "sale.pay", input.clientRequestId, receiptId,
        );

    const newPaid = money(inv.paidAmount).plus(amount);
    const status = computeInvoiceStatus(inv.total, toDbMoney(newPaid), inv.returnedTotal ?? "0",
      );
    await tx
      .update(invoices)
      .set({
        paidAmount: toDbMoney(newPaid),
        status,
        paymentDate: new Date(),
        // «آخر دفعة تفوز» كان يكذب على الفاتورة المختلطة: ٤٩٠٬٠٠٠ نقداً ثمّ ١٠٬٠٠٠ تحويلاً
        // تُخزَّن «تحويل» فتسقط من فلتر «نقدي» كلياً، وفاتورةُ بطاقةٍ يليها فكٌّ نقديّ تخرج من
        // قائمة CARD ⇒ تنهار مطابقة يوم البطاقات وهي الحاجة التشغيلية المعلَنة للفلتر نفسه.
        // القيمة الصادقة عند الاختلاف هي MIXED؛ ومصدر الحقيقة التفصيليّ يبقى `receipts`.
        paymentMethod: mixedAwarePaymentMethod(inv.paymentMethod, input.method,
          ),
      })
      .where(eq(invoices.id, input.invoiceId));

    const paymentRole = paymentAssetRole(input.method, input.method === "CASH" ? "DRAWER" : null, "IN",
      );
    const paymentPostingSource = {
      roleDebits: { [paymentRole]: amount },
      roleCredits: { AR: amount },
    };
    await postEntry(tx, {
      entryType: "PAYMENT_IN",
      branchId: Number(inv.branchId),
      invoiceId: input.invoiceId,
      receiptId,
      customerId: inv.customerId,
      amount,
      postingIntent: createPostingIntent("PAYMENT_IN_CUSTOMER", "PAYMENT_IN", [debitLine(paymentRole, amount), creditLine("AR", amount)], paymentPostingSource,
        ),
      postingSourceComponents: paymentPostingSource,
    });
    if (inv.customerId) {
      await adjustCustomerBalance(tx, Number(inv.customerId), amount.neg());
    }

    return { invoiceId: input.invoiceId,
        receiptId,
        paidAmount: toDbMoney(newPaid), status,
      };
  };

    if (input.method !== "CASH") {
      return consumeConfirmedExternalPaymentAttemptTx(
        tx,
        {
          branchId: Number(invPreview.branchId),
          channel: "SALES_COLLECTION",
          method: input.method,
          amount: input.amount,
          attemptId: input.externalPaymentAttemptId,
          deviceId: input.externalPaymentDeviceId,
        },
        actor,
        async (attempt) => {
          const value = await writePayment(attempt.externalReference);
          return {
            invoiceId: value.invoiceId,
            receiptId: value.receiptId,
            value,
          };
        },
      );
    }
    return writePayment(input.reference?.trim() || null);
  });
}

/**
 * طريقة الدفع المعروضة على الفاتورة بعد دفعةٍ جديدة.
 *
 * فارغة ⇒ الطريقة الجديدة · مطابقة ⇒ كما هي · مختلفة ⇒ `MIXED`.
 * لا تُستعمَل قطّ في حسابٍ ماليّ — العَرض والفلترة فقط؛ التفصيل الحاكم في `receipts`.
 */
export function mixedAwarePaymentMethod(
  current: string | null | undefined,
  incoming: string,
): string {
  if (!current) return incoming;
  return current === incoming ? current : "MIXED";
}
