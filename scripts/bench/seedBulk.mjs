// مولّد بيانات ضخم لقياس الأداء عند ١٠٠× — يملأ المسار الحرج للتقارير (عملاء/فواتير/بنود/قيود).
// الاستعمال:  node scripts/bench/seedBulk.mjs [--invoices=300000] [--customers=3000] [--batch=2000]
//
// ⛔ حارس أمان صارم: يرفض التنفيذ على أي قاعدة غير bench المعزولة (يحمي erp-mysql-prod/erp/erp_test).
// يقرأ DATABASE_URL من .env. لا يكتب stock/receipts (تكفي الفواتير+البنود+القيود لقياس استعلامات
// التقارير وsargability)؛ المبالغ نصوص decimal بسيطة (لا توازن مزدوج صارم — هدفه القياس لا المحاسبة).
import "dotenv/config";
import mysql from "mysql2/promise";

// ─────────── الوسائط ───────────
const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? Number(m.split("=")[1]) : d;
};
const N_INVOICES = arg("invoices", 300000);
const N_CUSTOMERS = arg("customers", 3000);
const BATCH = arg("batch", 2000);

// ─────────── حارس الأمان (يفشل مغلقاً) ───────────
const url = process.env.DATABASE_URL;
if (!url) { console.error("⛔ DATABASE_URL غير محدّد."); process.exit(1); }
const u = new URL(url);
const dbName = u.pathname.replace(/^\//, "");
const port = u.port || "3306";
if (process.env.NODE_ENV === "production") { console.error("⛔ NODE_ENV=production — مرفوض."); process.exit(1); }
if (port === "3306") { console.error(`⛔ المنفذ 3306 = حاوية الإنتاج (erp-mysql-prod) — مرفوض.`); process.exit(1); }
if (["erp", "erp_test"].includes(dbName)) { console.error(`⛔ القاعدة «${dbName}» مشتركة — مرفوض. استعمل قاعدة bench معزولة.`); process.exit(1); }
if (!/bench|proof/.test(dbName)) { console.error(`⛔ القاعدة «${dbName}» لا تبدو bench معزولة (يجب أن تحوي bench/proof) — مرفوض احترازاً.`); process.exit(1); }
console.log(`✓ حارس الأمان: القاعدة «${dbName}» على المنفذ ${port} (معزولة). أبدأ التوليد.`);

const conn = await mysql.createConnection({ uri: url, multipleStatements: false });

const pad = (n, w) => String(n).padStart(w, "0");
const fmtTs = (d) => d.toISOString().slice(0, 19).replace("T", " ");
const fmtDate = (d) => d.toISOString().slice(0, 10);
const money = (n) => n.toFixed(2);
const qtyStr = (n) => n.toFixed(3);

try {
  // ─────────── قراءة الأبعاد ───────────
  const [branches] = await conn.query("SELECT id FROM branches");
  const branchIds = branches.map((b) => b.id);
  if (!branchIds.length) throw new Error("لا فروع — شغّل pnpm seed أولاً.");

  const [tmplRows] = await conn.query(
    `SELECT pu.id AS unitId, pu.variantId, pu.conversionFactor, pv.costPrice,
            (SELECT pp.price FROM productPrices pp WHERE pp.productUnitId = pu.id AND pp.priceTier='RETAIL' LIMIT 1) AS price
     FROM productUnits pu JOIN productVariants pv ON pv.id = pu.variantId
     WHERE pu.isActive = 1`,
  );
  const templates = tmplRows
    .filter((t) => t.price != null)
    .map((t) => ({
      unitId: t.unitId, variantId: t.variantId,
      factor: Math.round(Number(t.conversionFactor)),
      cost: Number(t.costPrice), price: Number(t.price),
    }));
  if (!templates.length) throw new Error("لا قوالب بيع (productUnits+prices) — شغّل pnpm seed أولاً.");
  console.log(`الأبعاد: ${branchIds.length} فرع، ${templates.length} قالب بيع.`);

  // ─────────── عملاء ───────────
  const [cExisting] = await conn.query("SELECT id FROM customers LIMIT 1");
  let customerIds = [];
  if (!cExisting.length) {
    const crows = [];
    for (let i = 1; i <= N_CUSTOMERS; i++) crows.push([`عميل القياس ${i}`, `0770${pad(i, 7)}`]);
    for (let i = 0; i < crows.length; i += 5000) {
      await conn.query("INSERT INTO customers (name, phone) VALUES ?", [crows.slice(i, i + 5000)]);
    }
    console.log(`✓ أُدرج ${N_CUSTOMERS} عميل.`);
  }
  const [allC] = await conn.query("SELECT id FROM customers");
  customerIds = allC.map((c) => c.id);

  // ─────────── إعداد سريع ───────────
  await conn.query("SET unique_checks=0");
  await conn.query("SET foreign_key_checks=0");

  const START = Date.parse("2024-01-01T00:00:00Z");
  const END = Date.parse("2026-06-28T00:00:00Z");
  const SPAN = END - START;
  const STATUSES = ["PAID", "PAID", "PAID", "PARTIALLY_PAID", "PENDING", "CONFIRMED"]; // توزيع تقريبي
  const rnd = (n) => Math.floor(Math.random() * n);

  let seq = 0;
  let firstIdGlobal = null;
  const t0 = Date.now();

  for (let start = 0; start < N_INVOICES; start += BATCH) {
    const n = Math.min(BATCH, N_INVOICES - start);
    const invRows = [];
    const metas = [];
    for (let b = 0; b < n; b++) {
      seq++;
      const branchId = branchIds[rnd(branchIds.length)];
      const withCustomer = Math.random() < 0.7 && customerIds.length;
      const customerId = withCustomer ? customerIds[rnd(customerIds.length)] : null;
      const invDate = new Date(START + Math.random() * SPAN);
      const status = STATUSES[rnd(STATUSES.length)];
      const nItems = 1 + rnd(5);
      let subtotal = 0, cost = 0;
      const items = [];
      for (let k = 0; k < nItems; k++) {
        const t = templates[rnd(templates.length)];
        const q = 1 + rnd(10);
        const lineTotal = q * t.price;
        subtotal += lineTotal;
        cost += q * t.factor * (t.cost); // تكلفة بالوحدة الأساس تقريبية
        items.push({ variantId: t.variantId, unitId: t.unitId, q, base: q * t.factor, price: t.price, unitCost: t.cost, total: lineTotal });
      }
      const total = subtotal;
      const paid = status === "PAID" ? total : status === "PARTIALLY_PAID" ? Math.round(total * 0.4 * 100) / 100 : 0;
      const dueDate = new Date(invDate.getTime() + rnd(61) * 86400000);
      invRows.push([
        `BLK-${branchId}-${pad(seq, 9)}`, "POS", seq, branchId, customerId, "RETAIL",
        fmtTs(invDate), fmtDate(dueDate), money(subtotal), "0.00", "0.00", money(total),
        money(cost), status, money(paid), "0.00", "CASH", fmtTs(invDate),
      ]);
      metas.push({ invDate, branchId, customerId, subtotal, total, cost, items });
    }

    const [res] = await conn.query(
      `INSERT INTO invoices
        (invoiceNumber, sourceType, sourceId, branchId, customerId, priceTier,
         invoiceDate, dueDate, subtotal, taxAmount, discountAmount, total,
         costTotal, invoiceStatus, paidAmount, returnedTotal, paymentMethod, createdAt)
       VALUES ?`,
      [invRows],
    );
    const firstId = res.insertId;
    if (firstIdGlobal === null) firstIdGlobal = firstId;
    if (res.affectedRows !== n) throw new Error(`affectedRows ${res.affectedRows} != ${n}`);

    const itemRows = [];
    const entryRows = [];
    for (let b = 0; b < n; b++) {
      const invId = firstId + b;
      const m = metas[b];
      for (const it of m.items) {
        itemRows.push([invId, it.variantId, it.unitId, qtyStr(it.q), it.base, money(it.price), money(it.unitCost), money(it.total), fmtTs(m.invDate)]);
      }
      entryRows.push([
        "SALE", fmtDate(m.invDate), m.branchId, m.customerId, invId,
        money(m.total), money(m.subtotal), money(m.cost), money(m.subtotal - m.cost),
        `SALE:${invId}`, fmtTs(m.invDate),
      ]);
    }
    await conn.query(
      "INSERT INTO invoiceItems (invoiceId, variantId, productUnitId, quantity, baseQuantity, unitPrice, unitCost, total, createdAt) VALUES ?",
      [itemRows],
    );
    await conn.query(
      "INSERT INTO accountingEntries (entryType, entryDate, branchId, customerId, invoiceId, amount, revenue, cost, profit, dedupeKey, createdAt) VALUES ?",
      [entryRows],
    );

    if ((start / BATCH) % 10 === 0 || start + n >= N_INVOICES) {
      const done = start + n;
      const rate = Math.round(done / ((Date.now() - t0) / 1000));
      console.log(`  ${done}/${N_INVOICES} فاتورة (${rate}/ث)`);
    }
  }

  await conn.query("SET foreign_key_checks=1");
  await conn.query("SET unique_checks=1");

  const [[cnt]] = await conn.query(
    "SELECT (SELECT COUNT(*) FROM invoices) inv, (SELECT COUNT(*) FROM invoiceItems) items, (SELECT COUNT(*) FROM accountingEntries) entries, (SELECT COUNT(*) FROM customers) custs",
  );
  console.log(`✓ تمّ. invoices=${cnt.inv} items=${cnt.items} entries=${cnt.entries} customers=${cnt.custs}. (الأزمنة ${((Date.now() - t0) / 1000).toFixed(1)}ث)`);
  await conn.end();
} catch (e) {
  await conn.end().catch(() => {});
  console.error("✗ فشل التوليد:", e?.sqlMessage ?? e?.message ?? e);
  process.exit(1);
}
