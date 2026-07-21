import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createProduct } from "../catalogService";
import { createSupplier } from "../supplierService";
import { createConsignmentNote, getConsignmentNote, listConsignorProducts } from "../consignment/noteService";

/**
 * بضاعة الأمانة — ش٢: اختبارات سندات الإيداع/السحب/الاستبدال (صفر أثر ماليّ + ختم openedAt + الحراس).
 */
const actor = { userId: 1, branchId: 1 };
const TABLES = [
  "accountingEntries", "receipts", "inventoryMovements",
  "consignmentNoteLines", "consignmentNotes",
  "branchStock", "productPrices", "productUnitBarcodes", "productUnits", "productVariants", "productImages", "products",
  "auditLogs", "suppliers", "categories", "users", "branches",
];
function db() { const d = getDb(); if (!d) throw new Error("no DB"); return d; }

async function seedBase() {
  await db().insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
}
async function mkConsignor(name = "أ. حيدر") {
  const { supplierId } = await createSupplier({ name, supplierKind: "CONSIGNOR" }, actor);
  return supplierId;
}
/** ينشئ صنف أمانة ويعيد {variantId, productUnitId}. */
async function mkConsignProduct(consignorId: number, share = "4000") {
  const sku = `MLZ-${Math.random().toString(36).slice(2, 7)}`;
  await createProduct({
    name: "ملزمة", isConsignment: true, consignorId,
    variants: [{ sku, costPrice: share, units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL" as const, price: "5000" }] }] }],
  }, actor);
  const v = (await db().select().from(s.productVariants).where(eq(s.productVariants.sku, sku)))[0];
  const u = (await db().select().from(s.productUnits).where(eq(s.productUnits.variantId, Number(v.id))))[0];
  return { variantId: Number(v.id), productUnitId: Number(u.id) };
}
async function stockOf(variantId: number, branchId = 1) {
  const r = (await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, branchId))))[0];
  return { qty: r?.quantity ?? 0, openedAt: r?.openedAt ?? null };
}

beforeEach(async () => { await truncateTables(TABLES); await seedBase(); });

describe("بضاعة الأمانة ش٢ — الإيداع", () => {
  it("سند إيداع: حركة IN + رصيد يرتفع + ختم openedAt + صفر قيد ماليّ", async () => {
    const cid = await mkConsignor();
    const { variantId, productUnitId } = await mkConsignProduct(cid);
    const r = await createConsignmentNote({
      noteType: "DEPOSIT", consignorId: cid, branchId: 1,
      lines: [{ lineDirection: "IN", variantId, productUnitId, quantity: "100" }],
    }, actor);
    expect(r.noteNumber).toMatch(/^CSN-1-\d{8}-00001$/);
    const st = await stockOf(variantId);
    expect(st.qty).toBe(100);
    expect(st.openedAt).not.toBeNull(); // مُفتتَح ⇒ لا بيع بالسالب
    const mv = await db().select().from(s.inventoryMovements);
    expect(mv).toHaveLength(1);
    expect(mv[0].movementType).toBe("IN");
    expect(mv[0].referenceType).toBe("CONSIGN_IN");
    // صفر أثر ماليّ.
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    // رصيد المودِع لم يتحرّك (لا دين عند الاستلام).
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, cid)))[0];
    expect(sup.currentBalance).toBe("0.00");
  });

  it("idempotency: نفس clientRequestId ⇒ سند واحد", async () => {
    const cid = await mkConsignor();
    const { variantId, productUnitId } = await mkConsignProduct(cid);
    const input = { noteType: "DEPOSIT" as const, consignorId: cid, branchId: 1, clientRequestId: "req-1",
      lines: [{ lineDirection: "IN" as const, variantId, productUnitId, quantity: "10" }] };
    const r1 = await createConsignmentNote(input, actor);
    const r2 = await createConsignmentNote(input, actor);
    expect(r2.idempotentReplay).toBe(true);
    expect(await db().select().from(s.consignmentNotes)).toHaveLength(1);
    expect((await stockOf(variantId)).qty).toBe(10);
  });

  it("صنف لا يخصّ المودِع يُرفض", async () => {
    const c1 = await mkConsignor("مودِع ١");
    const c2 = await mkConsignor("مودِع ٢");
    const p2 = await mkConsignProduct(c2);
    await expect(createConsignmentNote({
      noteType: "DEPOSIT", consignorId: c1, branchId: 1,
      lines: [{ lineDirection: "IN", variantId: p2.variantId, productUnitId: p2.productUnitId, quantity: "5" }],
    }, actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("بضاعة الأمانة ش٢ — السحب", () => {
  it("سند سحب: حركة OUT + رصيد ينخفض (يلزمه مرفق)", async () => {
    const cid = await mkConsignor();
    const { variantId, productUnitId } = await mkConsignProduct(cid);
    await createConsignmentNote({ noteType: "DEPOSIT", consignorId: cid, branchId: 1, lines: [{ lineDirection: "IN", variantId, productUnitId, quantity: "50" }] }, actor);
    const r = await createConsignmentNote({
      noteType: "WITHDRAW", consignorId: cid, branchId: 1, attachmentUrl: "data:image/png;base64,AAAA",
      lines: [{ lineDirection: "OUT", variantId, productUnitId, quantity: "20" }],
    }, actor);
    expect(r.noteNumber).toMatch(/^CSN-1-/);
    expect((await stockOf(variantId)).qty).toBe(30);
    const outMv = (await db().select().from(s.inventoryMovements).where(eq(s.inventoryMovements.movementType, "OUT")))[0];
    expect(outMv.referenceType).toBe("CONSIGN_OUT");
  });

  it("سحب بلا مرفق يُرفض", async () => {
    const cid = await mkConsignor();
    const { variantId, productUnitId } = await mkConsignProduct(cid);
    await createConsignmentNote({ noteType: "DEPOSIT", consignorId: cid, branchId: 1, lines: [{ lineDirection: "IN", variantId, productUnitId, quantity: "50" }] }, actor);
    await expect(createConsignmentNote({
      noteType: "WITHDRAW", consignorId: cid, branchId: 1,
      lines: [{ lineDirection: "OUT", variantId, productUnitId, quantity: "20" }],
    }, actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("سحب أكثر من المتبقي يُرفض (كفاية تحت القفل)", async () => {
    const cid = await mkConsignor();
    const { variantId, productUnitId } = await mkConsignProduct(cid);
    await createConsignmentNote({ noteType: "DEPOSIT", consignorId: cid, branchId: 1, lines: [{ lineDirection: "IN", variantId, productUnitId, quantity: "10" }] }, actor);
    await expect(createConsignmentNote({
      noteType: "WITHDRAW", consignorId: cid, branchId: 1, attachmentUrl: "data:image/png;base64,AAAA",
      lines: [{ lineDirection: "OUT", variantId, productUnitId, quantity: "20" }],
    }, actor)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("بضاعة الأمانة ش٢ — الاستبدال والقوائم", () => {
  it("سند استبدال: سحب صنف + إيداع آخر بمعاملة واحدة (صفر أثر ماليّ)", async () => {
    const cid = await mkConsignor();
    const a = await mkConsignProduct(cid, "4000");
    const b = await mkConsignProduct(cid, "4500");
    await createConsignmentNote({ noteType: "DEPOSIT", consignorId: cid, branchId: 1, lines: [{ lineDirection: "IN", variantId: a.variantId, productUnitId: a.productUnitId, quantity: "20" }] }, actor);
    await createConsignmentNote({
      noteType: "EXCHANGE", consignorId: cid, branchId: 1, attachmentUrl: "data:image/png;base64,AAAA",
      lines: [
        { lineDirection: "OUT", variantId: a.variantId, productUnitId: a.productUnitId, quantity: "20" },
        { lineDirection: "IN", variantId: b.variantId, productUnitId: b.productUnitId, quantity: "50" },
      ],
    }, actor);
    expect((await stockOf(a.variantId)).qty).toBe(0);
    expect((await stockOf(b.variantId)).qty).toBe(50);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  });

  it("استبدال بلا اتجاهين يُرفض", async () => {
    const cid = await mkConsignor();
    const a = await mkConsignProduct(cid);
    await createConsignmentNote({ noteType: "DEPOSIT", consignorId: cid, branchId: 1, lines: [{ lineDirection: "IN", variantId: a.variantId, productUnitId: a.productUnitId, quantity: "20" }] }, actor);
    await expect(createConsignmentNote({
      noteType: "EXCHANGE", consignorId: cid, branchId: 1, attachmentUrl: "x",
      lines: [{ lineDirection: "OUT", variantId: a.variantId, productUnitId: a.productUnitId, quantity: "5" }],
    }, actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("listConsignorProducts + getConsignmentNote يعملان", async () => {
    const cid = await mkConsignor();
    const { variantId, productUnitId } = await mkConsignProduct(cid);
    const prods = await listConsignorProducts(cid, 1);
    expect(prods.some((p) => p.variantId === variantId)).toBe(true);
    const r = await createConsignmentNote({ noteType: "DEPOSIT", consignorId: cid, branchId: 1, lines: [{ lineDirection: "IN", variantId, productUnitId, quantity: "7" }] }, actor);
    const note = await getConsignmentNote(r.noteId);
    expect(note?.noteType).toBe("DEPOSIT");
    expect(note?.lines).toHaveLength(1);
    expect(note?.lines[0].baseQuantity).toBe(7);
  });
});
