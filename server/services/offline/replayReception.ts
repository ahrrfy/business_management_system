// إعادة تشغيل سلّة استقبالٍ التُقطت دون اتصال — تعميم الأوفلاين على كاشير خدمات الزبائن.
//
// ⚠️ الحدّ الهندسيّ الصريح: **أوامر الشغل ممنوعة أوفلاين**، ولا تُقبَل هنا بحال.
// السبب ليس تحفّظاً بل استحالةً بنيويّة: `createWorkOrderInTx` يخصّص رقم أمرٍ تسلسليّاً تحت قفل
// (`workOrder/helpers.ts`)، ويكتب صور تصميمٍ قد تبلغ ميغابايتات، ويُسنِد منفّذاً، ويقبض عربوناً
// جزئياً يُوزَّع خادمياً. لا شيء من ذلك يُحجَز أو يُحاكى على الجهاز: رقمان متطابقان من جهازين
// أثناء الانقطاع يتصادمان عند الترحيل، والصور تُفجّر حصّة IndexedDB، والعربون الجزئيّ يجعل
// الفاتورة نصف مدفوعة بلا ذمّةٍ مُقيَّمة. فالتقاطُها كان سيُنتج طابوراً يفشل ترحيله بصمت.
//
// ما يُلتقَط فعلاً: السلّة **المدفوعة نقداً بالكامل** التي لا تحمل إلا بضاعةً جاهزة و/أو خدمات
// طباعة — وهي بالضبط `regularSale` + `printSale` داخل معاملةٍ واحدة، ولها كل ضمانات
// idempotency القائمة (`{clientRequestId}-sale` و`-print` على `invoices.sourceId`).
import { TRPCError } from "@trpc/server";
import type { Actor } from "../tx";
import { checkoutReception, type ReceptionCheckoutInput } from "../receptionCheckoutService";
import { assertCaptureWindow, assertCashOnly } from "./captureWindow";

export interface ReplayOfflineReceptionInput {
  branchId: number;
  shiftId: number;
  customerId?: number | null;
  contactName?: string | null;
  contactPhone?: string | null;
  priceTier?: ReceptionCheckoutInput["priceTier"];
  paymentMethod: "CASH";
  /** المبلغ المُطبَّق — يجب أن يساوي إجمالي السلّة (لا التقاط لدفعةٍ جزئية أوفلاين). */
  paidAmount: string;
  regularSale?: ReceptionCheckoutInput["regularSale"];
  printSale?: ReceptionCheckoutInput["printSale"];
  clientRequestId: string;
  capturedAt: string;
  offlineReceiptNumber: string;
  deviceId?: string | null;
  priceOverrideApproved?: boolean;
}

export async function replayOfflineReception(input: ReplayOfflineReceptionInput, actor: Actor) {
  assertCaptureWindow(input.capturedAt);
  assertCashOnly(input.paymentMethod);

  if (!input.regularSale && !input.printSale) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "سلّة أوفلاينية فارغة" });
  }

  // حارس البنية: العقد لا يحمل حقل أوامر شغل أصلاً، وهذا الفحص يمنع تسرّبها عبر أيّ
  // استدعاءٍ داخليٍّ مستقبليّ يوسّع النوع بلا مراجعة (دفاعٌ متعمّق لا تكرار).
  const anyInput = input as unknown as { workOrders?: unknown[] };
  if (Array.isArray(anyInput.workOrders) && anyInput.workOrders.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "أوامر الشغل لا تُلتقَط دون اتصال — تحتاج ترقيماً وإسناداً وصوراً من الخادم",
    });
  }

  const res = await checkoutReception(
    {
      branchId: input.branchId,
      shiftId: input.shiftId,
      customerId: input.customerId ?? null,
      contactName: input.contactName ?? null,
      contactPhone: input.contactPhone ?? null,
      paymentMethod: "CASH",
      paidAmount: input.paidAmount,
      clientRequestId: input.clientRequestId,
      priceTier: input.priceTier ?? null,
      // لا كوبونات أوفلاين: صلاحية الكوبون واستهلاكه الذرّي يُقيَّمان خادمياً لحظة البيع.
      couponCode: null,
      regularSale: input.regularSale ?? null,
      printSale: input.printSale ?? null,
      workOrders: [],
      priceOverrideApproved: input.priceOverrideApproved ?? false,
      offlineCapture: {
        capturedAt: new Date(input.capturedAt),
        offlineReceiptNumber: input.offlineReceiptNumber,
        deviceId: input.deviceId ?? null,
      },
    },
    actor,
  );

  // تطبيع النتيجة لعقدٍ واحد يفهمه الطابور والتدقيق: السلّة قد تُنتج فاتورتين (بيع مباشر +
  // خدمات طباعة)، والطابور يعرض رقماً رسمياً واحداً مقابل الرقم المؤقّت. نُقدّم فاتورة البيع
  // المباشر إن وُجدت وإلا فاتورة الطباعة، ونُبقي الاثنتين في `invoices` لمن يحتاج التفصيل.
  const primary = res.regularSale ?? res.printSale;
  return {
    invoiceId: primary?.invoiceId ?? 0,
    invoiceNumber: primary?.invoiceNumber ?? "",
    idempotentReplay: (res.regularSale?.idempotentReplay ?? true) && (res.printSale?.idempotentReplay ?? true),
    invoices: {
      regularSale: res.regularSale
        ? { invoiceId: res.regularSale.invoiceId, invoiceNumber: res.regularSale.invoiceNumber }
        : null,
      printSale: res.printSale
        ? { invoiceId: res.printSale.invoiceId, invoiceNumber: res.printSale.invoiceNumber }
        : null,
    },
  };
}
