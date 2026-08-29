import { describe, expect, it } from "vitest";
import {
  filterIntegrations,
  summarizeIntegrations,
  type IntegrationCenterItem,
} from "./integrationCenter";

const ITEMS: IntegrationCenterItem[] = [
  { branchId: 1, branchName: "الفرع الرئيسي", channel: "WHATSAPP", displayName: "خدمة العملاء", status: "ACTIVE" },
  { branchId: 1, branchName: "الفرع الرئيسي", channel: "INSTAGRAM", displayName: null, status: "FAILED" },
  { branchId: 2, branchName: "فرع المبيعات", channel: "STORE", displayName: "متجر الويب", status: "PENDING" },
  { branchId: 2, branchName: "فرع المبيعات", channel: "WHATSAPP", displayName: null, status: "DISABLED" },
];

describe("integrationCenter", () => {
  it("يلخّص الحالات التشغيلية من دون عدّ المعطّل ضمن ما يحتاج تدخلاً", () => {
    expect(summarizeIntegrations(ITEMS)).toEqual({ total: 4, active: 1, attention: 2, disabled: 1 });
  });

  it("يطبّق كل فلتر منفرداً ثم يجمع الفلاتر", () => {
    const baseFilters = { query: "", status: "ALL", channel: "ALL", branchId: null } as const;

    expect(filterIntegrations(ITEMS, { ...baseFilters, branchId: 1 })).toEqual([ITEMS[0], ITEMS[1]]);
    expect(filterIntegrations(ITEMS, { ...baseFilters, channel: "INSTAGRAM" })).toEqual([ITEMS[1]]);
    expect(filterIntegrations(ITEMS, { ...baseFilters, status: "ACTIVE" })).toEqual([ITEMS[0]]);
    expect(filterIntegrations(ITEMS, { ...baseFilters, status: "DISABLED" })).toEqual([ITEMS[3]]);
    expect(filterIntegrations(ITEMS, { ...baseFilters, status: "ATTENTION" })).toEqual([ITEMS[1], ITEMS[2]]);

    expect(filterIntegrations(ITEMS, {
      query: "",
      status: "ATTENTION",
      channel: "STORE",
      branchId: 2,
    })).toEqual([ITEMS[2]]);
  });

  it("يبحث في الاسم العربي واسم الفرع والقناة", () => {
    expect(filterIntegrations(ITEMS, {
      query: "المبيعات",
      status: "ALL",
      channel: "ALL",
      branchId: null,
    })).toEqual([ITEMS[2], ITEMS[3]]);

    expect(filterIntegrations(ITEMS, {
      query: "whatsapp",
      status: "ALL",
      channel: "ALL",
      branchId: null,
    })).toEqual([ITEMS[0], ITEMS[3]]);

    expect(filterIntegrations(ITEMS, {
      query: "واتساب",
      status: "ALL",
      channel: "ALL",
      branchId: null,
    })).toEqual([ITEMS[0], ITEMS[3]]);

    expect(filterIntegrations(ITEMS, {
      query: "متجر",
      status: "ALL",
      channel: "ALL",
      branchId: null,
    })).toEqual([ITEMS[2]]);

    expect(filterIntegrations(ITEMS, {
      query: "خدمة العملاء",
      status: "ALL",
      channel: "ALL",
      branchId: null,
    })).toEqual([ITEMS[0]]);

    expect(filterIntegrations(ITEMS, {
      query: "٢",
      status: "ALL",
      channel: "ALL",
      branchId: null,
    })).toEqual([ITEMS[2], ITEMS[3]]);

    expect(filterIntegrations([{ ...ITEMS[0], branchName: "أربيل" }], {
      query: "اربيل",
      status: "ALL",
      channel: "ALL",
      branchId: null,
    })).toHaveLength(1);

    expect(filterIntegrations([{ ...ITEMS[0], branchName: null }], {
      query: "whatsapp",
      status: "ALL",
      channel: "ALL",
      branchId: null,
    })).toHaveLength(1);
  });

  it("يتعامل مع القائمة الفارغة", () => {
    expect(summarizeIntegrations([])).toEqual({ total: 0, active: 0, attention: 0, disabled: 0 });
    expect(filterIntegrations([], {
      query: "",
      status: "ALL",
      channel: "ALL",
      branchId: null,
    })).toEqual([]);
  });

  it("لا يغيّر المصفوفة الأصلية", () => {
    const snapshot = [...ITEMS];
    filterIntegrations(ITEMS, { query: "", status: "ALL", channel: "ALL", branchId: null });
    expect(ITEMS).toEqual(snapshot);
  });
});
