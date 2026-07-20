import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createSupplier } from "../supplierService";
import { createVoucher } from "../voucher/create";
import { approveVoucher } from "../voucher/approval";

/**
 * بضاعة الأمانة — ش٥: حوكمة تسوية المودِع — كل صرفٍ له PENDING دائماً (SOD) + سقف ≤ المستحق
 * يُعاد فحصه عند الاعتماد. راجع design §٥ حاصرة ٢/ث٤.
 */
const mgr = { userId: 1, branchId: 1, role: "manager" as const };
const mgr2 = { userId: 2, branchId: 1, role: "manager" as const };
const TABLES = ["accountingEntries", "receipts", "shifts", "suppliers", "users", "branches"];
function db() { const d = getDb(); if (!d) throw new Error("no DB"); return d; }
async function seedBase() {
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values([
    { id: 1, openId: "m1", name: "مدير", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "m2", name: "مدير٢", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
}
async function mkConsignorWithBalance(bal: string) {
  return (await createSupplier({ name: "أ. حيدر", supplierKind: "CONSIGNOR", openingBalance: bal, openingBalanceDirection: "OWED_BY_US" }, mgr)).supplierId;
}
async function balance(id: number) { return (await db().select().from(s.suppliers).where(eq(s.suppliers.id, id)))[0].currentBalance; }
beforeEach(async () => { await truncateTables(TABLES); await seedBase(); });

describe("بضاعة الأمانة ش٥ — حوكمة تسوية المودِع", () => {
  it("سند صرف لمودِع أمانة يُنشأ PENDING دائماً (ولو صغُر المبلغ دون عتبة المليون)", async () => {
    const cid = await mkConsignorWithBalance("10000");
    const r = await createVoucher({ voucherType: "PAYMENT", branchId: 1, amount: "5000", paymentMethod: "CASH", partyType: "SUPPLIER", partyId: cid, description: "تسوية" }, mgr);
    expect(r.approvalStatus).toBe("PENDING_APPROVAL"); // لا اعتماد ذاتيّ رغم أن 5000 < المليون
    // الأثر المالي معلَّق — الرصيد لم يتغيّر بعد.
    expect(await balance(cid)).toBe("10000.00");
  });

  it("صرف يتجاوز المستحق يُرفض عند الإنشاء", async () => {
    const cid = await mkConsignorWithBalance("10000");
    await expect(createVoucher({ voucherType: "PAYMENT", branchId: 1, amount: "15000", paymentMethod: "CASH", partyType: "SUPPLIER", partyId: cid, description: "زائد" }, mgr))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("الاعتماد بمدير آخر (SOD) يرحّل PAYMENT_OUT ويخفض المستحق", async () => {
    const cid = await mkConsignorWithBalance("10000");
    const r = await createVoucher({ voucherType: "PAYMENT", branchId: 1, amount: "6000", paymentMethod: "CASH", partyType: "SUPPLIER", partyId: cid, description: "تسوية" }, mgr);
    await approveVoucher(r.receiptId, mgr2); // مدير آخر
    expect(await balance(cid)).toBe("4000.00");
    const po = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(po).toHaveLength(1);
    expect(po[0].amount).toBe("6000.00");
  });

  it("المنشئ لا يعتمد سنده (SOD-04)", async () => {
    const cid = await mkConsignorWithBalance("10000");
    const r = await createVoucher({ voucherType: "PAYMENT", branchId: 1, amount: "3000", paymentMethod: "CASH", partyType: "SUPPLIER", partyId: cid, description: "تسوية" }, mgr);
    await expect(approveVoucher(r.receiptId, mgr)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
