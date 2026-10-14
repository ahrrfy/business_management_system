import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  workOrderDetailOperationAccess,
  workOrderDirectCancellationAllowed,
} from "@/lib/workOrderDetailOperationAccess";
import type { OperationUser } from "@shared/operationPermissions";

const page = readFileSync(
  new URL("../WorkOrderDetail.tsx", import.meta.url),
  "utf8",
);
const operationAccess = readFileSync(
  new URL("../../lib/workOrderDetailOperationAccess.ts", import.meta.url),
  "utf8",
);

describe("واجهة عكس التسليم من تفاصيل أمر الشغل", () => {
  it("تستعمل طلب التحكم الموحد ولا تستدعي الكاتب الفوري", () => {
    expect(page).toContain("<ReverseDeliveryRequestDialog");
    expect(page).toContain('data.status === "DELIVERED"');
    // ١/٩/٢٦: انقسمت سلطةُ التحكّم — الإلغاءُ صار لأدوار التنفيذ (فنّي المطبعة) بينما
    // **عكسُ التسليم يبقى تجارياً** (كاشير/مدير). الحارسُ يتبع الاسم الجديد كي لا يُثبّت
    // البوّابةَ القديمة على الزرّ الخطأ.
    expect(page).toContain(
      'canRequestCommercialControl && data.status === "DELIVERED"',
    );
    expect(page).toContain("workOrderDetailOperationAccess(me.data)");
    expect(operationAccess).toContain(
      'mayRequestWorkOrderControl("COMMERCIAL_EDIT"',
    );
    expect(page).not.toContain("trpc.workOrders.reverseDelivery.useMutation");
    expect(page).not.toContain(
      "trpc.workOrders.reverseServiceInvoice.useMutation",
    );
  });

  it("uses the same canonical direct-cancel authority for confirmation and display", () => {
    const delegated: OperationUser = {
      role: "warehouse",
      operationPolicyEnabled: true,
      resolvedOperationPolicy: {
        version: 1,
        grants: { "operation.workOrders.cancel": true },
      },
    };
    const preflight = {
      status: "RECEIVED",
      cancelMoneyAtStake: false,
      controlRequired: { cancel: false },
    };
    const delegatedAccess = workOrderDetailOperationAccess(delegated);
    expect(delegatedAccess.canCancelDirectly).toBe(true);
    expect(
      workOrderDirectCancellationAllowed(
        delegated,
        preflight,
        delegatedAccess.canCancelDirectly,
      ),
    ).toBe(true);
    expect(
      workOrderDirectCancellationAllowed(
        delegated,
        { ...preflight, cancelMoneyAtStake: true },
        true,
      ),
    ).toBe(false);
    expect(
      workOrderDirectCancellationAllowed(
        delegated,
        { ...preflight, status: "READY" },
        true,
      ),
    ).toBe(false);
    const legacy = { role: "warehouse" };
    const legacyAccess = workOrderDetailOperationAccess(legacy);
    expect(legacyAccess.canCancelDirectly).toBe(false);
    expect(
      workOrderDirectCancellationAllowed(
        legacy,
        preflight,
        legacyAccess.canCancelDirectly,
      ),
    ).toBe(false);
    expect(page).toContain(
      "const requiresApproval = !workOrderDirectCancellationAllowed(",
    );
  });

  it("يعرض ملف التصميم حتى لنسخة تصميم بلا صور", () => {
    expect(page).toContain(
      "<DesignFileCard images={(data.images ?? []) as never}",
    );
    expect(page).not.toContain("data.images && data.images.length > 0");
  });
});
