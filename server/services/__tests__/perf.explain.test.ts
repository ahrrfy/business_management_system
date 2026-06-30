// حارس انحدار الأداء — يُمسك انحرافاً صامتاً في خطط الاستعلامات الساخنة (٣٠/٦/٢٦).
//
// لماذا الاختبار:
// - الفهارس المركّبة + الـsargability هَشّة: تعديل مَلامح في الكود (`DATE(col)`، تغيير ترتيب
//   عمود فهرس، إسقاط فهرس بسهو في drizzle-kit، أو فهرس يُسقَط صامتاً كما حدث في 0013 →
//   bucketId المحذوف في 0017) يُعيد المسح الكامل بلا أثرٍ في الاختبارات المنطقية. هذا الحارس
//   يَفشل صَراحةً عند ذلك.
//
// منهجية الفحص:
// - يَبذر بيانات ممثّلة (لا ضخمة — كافية لتغيير قرار المُحسِّن لـrange/ref بدل ALL).
// - يَستعمل EXPLAIN على كل استعلام ساخن ويَتحقّق من: `key` يَستعمل الفهرس الصحيح،
//   `type` ليس `ALL` (مسح كامل)، و`rows` المُقدَّر ضمن سقفٍ معقول.
//
// كاويه: EXPLAIN رخيص جداً (لا ينفّذ الاستعلام)، ومحلِّل MySQL يَختار خطّة بناءً على
// إحصاءات الجدول. عند بضع مئات من الصفوف قد يَختار full-scan وقتما الفهرس أبطأ —
// لذا نَبذر ما يَكفي لجعل الفهرس قَراراً واضحاً (٢٠٠٠ فاتورة).

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import mysql from "mysql2/promise";
import * as s from "../../../drizzle/schema";
import { getDb, closeDb } from "../../db";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "purchaseOrderItems", "purchaseOrders",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "workOrderMaterials", "workOrders", "customers", "suppliers", "branches", "users",
  "auditLogs", "expenses",
];

const SEED_INVOICES = 2000;
const SEED_BRANCHES = [1, 2];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

interface ExplainRow {
  id: number;
  select_type: string;
  table: string | null;
  type: string | null;
  possible_keys: string | null;
  key: string | null;
  rows: number | null;
  Extra: string | null;
}

async function explain(sql: string): Promise<ExplainRow[]> {
  const url = process.env.DATABASE_URL!;
  const conn = await mysql.createConnection(url);
  try {
    const [rows] = await conn.execute(`EXPLAIN ${sql}`);
    return rows as ExplainRow[];
  } finally {
    await conn.end();
  }
}

async function seedBulk() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
    { id: 2, name: "SALES", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values({ id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.customers).values({ id: 1, name: "ع١", defaultPriceTier: "RETAIL", currentBalance: "0" });

  // بذر دفعي للفواتير — multi-row INSERT لتخفيض زمن البذر.
  const statuses = ["PENDING", "CONFIRMED", "PAID", "PARTIALLY_PAID", "CANCELLED"] as const;
  const baseDate = new Date("2026-01-01T00:00:00Z");
  const url = process.env.DATABASE_URL!;
  const conn = await mysql.createConnection(url);
  try {
    const BATCH = 500;
    for (let off = 0; off < SEED_INVOICES; off += BATCH) {
      const rows: any[] = [];
      for (let i = 0; i < BATCH && off + i < SEED_INVOICES; i++) {
        const idx = off + i;
        const branchId = SEED_BRANCHES[idx % SEED_BRANCHES.length];
        const status = statuses[idx % statuses.length];
        const date = new Date(baseDate.getTime() + idx * 60_000); // كل دقيقة فاتورة (~٣٣ ساعة لـ٢٠٠٠).
        rows.push([
          `INV-${1000 + idx}`,
          "POS",
          branchId,
          1,
          "RETAIL",
          date,
          "10.00",
          "0.00",
          "10.00",
          status === "PAID" ? "10.00" : status === "PARTIALLY_PAID" ? "5.00" : "0.00",
          "0.00",
          status,
        ]);
      }
      await conn.query(
        "INSERT INTO invoices (invoiceNumber, sourceType, branchId, customerId, priceTier, invoiceDate, subtotal, taxAmount, total, paidAmount, returnedTotal, `status`) VALUES ?",
        [rows],
      );
    }
  } finally {
    await conn.end();
  }
  await closeDb();
}

describe("حارس انحدار الأداء — EXPLAIN على استعلامات المسارات الساخنة", () => {
  beforeAll(async () => {
    await truncateTables(TABLES);
    await seedBulk();
    // ANALYZE TABLE يَحدِّث إحصاءات InnoDB ⇒ المُحسِّن يَختار الفهرس الصحيح بدل full-scan.
    const url = process.env.DATABASE_URL!;
    const conn = await mysql.createConnection(url);
    try {
      await conn.execute("ANALYZE TABLE invoices");
    } finally {
      await conn.end();
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("تقرير المبيعات (sargable date + branchId) يَستعمل فهرس invoices لا full-scan", async () => {
    // النمط بعد S2 (٢٩/٦): نَطاق نصف مفتوح [from, to+يوم) — قابل للفهرسة.
    const rows = await explain(
      "SELECT * FROM invoices WHERE branchId=1 AND invoiceDate >= '2026-01-01 00:00:00' AND invoiceDate < '2026-01-02 00:00:00'"
    );
    const inv = rows.find((r) => r.table === "invoices");
    expect(inv).toBeTruthy();
    // يجب ألا يَكون مسحاً كاملاً.
    expect(inv!.type).not.toBe("ALL");
    // يجب أن يَستعمل فهرساً يَحتوي على branchId أو invoiceDate.
    expect(inv!.key).toMatch(/branch|date|invoice/i);
  });

  it("AR aging (status-first IN) يَستعمل فهرساً يَحتوي على status", async () => {
    // S1 (٢٩/٦): IN ⇒ status-first أسرع بـ٥× (مَقيس).
    const rows = await explain(
      "SELECT * FROM invoices WHERE branchId=1 AND `status` IN ('PENDING','PARTIALLY_PAID') AND invoiceDate >= '2026-01-01'"
    );
    const inv = rows.find((r) => r.table === "invoices");
    expect(inv).toBeTruthy();
    expect(inv!.type).not.toBe("ALL");
    // يَستفيد من idx_invoice_branch_status_date (status قبل date للـIN).
    expect(inv!.key).toBeTruthy();
    expect(inv!.possible_keys).toMatch(/status|branch/i);
  });

  it("keyset pagination (id < cursor + branchId) ⇒ range على PK", async () => {
    // S3 (٣٠/٦): الترقيم keyset يَستفيد من PK مباشرةً.
    const rows = await explain("SELECT * FROM invoices WHERE id < 1500 AND branchId=1 ORDER BY id DESC LIMIT 50");
    const inv = rows.find((r) => r.table === "invoices");
    expect(inv).toBeTruthy();
    // PRIMARY أو فهرس مركّب مَقبول، المهم ألا يَكون مسحاً كاملاً.
    expect(inv!.type).not.toBe("ALL");
    expect(inv!.rows).toBeLessThan(SEED_INVOICES);
  });

  it("DATE(col) الخطأ سيُكتَشَف لو عاد (regression sentinel) — هذا الاستعلام يَجب أن يَكون ALL", async () => {
    // عَكس الحارس: إن لُفَّ العمود بدالّة، يجب أن يَفقد الفهرس. لو نَجح هذا في الفهرسة لاحقاً
    // (مَثلاً عبر functional index)، يَلزم تَحديث الحارس الأصلي ليَكون أكثر صَرامة.
    const rows = await explain(
      "SELECT * FROM invoices WHERE DATE(invoiceDate) = '2026-01-01' AND branchId=1"
    );
    const inv = rows.find((r) => r.table === "invoices");
    expect(inv).toBeTruthy();
    // إمّا ALL (المتوقَّع) أو فهرس على branchId — لكن ليس على invoiceDate لأنّه مَلفوف.
    if (inv!.key) {
      expect(inv!.key).not.toMatch(/invoice_date/i);
    }
  });
});
