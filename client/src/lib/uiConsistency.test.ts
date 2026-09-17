import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { actorLabel } from "@/components/data-table/ActorCell";
import {
  operationActionLabel,
  operationSubjectLabel,
  operationTimeLabel,
} from "@/components/data-table/OperationAttribution";
import { DISPLAY_SCALES, isDisplayScale } from "@/lib/displayScale";
import { APPLICATION_MODULES } from "@/lib/moduleRegistry";
import { applyPosQuantityKey } from "@/lib/posQuantityEntry";
import { resolveWorkspaceProfile } from "@/lib/workspaceProfiles";

describe("سجل وحدات التطبيق", () => {
  it("لا يكرر المعرّفات أو المسارات", () => {
    expect(new Set(APPLICATION_MODULES.map((module) => module.id)).size).toBe(APPLICATION_MODULES.length);
    expect(new Set(APPLICATION_MODULES.map((module) => module.href)).size).toBe(APPLICATION_MODULES.length);
  });

  it("يوثّق كل بطاقة بما يلزم لإضافتها تلقائياً إلى الرئيسية", () => {
    for (const module of APPLICATION_MODULES) {
      expect(module.label.trim()).not.toBe("");
      expect(module.description.trim()).not.toBe("");
      expect(module.section).toBeGreaterThanOrEqual(1);
      expect(module.section).toBeLessThanOrEqual(5);
      expect(module.icon).toBeTruthy();
    }
  });

  it("يشمل الوحدات التي كانت مفقودة من بطاقات الرئيسية", () => {
    const ids = new Set(APPLICATION_MODULES.map((module) => module.id));
    for (const id of ["priceChecker", "myDeliveries", "gifts", "digitalCards", "chartOfAccounts"]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("يغذّي القائمة من سجل الوحدات والرئيسية من ملف العمل المسموح فقط", () => {
    const layout = readFileSync("client/src/components/AppLayout.tsx", "utf8");
    const dashboard = readFileSync("client/src/pages/Dashboard.tsx", "utf8");
    expect(layout).toContain("APPLICATION_MODULES as NAV_LINKS");
    expect(dashboard).toContain("resolveWorkspaceProfile({");
    expect(dashboard).toContain("profile.primaryNav");
    expect(dashboard).toContain("href={item.href}");
    expect(dashboard).not.toContain("const CORE_MODULES");
    expect(dashboard).not.toContain("const ACTIONS");
    expect(dashboard).not.toContain("APPLICATION_MODULES");
    expect(dashboard).not.toContain("canSeeGate");
    expect(dashboard).toContain("me.isLoading");
    expect(dashboard).toContain("me.isError || !me.data");
    expect(dashboard).toContain("<LoadingState");
    expect(dashboard).toContain("<ErrorState");
    expect(dashboard).not.toContain("if (!me.data) return null");
  });

  it("يثبّت محطة الكاشير وبوابات مؤشرات الرئيسية من الملف المحلول", () => {
    const dashboard = readFileSync("client/src/pages/Dashboard.tsx", "utf8");
    const cashierHome = readFileSync(
      "client/src/components/dashboard/CashierHome.tsx",
      "utf8",
    );
    const resolveAt = dashboard.indexOf("const profile = resolveWorkspaceProfile({");
    const cashierAt = dashboard.indexOf('me.data.role === "cashier" && cashierStation');

    expect(resolveAt).toBeGreaterThan(-1);
    expect(cashierAt).toBeGreaterThan(resolveAt);
    expect(dashboard).toContain("const cashierStation = profile.defaultAction?.station;");
    expect(dashboard).toContain("station={cashierStation}");
    expect(dashboard).toContain("defaultAction={profile.defaultAction}");
    expect(cashierHome).toContain('const isReception = station === "RECEPTION";');
    expect(cashierHome).not.toContain('const isReception = can("workorders", "FULL");');
    expect(cashierHome).toContain("shiftType: station");
    expect(cashierHome).toContain('station === "RETAIL" ? "/pos" : defaultAction.href');

    const cashierCases = [
      {
        permissionsOverride: { sales: "FULL", pos: "NONE", workorders: "NONE" } as const,
        station: "RETAIL",
        href: "/pos?mode=RETAIL",
      },
      {
        permissionsOverride: { sales: "NONE", pos: "FULL", workorders: "NONE" } as const,
        station: "PRINT_SERVICES",
        href: "/pos?mode=PRINT_SERVICES",
      },
      {
        permissionsOverride: { sales: "NONE", pos: "NONE", workorders: "FULL" } as const,
        station: "RECEPTION",
        href: "/pos?mode=RECEPTION",
      },
    ];
    for (const expected of cashierCases) {
      const profile = resolveWorkspaceProfile({
        role: "cashier",
        permissionsOverride: expected.permissionsOverride,
      });
      expect(profile.defaultAction).toMatchObject({
        station: expected.station,
        href: expected.href,
      });
    }
    const multiCashier = resolveWorkspaceProfile({ role: "cashier" });
    expect(multiCashier.id).toBe("cashier_multi");
    expect(multiCashier.defaultAction?.station).toBe("RETAIL");
    const stationlessCashier = resolveWorkspaceProfile({
      role: "cashier",
      permissionsOverride: { sales: "NONE", pos: "NONE", workorders: "NONE" },
    });
    expect(stationlessCashier.stations).toEqual([]);
    expect(stationlessCashier.defaultAction?.station).toBeUndefined();

    expect(dashboard).toContain('hasModuleAccess(role, override, "treasury", "READ")');
    expect(dashboard).toContain("enabled: canViewTreasury && branchScope !== undefined");
    expect(dashboard).toContain('hasModuleAccess(role, override, "inventory", "READ")');
    expect(dashboard).toContain('profileActionHref(primaryNav, "inventory")');
    expect(dashboard).toContain('hasModuleAccess(role, override, "workorders", "READ")');
    expect(dashboard).toContain("enabled: canViewWorkOrders && branchScope !== undefined");
    expect(dashboard).toContain("if (!canViewWorkOrders) return null;");
    expect(dashboard).toContain('profileActionHref(primaryNav, "my_tasks")');
    expect(dashboard).not.toContain('href: "/inventory"');
    expect(dashboard).not.toContain('href={`/work-orders?branch=${branchScope}`}');
    expect(dashboard).not.toContain('href="/tasks?tab=mine"');
  });
});

describe("بيان منفّذ العملية", () => {
  it("لا يعرض شرطة مبهمة للسجلات القديمة أو النظام", () => {
    expect(actorLabel(undefined)).toBe("غير موثّق");
    expect(actorLabel({ source: "legacy" })).toBe("بيانات قديمة");
    expect(actorLabel({ source: "system" })).toBe("النظام");
    expect(actorLabel({ source: "external" })).toBe("جهة خارجية");
    expect(actorLabel({ source: "device" })).toBe("جهاز");
    expect(actorLabel({ source: "platform" })).toBe("مدير المنصّة");
    expect(actorLabel({ userId: 42 })).toBe("مستخدم #42");
    expect(actorLabel({ userId: 42, name: "  أحمد  " })).toBe("أحمد");
  });

  it("يفرض العقد الكامل: من قام، ماذا فعل، على ماذا، ومتى", () => {
    const operation = {
      actor: { userId: 7, name: "أحمد" },
      action: { code: "sale.create", label: "إنشاء فاتورة" },
      subject: { type: "invoice", label: "فاتورة", id: "INV-22" },
      at: null,
    };
    expect(operationActionLabel(operation)).toBe("إنشاء فاتورة");
    expect(operationSubjectLabel(operation.subject)).toBe("فاتورة #INV-22");
    expect(operationTimeLabel(operation.at)).toBe("وقت غير موثّق");
  });

  it("يطبّق العقد الموحد على السجلات التشغيلية والمالية الأساسية", () => {
    const table = readFileSync("client/src/components/data-table/DataTable.tsx", "utf8");
    const audit = readFileSync("client/src/pages/AuditLogs.tsx", "utf8");
    const invoices = readFileSync("client/src/pages/Invoices.tsx", "utf8");
    const workOrders = readFileSync("client/src/pages/WorkOrders.tsx", "utf8");
    const exchange = readFileSync("client/src/pages/ExchangeStatement.tsx", "utf8");
    const ledger = readFileSync("client/src/pages/GeneralLedger.tsx", "utf8");
    const broadcasts = readFileSync("client/src/pages/WaBroadcasts.tsx", "utf8");
    expect(table).toContain('mode?: "compact" | "columns"');
    expect(table).toContain("OperationAttributionCell");
    expect(audit).toContain('mode: "columns" as const');
    expect(invoices).toContain("operation={invoiceOperation}");
    expect(workOrders).toContain("operation={operation}");
    expect(exchange).toContain("operation={operation}");
    expect(ledger).toContain("operation={operation}");
    expect(broadcasts).toContain("operation={operation}");
  });

  it("يوصل سجل الشاشة إلى كل المسارات المحمية ويعرض سجل المنصّة المستقل", () => {
    const app = readFileSync("client/src/App.tsx", "utf8");
    const launcher = readFileSync("client/src/components/audit/OperationAuditAccess.tsx", "utf8");
    const audit = readFileSync("client/src/pages/AuditLogs.tsx", "utf8");
    const platform = readFileSync("client/src/pages/PlatformAdmin.tsx", "utf8");
    expect(app).toContain("<OperationAuditAccess />");
    expect(app).toContain('path="/audit"');
    expect(launcher).toContain("screenPath=");
    expect(audit).toContain("auditOperationMeta");
    expect(platform).toContain("<PlatformAuditTable />");
  });
});

describe("مقياس العرض الآمن", () => {
  it("لا يقبل قيمة خارج الحدود المعرفة", () => {
    for (const scale of DISPLAY_SCALES) expect(isDisplayScale(scale)).toBe(true);
    expect(isDisplayScale("200%")).toBe(false);
    expect(isDisplayScale(1.5)).toBe(false);
  });
});

describe("انحدارات واجهة نقطة البيع", () => {
  it("يستبدل الكمية الافتراضية بأول رقم ثم يواصل التحرير", () => {
    const first = applyPosQuantityKey(1, "5", true);
    expect(first).toEqual({ quantity: 5, replaceNextDigit: false });

    const second = applyPosQuantityKey(first.quantity, "2", first.replaceNextDigit);
    expect(second).toEqual({ quantity: 52, replaceNextDigit: false });
    expect(applyPosQuantityKey(second.quantity, "⌫", false).quantity).toBe(5);
    expect(applyPosQuantityKey(6, "C", false)).toEqual({ quantity: 1, replaceNextDigit: true });
  });

  it("يحجز إجراءات الوردية وشارة الأوفلاين في الرأس الموحد", () => {
    const shell = readFileSync("client/src/pages/PointOfSale.tsx", "utf8");
    // م١ PR-B: إجراءات رأس كاشير التجزئة استُخرجت إلى مكوّنها (تُحقَن بـcreatePortal من الشاشة) —
    // العقد المحروس (createPortal في الشاشة + placement="inline" في الإجراءات) يمتدّ على الملفّين.
    const retail = readFileSync("client/src/pages/POS.tsx", "utf8")
      + readFileSync("client/src/components/pos/RetailPosHeaderActions.tsx", "utf8");
    const print = readFileSync("client/src/pages/PrintPOS.tsx", "utf8")
      + readFileSync("client/src/components/print-pos/PrintPosHeader.tsx", "utf8");
    const offlineChip = readFileSync("client/src/components/offline/OfflineSyncChip.tsx", "utf8");

    expect(shell).not.toContain('activeMode === "RECEPTION" ?');
    expect(retail).toContain("createPortal");
    expect(print).toContain("createPortal");
    expect(retail).toContain('placement="inline"');
    expect(print).toContain('placement="inline"');
    expect(retail).not.toContain('<OfflineSyncChip userRole={me.data?.role} />');
    expect(print).not.toContain('<OfflineSyncChip userRole={me.data?.role} />');
    expect(offlineChip).toContain('placement = "floating"');
  });
});
