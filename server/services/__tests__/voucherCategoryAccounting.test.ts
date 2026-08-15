import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/mysql-core";
import { voucherCategories } from "../../../drizzle/schema";
import {
  IRAQI_DEFAULT_VOUCHER_CATEGORY_ROLE,
  UNRESOLVED_DEFAULT_VOUCHER_CATEGORIES,
  isVoucherCategoryRoleCompatible,
} from "../../../shared/voucherCategoryAccounting";
import {
  assertVoucherCategoryDefinition,
  findVoucherCategoryMappingIssues,
} from "../voucher/categoryAccounting";

describe("voucher category accounting contract", () => {
  it("يحصر حسابات القبض والصرف ويجعل BOTH تقاطعاً آمناً", () => {
    expect(isVoucherCategoryRoleCompatible("IN", "OTHER_REVENUE")).toBe(true);
    expect(isVoucherCategoryRoleCompatible("OUT", "OTHER_REVENUE")).toBe(false);
    expect(isVoucherCategoryRoleCompatible("OUT", "RENT")).toBe(true);
    expect(isVoucherCategoryRoleCompatible("IN", "RENT")).toBe(false);
    expect(isVoucherCategoryRoleCompatible("BOTH", "OWNER_CURRENT")).toBe(true);
    expect(isVoucherCategoryRoleCompatible("BOTH", "OTHER_EXPENSE")).toBe(false);
    expect(isVoucherCategoryRoleCompatible("OUT", "INVENTORY")).toBe(false);
  });

  it("يرفض الفئة غير المعيّنة أو الحساب غير المتوافق برسالة تشغيلية", () => {
    expect(() => assertVoucherCategoryDefinition({
      direction: "OUT",
      postingRole: null,
      name: "أخرى",
    })).toThrow(TRPCError);
    expect(() => assertVoucherCategoryDefinition({
      direction: "IN",
      postingRole: "RENT",
      name: "إيجار",
    })).toThrow(/لا يتوافق/);
  });

  it("يبذر الواضح فقط ويترك الفئات التي تحتاج مساراً تخصصياً بلا تخمين", () => {
    expect(IRAQI_DEFAULT_VOUCHER_CATEGORY_ROLE["إيجار"]).toBe("RENT");
    expect(IRAQI_DEFAULT_VOUCHER_CATEGORY_ROLE["إيرادات متفرّقة"]).toBe("OTHER_REVENUE");
    for (const name of UNRESOLVED_DEFAULT_VOUCHER_CATEGORIES) {
      expect(IRAQI_DEFAULT_VOUCHER_CATEGORY_ROLE[name]).toBeUndefined();
    }
  });

  it("يثبت عمود varchar وقيد CHECK وترحيل 0187 بعد 0186", () => {
    const table = getTableConfig(voucherCategories);
    expect(table.columns.find((column) => column.name === "postingRole")?.dataType).toBe("string");
    expect(table.checks.map((check) => check.name)).toContain("chk_vchcat_posting_role");
    const migration = readFileSync(
      new URL("../../../drizzle/migrations/0190_voucher_category_accounting.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("ADD COLUMN `postingRole` varchar(64)");
    expect(migration).toContain("WHEN 'إيجار' THEN 'RENT'");
    expect(migration).not.toContain("WHEN 'إيداع نقدي بنكي'");
    const journal = JSON.parse(readFileSync(
      new URL("../../../drizzle/migrations/meta/_journal.json", import.meta.url),
      "utf8",
    )) as { entries: Array<{ tag: string }> };
    const tags = journal.entries.map((entry) => entry.tag);
    const voucherMigrationIndex = tags.indexOf("0190_voucher_category_accounting");
    expect(voucherMigrationIndex).toBeGreaterThan(0);
    expect(tags[voucherMigrationIndex - 1]).toBe(
      "0189_exchange_control_classification",
    );
  });

  it("يحجب ACTIVE للفئة النشطة أو المستعملة غير المهيأة ويهمل المعطلة غير المستعملة", () => {
    const categories = [
      { id: 1, name: "نشطة بلا حساب", direction: "OUT" as const, postingRole: null, isActive: true },
      { id: 2, name: "تاريخية مستعملة", direction: "IN" as const, postingRole: null, isActive: false },
      { id: 3, name: "قديمة غير مستعملة", direction: "OUT" as const, postingRole: null, isActive: false },
      { id: 4, name: "إيجار", direction: "OUT" as const, postingRole: "RENT", isActive: true },
    ];
    expect(findVoucherCategoryMappingIssues(
      categories,
      new Set([2]),
      new Set(["RENT"]),
    )).toEqual([
      { id: 1, name: "نشطة بلا حساب", reason: "UNMAPPED" },
      { id: 2, name: "تاريخية مستعملة", reason: "UNMAPPED" },
    ]);
  });
});
