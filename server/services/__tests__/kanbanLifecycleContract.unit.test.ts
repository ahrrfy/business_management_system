import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractUnifiedReceiptBaseCode,
  pickSiblingFallbackTarget,
  resolveHandoverBarcodeTarget,
  resolveWorkOrderHandoverFinancials,
  UNIFIED_RECEIPT_SIBLING_MATCH_RANK,
  type SiblingWorkOrderItem,
} from "../workOrder/kanbanQueries";

/**
 * يقرأ مصدر ملف TypeScript/TSX ويزيل التعليقات الكتلية (`/* ... *\/` وبضمنها تعليقات JSX `{/* ... *\/}`)
 * والتعليقات السطرية (`// ...` مع صون الروابط مثل `https://`)، مع الحفاظ على أرقام الأسطر الأصلية
 * بحيث تفحص الاختبارات الكود الفعلي ونصوص الواجهة دون إنذارات كاذبة من التعليقات التوضيحية.
 */
function executableSource(relPath: string): string {
  const fullPath = path.resolve(process.cwd(), relPath);
  const raw = readFileSync(fullPath, "utf8");
  const withoutBlock = raw.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\r\n]/g, " "),
  );
  return withoutBlock.replace(/(^|[\s;{}(),])\/\/[^\r\n]*/gm, "$1");
}

/** يعيد قائمة الأسطر المطابقة مع أرقامها التشخيصية لتسهيل قراءة سبب الفشل فوراً. */
function matchingLines(code: string, pattern: string | RegExp): string[] {
  const rx =
    typeof pattern === "string"
      ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      : new RegExp(pattern.source, pattern.flags.replace(/g/g, ""));
  const hits: string[] = [];
  const lines = code.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (rx.test(lines[i])) {
      hits.push(`L${i + 1}: ${lines[i].trim()}`);
    }
  }
  return hits;
}

describe("دستور دورة حياة الكانبان وتصريف أوامر الشغل (العقد المعماري والسلوكي)", () => {
  describe("١. نقاء لوحة الكانبان (WorkOrders.tsx و WorkOrderKanbanCard.tsx)", () => {
    it("يقتصر WorkOrders.tsx على مراحل الإنتاج ويقصي المُسلَّم والمُسنَد للتوصيل ولا يحوي تصريفاً تلقائياً", () => {
      const workOrdersCode = executableSource("client/src/pages/WorkOrders.tsx");

      expect(matchingLines(workOrdersCode, "autoClearReady")).toEqual([]);
      expect(matchingLines(workOrdersCode, "تصريف تلقائي")).toEqual([]);
      expect(
        matchingLines(workOrdersCode, /statuses:\s*\[\s*["']DELIVERED["']/),
      ).toEqual([]);
      expect(workOrdersCode).toMatch(/excludeDispatchedReady:\s*true/);
    });

    it("يخلو WorkOrderKanbanCard.tsx من أزرار وخصائص التسليم الفوري أو الإرسال للتوصيل", () => {
      const cardCode = executableSource(
        "client/src/components/workOrders/WorkOrderKanbanCard.tsx",
      );

      expect(matchingLines(cardCode, "تسليم فوري")).toEqual([]);
      expect(matchingLines(cardCode, "إرسال للتوصيل")).toEqual([]);
      expect(matchingLines(cardCode, "onQuickDeliver")).toEqual([]);
      expect(matchingLines(cardCode, "onQuickDispatch")).toEqual([]);
    });
  });

  describe("٢. حوكمة «جرد الرفّ» الذري في طابور الاستقبال (ReceptionOrderQueue.tsx و shelfAudit.ts)", () => {
    it("يمنع التوزيع الآلي لمتجر الأونلاين ويلزم عبارة التأكيد الصريحة «جرد وتسليم» بلا زر تحديد الكل", () => {
      const receptionCode = executableSource(
        "client/src/components/reception/ReceptionOrderQueue.tsx",
      );

      expect(
        matchingLines(receptionCode, "storeAdmin.orders.autoAssignRoundRobin"),
      ).toEqual([]);
      expect(matchingLines(receptionCode, "autoAssignRoundRobin")).toEqual([]);
      expect(matchingLines(receptionCode, "جرد وتسليم").length).toBeGreaterThan(
        0,
      );
      expect(matchingLines(receptionCode, "تحديد الكل")).toEqual([]);
    });

    it("ينفّذ shelfAudit.ts تسليم الدفعة وسجل التدقيق workOrder.shelfAuditDeliver ذرياً داخل معاملة واحدة (withTx + deliverWorkOrderInTx + logAuditTx)", () => {
      const shelfAuditCode = executableSource(
        "server/services/workOrder/shelfAudit.ts",
      );

      expect(matchingLines(shelfAuditCode, "withTx").length).toBeGreaterThan(0);
      expect(
        matchingLines(shelfAuditCode, "deliverWorkOrderInTx").length,
      ).toBeGreaterThan(0);
      expect(
        matchingLines(shelfAuditCode, "logAuditTx").length,
      ).toBeGreaterThan(0);
      expect(
        matchingLines(shelfAuditCode, "workOrder.shelfAuditDeliver").length,
      ).toBeGreaterThan(0);
    });
  });

  describe("٣. حوكمة المسار العكسي للتوصيل والعهدة المادية (ReturnConsignmentDialog.tsx و DeliveryHub.tsx و returns.ts و custody.ts)", () => {
    it("يخيّر ReturnConsignmentDialog.tsx الموظف بين RETURN_TO_READY و CANCEL_FINAL لأوامر الشغل ولا يحجب إعادة الجاهزية بعربون البضاعة", () => {
      const dialogCode = executableSource(
        "client/src/components/delivery/ReturnConsignmentDialog.tsx",
      );

      expect(
        matchingLines(dialogCode, '"RETURN_TO_READY"').length,
      ).toBeGreaterThan(0);
      expect(
        matchingLines(dialogCode, '"CANCEL_FINAL"').length,
      ).toBeGreaterThan(0);
      expect(
        matchingLines(dialogCode, "إعادة الطلب إلى «جاهز للتسليم»").length,
      ).toBeGreaterThan(0);
      expect(
        matchingLines(dialogCode, "إلغاء الطلب نهائياً واسترجاع الفاتورة")
          .length,
      ).toBeGreaterThan(0);
      expect(
        matchingLines(dialogCode, 'role="radiogroup"').length,
      ).toBeGreaterThan(0);
      expect(
        matchingLines(dialogCode, "requestOnly={gate.isReturnToReady}").length,
      ).toBeGreaterThan(0);
      expect(
        matchingLines(dialogCode, "workOrderDisposition").length,
      ).toBeGreaterThan(0);
    });

    it("يمرر DeliveryHub.tsx هوية أمر الشغل وخيار workOrderDisposition إلى returnConsignment", () => {
      const hubCode = executableSource("client/src/pages/DeliveryHub.tsx");

      expect(matchingLines(hubCode, "isWorkOrder").length).toBeGreaterThan(0);
      expect(matchingLines(hubCode, "workOrderId").length).toBeGreaterThan(0);
      expect(
        matchingLines(hubCode, "workOrderDisposition").length,
      ).toBeGreaterThan(0);
    });

    it("يدعم returns.ts و custody.ts إعادة الطرد إلى READY ونقل العهدة المادية من CARRIER_CUSTODY إلى PREPARED_HELD", () => {
      const returnsServiceCode = executableSource(
        "server/services/delivery/returns.ts",
      );
      const custodyServiceCode = executableSource(
        "server/services/delivery/custody.ts",
      );

      expect(
        matchingLines(returnsServiceCode, "RETURN_TO_READY").length,
      ).toBeGreaterThan(0);
      expect(
        matchingLines(returnsServiceCode, "CANCEL_FINAL").length,
      ).toBeGreaterThan(0);
      expect(
        matchingLines(custodyServiceCode, "RETURN_TO_READY").length,
      ).toBeGreaterThan(0);
      expect(custodyServiceCode).toMatch(
        /workOrderDisposition\s*===\s*["']RETURN_TO_READY["'][\s\S]{0,300}toState:\s*["']PREPARED_HELD["']/,
      );
      expect(
        matchingLines(returnsServiceCode, "DLV-FEE-WO-").length,
      ).toBeGreaterThanOrEqual(2);
      expect(
        matchingLines(returnsServiceCode, "requestNoncashWorkOrderFeeRefundTx").length,
      ).toBeGreaterThanOrEqual(2);
    });
  });

  describe("٤. خلوّ الراوتر من الإسناد العشوائي للمندوب وحرّاس تسليم الفاتورة المعاد استعمالها (workOrderRouter.ts و deliver.ts)", () => {
    it("لا يحوي workOrderRouter.ts إسناد autoclear-dispatch- ولا اختيار مندوب INDIVIDUAL عشوائي بـ limit(1)", () => {
      const routerCode = executableSource("server/routers/workOrderRouter.ts");

      expect(matchingLines(routerCode, "autoclear-dispatch-")).toEqual([]);
      expect(routerCode).not.toMatch(
        /partyType,\s*["']INDIVIDUAL["'][\s\S]{0,160}\.limit\(\s*1\s*\)/,
      );
    });

    it("يطبّق deliver.ts حارس الدفع الكامل لـ COD عند الاستلام المباشر في فرعَي الفاتورة القائمة والجديدة ويتطابق مع جرد كتّاب الإيصالات", () => {
      const deliverCode = executableSource(
        "server/services/workOrder/deliver.ts",
      );
      const gateTestRaw = readFileSync(
        path.resolve(
          process.cwd(),
          "server/services/__tests__/cashDayClosedWriteGate.test.ts",
        ),
        "utf8",
      );

      expect(
        matchingLines(deliverCode, "requiresFullPaymentAtHandover").length,
      ).toBeGreaterThanOrEqual(3); // الاستيراد + فرع الفاتورة القائمة + فرع الفاتورة الجديدة

      const receiptInserts =
        deliverCode.match(/(?:\.|\b)insert\(receipts\)/g)?.length ?? 0;
      expect(receiptInserts).toBe(2);
      expect(gateTestRaw).toContain('"workOrder/deliver.ts": 2,');
      expect(
        matchingLines(deliverCode, "closeWorkOrderDirectHandoverCustodyTx").length,
      ).toBeGreaterThanOrEqual(2);
      const debtPreconditionIdx = deliverCode.indexOf("!input.addToCustomerDebt");
      const codReusedInvoiceIdx = deliverCode.indexOf(
        "requiresFullPaymentAtHandover(woPaymentMode",
      );
      expect(debtPreconditionIdx).toBeGreaterThan(0);
      expect(codReusedInvoiceIdx).toBeGreaterThan(debtPreconditionIdx);
    });
  });

  describe("٥. حسم باركود الوصل الموحّد وأرصدة الفاتورة المرتبطة للأوامر الشقيقة (kanbanQueries.ts و ReceptionHandoverPage.tsx)", () => {
    it("يستخرج الرقم الأساسي للوصل الموحّد من الرموز البسيطة والمركّبة ويرفض محارف البدل", () => {
      expect(extractUnifiedReceiptBaseCode("103757")).toBe("103757");
      expect(extractUnifiedReceiptBaseCode("WO-103757")).toBe("103757");
      expect(extractUnifiedReceiptBaseCode("103757-1")).toBe("103757");
      expect(extractUnifiedReceiptBaseCode("103757-2")).toBe("103757");
      expect(extractUnifiedReceiptBaseCode("WO-1-20261030-0042-2")).toBe(
        "WO-1-20261030-0042",
      );
      expect(extractUnifiedReceiptBaseCode("12")).toBeNull();
      expect(extractUnifiedReceiptBaseCode("103%57")).toBeNull();
      expect(extractUnifiedReceiptBaseCode("103_57")).toBeNull();
    });

    it("يُعطي pickSiblingFallbackTarget الأولوية لأوّل شقيق READY للاستلام المباشر", () => {
      const siblings: SiblingWorkOrderItem[] = [
        {
          id: 101,
          orderNumber: "103757-1",
          title: "كارت شخصي",
          status: "IN_PROGRESS",
          salePrice: "25000.00",
          deposit: "25000.00",
          hasDelivery: false,
          customerName: "أحمد",
          customerPhone: null,
        },
        {
          id: 102,
          orderNumber: "103757-2",
          title: "فولدر مطبوع",
          status: "READY",
          salePrice: "40000.00",
          deposit: "40000.00",
          hasDelivery: true,
          customerName: "أحمد",
          customerPhone: null,
        },
        {
          id: 103,
          orderNumber: "103757-3",
          title: "بوستر فلكس",
          status: "READY",
          salePrice: "15000.00",
          deposit: "15000.00",
          hasDelivery: false,
          customerName: "أحمد",
          customerPhone: null,
        },
      ];

      expect(pickSiblingFallbackTarget([])).toBeNull();
      expect(pickSiblingFallbackTarget(siblings)).toEqual({
        kind: "WORK_ORDER",
        id: 103,
      });

      // يفضّل أشقاء الوصل الموحّد (رتبة 60) على تطابق معرّف قاعدة البيانات الموروث (رتبة 10)
      expect(
        resolveHandoverBarcodeTarget(
          "103757",
          "NUMERIC",
          [{ kind: "INVOICE", id: 103757, matchRank: 10 }],
          siblings,
        ),
      ).toEqual({
        kind: "WORK_ORDER",
        id: 103,
        matchRank: UNIFIED_RECEIPT_SIBLING_MATCH_RANK,
      });

      // يحفظ أسبقية التطابق الصريح لرقم المستند (رتبة 100) على أشقاء الوصل الموحّد
      expect(
        resolveHandoverBarcodeTarget(
          "103757-1",
          "REFERENCE",
          [{ kind: "WORK_ORDER", id: 101, matchRank: 100 }],
          siblings,
        ),
      ).toEqual({
        kind: "WORK_ORDER",
        id: 101,
        matchRank: 100,
      });

      // يحترم عزل النطاق فلا يخلط بادئة فاتورة صريحة (INV-) بأشقاء أوامر الشغل
      expect(
        resolveHandoverBarcodeTarget("INV-103757", "INVOICE", [], siblings),
      ).toBeNull();
    });

    it("يعتمد resolveWorkOrderHandoverFinancials أرصدة الفاتورة القائمة الفعّالة ويتجاهل الفواتير الميتة", () => {
      // فاتورة قائمة قُبض عليها لاحقاً بعد إلغاء الإسناد
      expect(
        resolveWorkOrderHandoverFinancials(
          { salePrice: "50000.00", deposit: "10000.00", invoiceId: 77 },
          {
            status: "PAID",
            total: "50000.00",
            returnedTotal: "0.00",
            paidAmount: "50000.00",
          },
        ),
      ).toEqual({ salePrice: "50000.00", deposit: "50000.00" });

      // فاتورة قائمة مسدّدة جزئياً مع مرتجع جزئي
      expect(
        resolveWorkOrderHandoverFinancials(
          { salePrice: "50000.00", deposit: "10000.00", invoiceId: 78 },
          {
            status: "PARTIALLY_PAID",
            total: "50000.00",
            returnedTotal: "5000.00",
            paidAmount: "25000.00",
          },
        ),
      ).toEqual({ salePrice: "45000.00", deposit: "25000.00" });

      // فاتورة ميتة (CANCELLED / RETURNED / SUPERSEDED) ترجع لحقول أمر الشغل
      for (const deadStatus of ["CANCELLED", "RETURNED", "SUPERSEDED"]) {
        expect(
          resolveWorkOrderHandoverFinancials(
            { salePrice: "30000.00", deposit: "5000.00", invoiceId: 79 },
            {
              status: deadStatus,
              total: "30000.00",
              returnedTotal: "0.00",
              paidAmount: "30000.00",
            },
          ),
        ).toEqual({ salePrice: "30000.00", deposit: "5000.00" });
      }
    });

    it("يحدّد ReceptionHandoverPage.tsx البند المُسلَّم من vars.workOrderId ويعطّل أزرار التبديل أثناء التنفيذ", () => {
      const handoverCode = executableSource(
        "client/src/pages/reception/ReceptionHandoverPage.tsx",
      );

      expect(
        matchingLines(handoverCode, "const deliveredId = vars.workOrderId")
          .length,
      ).toBe(1);
      expect(
        matchingLines(
          handoverCode,
          "disabled={deliverMut.isPending || collectInvoiceMut.isPending}",
        ).length,
      ).toBeGreaterThanOrEqual(2);
      expect(
        matchingLines(handoverCode, "wo.linkedInvoice.paidAmount").length,
      ).toBeGreaterThanOrEqual(2);
    });
  });
});
