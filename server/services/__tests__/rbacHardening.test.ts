// اختبارات RBAC إضافية للشريحة الجديدة:
//  - catalog.updateProduct: managerProcedure (كان protected ⇒ ثغرة تكاليف).
//  - quotation.create/setStatus/convert: managerProcedure (كان protected).
//  - workOrders.list: branchScopedProcedure (IDOR).
//  - workOrders.get: يخفي materialsCost/laborCost/unitCost عن غير المرتفعين.
//  - shifts.report: branchScopedProcedure + يرفض ورديات فرع آخر للكاشير.
//  - barcode.verify: يرفض payload > 1000 خانة.
//  - inventory.transfer/adjust: warehouse مُجبَر على فرعه (M1 — تدقيق ١٤/٦/٢٦).
//  - voucher.list/get: branchScopedProcedure مع scopedBranchId (M2 — تدقيق ١٤/٦/٢٦).
//  - branchScopedProcedure: غير-مرتفع بلا فرع ⇒ FORBIDDEN (F1 — تدقيق ١٤/٦/٢٦).
//  - purchase.list/get: branchScopedProcedure (F3 — تدقيق ١٤/٦/٢٦).
//  - expense.create: غير-مرتفع يُجبَر على فرعه (F4 — تدقيق ١٤/٦/٢٦).
//  - sale.create/pay: غير-مرتفع بلا فرع ⇒ FORBIDDEN (G1 — تدقيق ١٤/٦/٢٦).
//  - voucher.create/cancel: لا فرع مُسنَد ⇒ FORBIDDEN (G2 — تدقيق ١٤/٦/٢٦).
//  - reports.dashboardMetrics: غير-مرتفع بلا فرع ⇒ FORBIDDEN (G3 — تدقيق ١٤/٦/٢٦).
//  - shifts.open/close: غير-مرتفع بلا فرع ⇒ FORBIDDEN (G4 — تدقيق ١٤/٦/٢٦).
//  - quotation.setStatus/convert: admin فقط يعبُر الفروع (Q1 — تدقيق ١٤/٦/٢٦).

import { describe, expect, it } from "vitest";
import type { TrpcContext } from "../../context";
import { appRouter } from "../../routers";

function ctxWith(role: string, branchId: number | null = 1): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: { id: 1, role, branchId, name: "t", email: "t@t", isActive: true } as unknown as TrpcContext["user"],
  };
}
const caller = (role: string, branchId: number | null = 1) => appRouter.createCaller(ctxWith(role, branchId));

async function expectForbidden(p: Promise<unknown>) {
  await expect(p).rejects.toMatchObject({ code: "FORBIDDEN" });
}

describe("RBAC الجديد: شريحة precision-rbac", () => {
  describe("catalog.updateProduct — مدير فأعلى فقط", () => {
    it("الكاشير ممنوع", () =>
      expectForbidden(
        caller("cashier").catalog.updateProduct({
          productId: 1, name: "x",
          variants: [{ id: 1, sku: "s", costPrice: "0", units: [{ unitName: "u", conversionFactor: "1" }] }],
        })
      )
    );
    it("المخزن ممنوع", () =>
      expectForbidden(
        caller("warehouse").catalog.updateProduct({
          productId: 1, name: "x",
          variants: [{ id: 1, sku: "s", costPrice: "0", units: [{ unitName: "u", conversionFactor: "1" }] }],
        })
      )
    );
  });

  describe("quotation.* — مدير فأعلى فقط (كانت ثغرة protected)", () => {
    it("الكاشير ممنوع من إنشاء عرض سعر", () =>
      expectForbidden(
        caller("cashier").quotations.create({
          branchId: 1, lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        })
      )
    );
    it("الكاشير ممنوع من تغيير حالة عرض", () =>
      expectForbidden(caller("cashier").quotations.setStatus({ quotationId: 1, status: "ACCEPTED" }))
    );
    it("الكاشير ممنوع من تحويل عرض لفاتورة", () =>
      expectForbidden(caller("cashier").quotations.convert({ quotationId: 1 }))
    );
  });

  // M1 — تدقيق ١٤/٦/٢٦: inventory.transfer/adjust يجب أن يُجبرا warehouse على فرعه.
  // قبل الإصلاح: warehouse فرع SALES كان يستطيع نقل بضاعة من فرع MAIN عبر API مباشر.
  describe("M1: inventory.transfer/adjust — عزل الفرع لـwarehouse", () => {
    it("warehouse: transfer من فرع ليس فرعه ⇒ FORBIDDEN", () =>
      expectForbidden(
        caller("warehouse", 2).inventory.transfer({
          variantId: 1, fromBranchId: 1, toBranchId: 2, baseQuantity: 5,
        })
      )
    );
    it("warehouse بلا فرع: transfer ⇒ FORBIDDEN", () =>
      expectForbidden(
        caller("warehouse", null).inventory.transfer({
          variantId: 1, fromBranchId: 1, toBranchId: 2, baseQuantity: 5,
        })
      )
    );
    it("warehouse بلا فرع: adjust ⇒ FORBIDDEN", () =>
      expectForbidden(
        caller("warehouse", null).inventory.adjust({
          variantId: 1, branchId: 1, targetQuantity: 10,
        })
      )
    );
  });

  // M2 — تدقيق ١٤/٦/٢٦ (مُحدَّث ٢٠/٦/٢٦): voucher.list/get رُفعتا إلى managerProcedure
  // بدل branchScopedProcedure. قراءة السندات تكشف بيانات نقدية حسّاسة (مبالغ، أرقام شيكات،
  // آخر ٤ من البطاقة) — حجبها كلياً عن الأدوار غير المرتفعة أصرم وأكثر اتّساقاً مع كتابة
  // السندات (create/cancel managerProcedure) وبقيّة القراءات المالية في reportsRouter.
  describe("M2: voucher.list/get — حجب كلّي عن الأدوار غير المرتفعة (managerProcedure)", () => {
    it("list: كاشير ⇒ FORBIDDEN (لا قراءة سندات للكاشير)", () =>
      expectForbidden(caller("cashier", 2).vouchers.list())
    );
    it("list: warehouse ⇒ FORBIDDEN", () =>
      expectForbidden(caller("warehouse", 2).vouchers.list())
    );
    it("get: كاشير ⇒ FORBIDDEN (لا قراءة سند فردي للكاشير)", () =>
      expectForbidden(caller("cashier", 2).vouchers.get({ receiptId: 1 }))
    );
    it("list: manager ⇒ مسموح (يرى كل الفروع — لا قيد فرع على دور إداري مالي)", async () => {
      const out = await caller("manager", 1).vouchers.list();
      expect(Array.isArray(out)).toBe(true);
    });
    it("list: admin ⇒ مسموح", async () => {
      const out = await caller("admin", 1).vouchers.list();
      expect(Array.isArray(out)).toBe(true);
    });
  });

  // F1 — تدقيق ١٤/٦/٢٦: branchScopedProcedure تستبدل `-1` بـFORBIDDEN صريح.
  // قبل الإصلاح: غير-مرتفع بلا فرع كان يرى [] صامتاً (لا أثر forensic + سلوك مضلّل).
  describe("F1: branchScopedProcedure — FORBIDDEN لغير-مرتفع بلا فرع", () => {
    it("cashier بلا فرع على voucher.list (managerProcedure ⇒ FORBIDDEN على الدور قبل فحص الفرع)", () =>
      expectForbidden(caller("cashier", null).vouchers.list())
    );
    it("warehouse بلا فرع على purchases.list (branchScoped بعد F3) ⇒ FORBIDDEN", () =>
      expectForbidden(caller("warehouse", null).purchases.list())
    );
    it("admin بلا فرع ⇒ مسموح (مرتفع — لا يحتاج فرع)", async () => {
      // قاعدة الاختبار فارغة ⇒ النتيجة [] دون رمي.
      const out = await caller("admin", null).vouchers.list();
      expect(Array.isArray(out)).toBe(true);
    });
  });

  // F3 — تدقيق ١٤/٦/٢٦: purchase.list/get تحوّلتا إلى branchScopedProcedure.
  // قبل الإصلاح: managerProcedure بلا عزل ⇒ مدير فرع SALES يقرأ مشتريات فرع MAIN.
  describe("F3: purchase.list/get — عزل فرع للأدوار غير المرتفعة", () => {
    it("list: warehouse بفرع — لا يرمي (filter صامت لفرعه)", async () => {
      const out = await caller("warehouse", 2).purchases.list();
      expect(Array.isArray(out)).toBe(true);
    });
    it("list: warehouse يطلب فرع آخر — يُغلَب بـscopedBranchId (نتيجة []) ", async () => {
      const out = await caller("warehouse", 2).purchases.list({ branchId: 1 });
      expect(Array.isArray(out)).toBe(true);
      expect(out.length).toBe(0);
    });
    it("get: warehouse يطلب purchaseOrderId غير موجود ⇒ null (لا تسريب)", async () => {
      const po = await caller("warehouse", 2).purchases.get({ purchaseOrderId: 999999 });
      expect(po).toBeNull();
    });
  });

  // F4 — تدقيق ١٤/٦/٢٦: expense.create يجبر الكاشير على فرعه.
  // قبل الإصلاح: `ctx.user.branchId ?? input.branchId` كان يسمح بحقن branchId لفرع آخر
  // (تلويث صندوق + قيد خاطئ — اختراق مالي مباشر).
  describe("F4: expense.create — كاشير لا يحقن branchId لفرع آخر", () => {
    it("cashier بلا فرع ⇒ FORBIDDEN", () =>
      expectForbidden(
        caller("cashier", null).expenses.create({
          branchId: 1, category: "OTHER", amount: "100", paymentMethod: "CASH",
        })
      )
    );
    // ملاحظة: المسار الإيجابي (كاشير(2) يُجبَر على branchId=2) يحتاج بذر فرع/وردية ⇒ يُغطّى
    // في `expenseService.test.ts`/`financialMedium.test.ts`؛ هنا نكتفي بحارس الـauthz.
  });

  // G1 — تدقيق ١٤/٦/٢٦: sale.create/pay يطبّقان نمط F4 (FORBIDDEN صريح بدل fallback صامت).
  describe("G1: sale.create/pay — كاشير بلا فرع ⇒ FORBIDDEN", () => {
    it("cashier بلا فرع: sale.create ⇒ FORBIDDEN", () =>
      expectForbidden(
        caller("cashier", null).sales.create({
          branchId: 1,
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "100" }],
        })
      )
    );
    it("cashier بلا فرع: sale.pay ⇒ FORBIDDEN", () =>
      expectForbidden(
        caller("cashier", null).sales.pay({ invoiceId: 1, amount: "100", method: "CASH" })
      )
    );
  });

  // G2 — تدقيق ١٤/٦/٢٦: voucher.create/cancel يرفضان لو لا فرع مُسنَد (حتى للمرتفعين).
  describe("G2: voucher.create/cancel — لا فرع مُسنَد ⇒ FORBIDDEN", () => {
    it("manager بلا فرع: voucher.create ⇒ FORBIDDEN", () =>
      expectForbidden(
        caller("manager", null).vouchers.create({
          voucherType: "RECEIPT", branchId: 1, amount: "100", paymentMethod: "CASH",
          partyType: "CUSTOMER", description: "تجربة",
        })
      )
    );
    it("manager بلا فرع: voucher.cancel ⇒ FORBIDDEN", () =>
      expectForbidden(caller("manager", null).vouchers.cancel({ receiptId: 1 }))
    );
  });

  // G3 — تدقيق ١٤/٦/٢٦: reports.dashboardMetrics يستبدل magic -1 برميٍ صريح.
  describe("G3: reports.dashboardMetrics — غير-مرتفع بلا فرع ⇒ FORBIDDEN", () => {
    it("cashier بلا فرع ⇒ FORBIDDEN", () =>
      expectForbidden(caller("cashier", null).reports.dashboardMetrics())
    );
    it("admin بلا فرع ⇒ مسموح (يرى كل الفروع)", async () => {
      const out = await caller("admin", null).reports.dashboardMetrics();
      expect(out).toBeDefined();
    });
  });

  // G4 — تدقيق ١٤/٦/٢٦: shifts.open/close يستبدلان `?? input.branchId` و`?? -1`.
  describe("G4: shifts.open/close — كاشير بلا فرع ⇒ FORBIDDEN", () => {
    it("cashier بلا فرع: shifts.open ⇒ FORBIDDEN", () =>
      expectForbidden(
        caller("cashier", null).shifts.open({ branchId: 1, openingBalance: "0" })
      )
    );
    it("cashier بلا فرع: shifts.close ⇒ FORBIDDEN", () =>
      expectForbidden(
        caller("cashier", null).shifts.close({ shiftId: 1, countedCash: "0" })
      )
    );
  });

  // Q1 — تدقيق ١٤/٦/٢٦: عرض السعر التزام تسعيري؛ admin فقط يعدّل/يحوّل عبر الفروع.
  // مدير فرع SALES لا يستطيع تعديل/تحويل عرض فرع MAIN (يلوّث الأسعار + يُنشئ فاتورة بلا سلطة).
  describe("Q1: quotation.setStatus/convert — admin فقط يعبُر الفروع", () => {
    it("manager بلا فرع: setStatus ⇒ FORBIDDEN", () =>
      expectForbidden(
        caller("manager", null).quotations.setStatus({ quotationId: 1, status: "ACCEPTED" })
      )
    );
    it("manager بلا فرع: convert ⇒ FORBIDDEN", () =>
      expectForbidden(caller("manager", null).quotations.convert({ quotationId: 1 }))
    );
    it("manager(2) يحاول setStatus لعرض غير موجود ⇒ NOT_FOUND (لا يكشف منع الفرع)", async () => {
      // قاعدة فارغة ⇒ ينتهي عند NOT_FOUND قبل فحص الفرع (سلوك مقبول: لا يكشف وجود عرض).
      await expect(
        caller("manager", 2).quotations.setStatus({ quotationId: 999999, status: "ACCEPTED" })
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
    it("admin بلا فرع: setStatus لعرض غير موجود ⇒ NOT_FOUND (مسموح، لا FORBIDDEN)", async () => {
      await expect(
        caller("admin", null).quotations.setStatus({ quotationId: 999999, status: "ACCEPTED" })
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("barcode.verify — حدّ الإدخال", () => {
    it("يرفض payload > 1000 خانة", async () => {
      const huge = "X".repeat(1001);
      // publicProcedure — الفحص هو على zod schema قبل الوصول لأي شيء آخر.
      await expect(caller("cashier").barcode.verify({ payload: huge })).rejects.toThrow();
    });
    it("يقبل payload طبيعي", async () => {
      // payload غير صالح (لا توقيع) لكن طوله مسموح ⇒ يرجع invalid (لا exception).
      const out = await caller("cashier").barcode.verify({ payload: "INV|x|2026-01-01|100|1|abc" });
      expect(out).toBeDefined();
    });
  });

  // مراجعة ٥/٧/٢٦: عودة نمط `?? 1` (سابقة G3) في arRemindersRouter — مدير بلا فرع مُسنَد كان
  // يقرأ/يكتب صامتاً على الفرع ١ (يمرّ حتى فحص IDOR لأن assertCustomerHasBranchInvoice يجري
  // على الفرع ١ نفسه). الآن: قاعدة واحدة للقراءة والكتابة (scopedBranch): FORBIDDEN صريح بلا
  // فرع، وadmin يعبُر الفروع بـinput.branchId **صريح** فقط — لا قراءة مجمَّعة من الراوتر لأن
  // كتابةً بلا فرعِ صفٍّ تجعل القائمة غير قابلة للتنفيذ (تحقّق عدائي ٥/٧).
  describe("arReminders — لا `?? 1`: عزل فرع صريح موحَّد قراءةً وكتابةً (سابقة G3)", () => {
    it("queue: مدير بلا فرع ⇒ FORBIDDEN (كان يقرأ الفرع ١ صامتاً)", () =>
      expectForbidden(caller("manager", null).arReminders.queue())
    );
    it("history: مدير بلا فرع ⇒ FORBIDDEN", () =>
      expectForbidden(caller("manager", null).arReminders.history())
    );
    it("logSent: مدير بلا فرع ⇒ FORBIDDEN (كان يكتب على الفرع ١ صامتاً)", () =>
      expectForbidden(
        caller("manager", null).arReminders.logSent({
          customerId: 1,
          totalUnpaidSnapshot: "1000",
          oldestInvoiceDate: "2026-01-01",
          daysOverdue: 10,
          messageBody: "x",
        })
      )
    );
    it("logSkipped: admin بلا فرع وبلا branchId ⇒ FORBIDDEN صريح (الكتابة تتطلّب فرعاً محدَّداً)", () =>
      expectForbidden(
        caller("admin", null).arReminders.logSkipped({
          customerId: 1,
          totalUnpaidSnapshot: "1000",
          oldestInvoiceDate: "2026-01-01",
          daysOverdue: 10,
          skipReason: "x",
        })
      )
    );
    it("queue: مدير فرع ٢ يطلب فرع ١ ⇒ FORBIDDEN forensic (لا قصّ صامت)", () =>
      expectForbidden(caller("manager", 2).arReminders.queue({ branchId: 1 }))
    );
    it("queue: admin بلا فرع وبلا branchId ⇒ FORBIDDEN (نطاق القراءة = نطاق الكتابة — لا قائمة غير قابلة للتنفيذ)", () =>
      expectForbidden(caller("admin", null).arReminders.queue())
    );
    it("queue: admin فرعه ١ يطلب فرع ٢ صراحةً ⇒ مسموح (منفذ عبور الفروع بمرآة arAging)", async () => {
      const out = await caller("admin", 1).arReminders.queue({ branchId: 2 });
      expect(Array.isArray(out)).toBe(true);
    });
    it("logSent: admin بفرع صريح ⇒ يمرّ عزل الفرع ويصل لفحص فاتورة العميل (NOT_FOUND لا FORBIDDEN)", async () => {
      await expect(
        caller("admin", 1).arReminders.logSent({
          customerId: 999999,
          totalUnpaidSnapshot: "1000",
          oldestInvoiceDate: "2026-01-01",
          daysOverdue: 10,
          messageBody: "x",
          branchId: 2,
        })
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  // مراجعة ٥/٧/٢٦ (قرار مالك): مدينو الرصيد الافتتاحي فقط (بلا فاتورة) — نطاق مجمَّع مستقلّ
  // openingScope، **للأدمن حصراً** (لا انتماء فرعيّ لهؤلاء العملاء ⇒ لا معنى لعزل فرع مدير عليهم).
  describe("arReminders — نطاق «مدينو الرصيد الافتتاحي» (openingScope): أدمن حصراً", () => {
    it("queue({openingScope:true}): مدير ⇒ FORBIDDEN", () =>
      expectForbidden(caller("manager", 1).arReminders.queue({ openingScope: true }))
    );
    it("queue({openingScope:true}): كاشير ⇒ FORBIDDEN (customersManagerProcedure أصلاً)", () =>
      expectForbidden(caller("cashier", 1).arReminders.queue({ openingScope: true }))
    );
    it("queue({openingScope:true}): admin ⇒ مسموح (تجميع كل الفروع)", async () => {
      const out = await caller("admin", 1).arReminders.queue({ openingScope: true });
      expect(Array.isArray(out)).toBe(true);
    });
    // history تحمل نفس نطاق queue (سدّ فجوة: تبويب السجلّ كان يسقط صامتاً لفرع خاطئ عند نطاق
    // «الافتتاحي» — تحقّق عدائي ٥/٧).
    it("history({openingScope:true}): مدير ⇒ FORBIDDEN", () =>
      expectForbidden(caller("manager", 1).arReminders.history({ openingScope: true }))
    );
    it("history({openingScope:true}): admin ⇒ مسموح (تجميع كل الفروع)", async () => {
      const out = await caller("admin", 1).arReminders.history({ openingScope: true });
      expect(Array.isArray(out)).toBe(true);
    });
    it("logSent بـisOpeningBalance:true: مدير ⇒ FORBIDDEN (رغم فرعه المُسنَد)", () =>
      expectForbidden(
        caller("manager", 1).arReminders.logSent({
          customerId: 1,
          totalUnpaidSnapshot: "1000",
          oldestInvoiceDate: "2026-01-01",
          daysOverdue: 10,
          messageBody: "x",
          isOpeningBalance: true,
        })
      )
    );
    it("logSent بـisOpeningBalance:true: admin بفرع مُسنَد وبلا branchId ⇒ يصل لفحص الرصيد الافتتاحي (NOT_FOUND لا FORBIDDEN)", async () => {
      await expect(
        caller("admin", 1).arReminders.logSent({
          customerId: 999999,
          totalUnpaidSnapshot: "1000",
          oldestInvoiceDate: "2026-01-01",
          daysOverdue: 10,
          messageBody: "x",
          isOpeningBalance: true,
        })
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
    // اكتُشفت يدوياً أثناء التحقّق البصري (٥/٧): openingWriteBranch كانت تسقط لـ`?? 1` الحرفي
    // (عودة سابقة G3 بالضبط) — معرّفات الفروع تنجرف مع auto_increment (لم تعد ١/٢ في أي قاعدة
    // حيّة/اختبار قديمة) فيَخرق الرقم الحرفيّ قيد FK بدل رسالة واضحة. الآن FORBIDDEN صريح.
    it("logSent بـisOpeningBalance:true: admin بلا فرع مُسنَد وبلا branchId ⇒ FORBIDDEN صريح (لا `?? 1` حرفيّاً)", () =>
      expectForbidden(
        caller("admin", null).arReminders.logSent({
          customerId: 1,
          totalUnpaidSnapshot: "1000",
          oldestInvoiceDate: "2026-01-01",
          daysOverdue: 10,
          messageBody: "x",
          isOpeningBalance: true,
        })
      )
    );
  });
});
