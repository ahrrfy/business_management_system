/**
 * backfill-wo-base-snapshot.ts
 *
 * يملأ الحقول الثلاثة للأوامر التاريخية التي أُنشئت قبل هجرة 0363:
 *   baseProductUnitId    — معرف أفضل وحدة متاحة للصنف الأساس
 *   baseBaseQuantity     — الكمية × معامل تحويل الوحدة (لوحدة الأساس دائماً 1)
 *   baseConsumesInventory — NOT products.isService
 *
 * الاستخدام:
 *   pnpm tsx scripts/backfill-wo-base-snapshot.ts            ← dry-run (قراءة فقط)
 *   pnpm tsx scripts/backfill-wo-base-snapshot.ts --execute  ← كتابة فعلية
 *
 * الأمان:
 *   • يستهدف فقط: baseVariantId IS NOT NULL AND baseProductUnitId IS NULL
 *   • idempotent: يُشغَّل مرات عدة بأمان (WHERE baseProductUnitId IS NULL يمنع المضاعفة)
 *   • يتخطى الأصناف المحذوفة أو التي لا وحدات لها مع إبلاغٍ واضح
 */

import dotenv from "dotenv";
dotenv.config();

import mysql from "mysql2/promise";

const DRY_RUN = !process.argv.includes("--execute");
const BATCH_SIZE = 200;

// ─── اختيار أفضل وحدة للصنف ───────────────────────────────────────────────
// يطابق منطق resolveEffectiveBase في baseUnitGuard.ts وcreate.ts:
// 1) وحدة نشطة بعَلَم isBaseUnit  → 2) وحدة نشطة factor=1  → 3) وحدة isBaseUnit غير نشطة  → 4) أي وحدة
const BEST_UNIT_SQL = `
  SELECT
    pu.id,
    pu.conversionFactor,
    pu.isBaseUnit,
    pu.isActive
  FROM productUnits pu
  WHERE pu.variantId = ?
  ORDER BY
    CASE
      WHEN pu.isBaseUnit = 1 AND pu.isActive = 1             THEN 0
      WHEN pu.isActive = 1 AND pu.conversionFactor = 1.0000  THEN 1
      WHEN pu.isBaseUnit = 1                                  THEN 2
      ELSE                                                         3
    END ASC,
    pu.id ASC
  LIMIT 1
`;

// ─── جلب جميع الأوامر المستهدفة ───────────────────────────────────────────
const TARGETS_SQL = `
  SELECT
    wo.id,
    wo.orderNumber,
    wo.baseVariantId,
    wo.quantity,
    p.isService
  FROM workOrders wo
  INNER JOIN productVariants pv ON pv.id = wo.baseVariantId
  INNER JOIN products p ON p.id = pv.productId
  WHERE wo.baseVariantId IS NOT NULL
    AND wo.baseProductUnitId IS NULL
  ORDER BY wo.id ASC
`;

// ─── جلب الأوامر التي صنفها محذوف (لإعداد التقرير) ──────────────────────
const ORPHAN_SQL = `
  SELECT wo.id, wo.orderNumber, wo.baseVariantId
  FROM workOrders wo
  LEFT JOIN productVariants pv ON pv.id = wo.baseVariantId
  WHERE wo.baseVariantId IS NOT NULL
    AND wo.baseProductUnitId IS NULL
    AND pv.id IS NULL
`;

// ─── استعلام التحديث (raw SQL يتجاوز أي تعارض في schema drizzle) ──────────
const UPDATE_SQL = `
  UPDATE workOrders
  SET
    baseProductUnitId    = ?,
    baseBaseQuantity     = ?,
    baseConsumesInventory = ?
  WHERE id = ?
    AND baseProductUnitId IS NULL
`;

// ──────────────────────────────────────────────────────────────────────────────
async function run() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL غير مُعيَّن في .env");

  console.log(`\n🔍 backfill-wo-base-snapshot [${DRY_RUN ? "DRY-RUN — قراءة فقط" : "EXECUTE — كتابة فعلية"}]`);
  console.log(`   DATABASE_URL: ${url.replace(/:[^@]+@/, ":***@")}\n`);

  const conn = await mysql.createConnection(url);

  try {
    // ── تقرير الأصناف المحذوفة ─────────────────────────────────────────────
    const [orphans] = await conn.execute<mysql.RowDataPacket[]>(ORPHAN_SQL);
    if (orphans.length > 0) {
      console.log(`⚠️  ${orphans.length} أمر(أوامر) بصنف محذوف — تُتخطى ولا تُعدَّل:`);
      for (const o of orphans) {
        console.log(`   WO-${o.id} (${o.orderNumber}): baseVariantId=${o.baseVariantId} [محذوف]`);
      }
      console.log("");
    }

    // ── جلب الأهداف ───────────────────────────────────────────────────────
    const [targets] = await conn.execute<mysql.RowDataPacket[]>(TARGETS_SQL);

    if (targets.length === 0) {
      console.log("✅ لا توجد أوامر تاريخية تحتاج backfill — الجدول نظيف.\n");
      return;
    }

    console.log(`📋 أوامر مستهدفة: ${targets.length}\n`);

    // ── تحليل كل أمر ─────────────────────────────────────────────────────
    type Update = {
      workOrderId: number;
      orderNumber: string;
      baseProductUnitId: number;
      baseBaseQuantity: number;
      baseConsumesInventory: 0 | 1;
      note: string;
    };

    const updates: Update[] = [];
    const noUnit: Array<{ id: number; orderNumber: string; baseVariantId: number }> = [];

    for (const row of targets) {
      const vid = Number(row.baseVariantId);
      const [unitRows] = await conn.execute<mysql.RowDataPacket[]>(BEST_UNIT_SQL, [vid]);
      const unit = unitRows[0];

      if (!unit) {
        noUnit.push({ id: Number(row.id), orderNumber: row.orderNumber, baseVariantId: vid });
        continue;
      }

      const convFactor = Number(unit.conversionFactor);
      const rawQty = Number(row.quantity);
      // baseBaseQuantity = workOrder.quantity × conversionFactor
      // للوحدة الأساسية conversionFactor=1 دائماً، فالناتج = quantity
      const baseBaseQuantity = Math.round(rawQty * convFactor);

      if (!Number.isInteger(baseBaseQuantity) || baseBaseQuantity <= 0) {
        noUnit.push({ id: Number(row.id), orderNumber: row.orderNumber, baseVariantId: vid });
        continue;
      }

      const baseConsumesInventory: 0 | 1 = row.isService ? 0 : 1;

      updates.push({
        workOrderId: Number(row.id),
        orderNumber: row.orderNumber,
        baseProductUnitId: Number(unit.id),
        baseBaseQuantity,
        baseConsumesInventory,
        note: `unit=${unit.id} isBaseUnit=${unit.isBaseUnit} isActive=${unit.isActive} factor=${convFactor} qty=${rawQty}→${baseBaseQuantity} consumes=${!!baseConsumesInventory}`,
      });
    }

    // ── أوامر بلا وحدة ────────────────────────────────────────────────────
    if (noUnit.length > 0) {
      console.log(`⚠️  ${noUnit.length} أمر(أوامر) لا وحدة لصنفها — تُتخطى وتحتاج تدخلاً يدوياً:`);
      for (const n of noUnit) {
        console.log(`   WO-${n.id} (${n.orderNumber}): variantId=${n.baseVariantId} [لا وحدات]`);
      }
      console.log("");
    }

    console.log(`📊 جاهز للتحديث: ${updates.length} أمر\n`);

    if (updates.length === 0) {
      console.log("✅ لا توجد تحديثات ممكنة.\n");
      return;
    }

    // ── عرض عينة ─────────────────────────────────────────────────────────
    console.log("📝 عينة (أول 15):");
    for (const u of updates.slice(0, 15)) {
      console.log(`   WO-${u.workOrderId} (${u.orderNumber}): ${u.note}`);
    }
    if (updates.length > 15) console.log(`   ... و${updates.length - 15} آخرين`);
    console.log("");

    if (DRY_RUN) {
      console.log("🛑 DRY-RUN: لم يُكتب شيء. أعد التشغيل مع --execute للتطبيق.\n");
      return;
    }

    // ── كتابة فعلية في دفعات ──────────────────────────────────────────────
    let totalUpdated = 0;
    const batches = Math.ceil(updates.length / BATCH_SIZE);

    for (let b = 0; b < batches; b++) {
      const batch = updates.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);

      await conn.beginTransaction();
      try {
        for (const u of batch) {
          await conn.execute(UPDATE_SQL, [
            u.baseProductUnitId,
            u.baseBaseQuantity,
            u.baseConsumesInventory,
            u.workOrderId,
          ]);
        }
        await conn.commit();
        totalUpdated += batch.length;
        console.log(`  ✅ دفعة ${b + 1}/${batches}: ${batch.length} أمر (الإجمالي: ${totalUpdated})`);
      } catch (err) {
        await conn.rollback();
        console.error(`  ❌ فشلت دفعة ${b + 1}/${batches}:`, err);
        throw err;
      }
    }

    console.log(`\n🎉 اكتمل: ${totalUpdated} أمر شغل مُحدَّث. يمكن الآن تسليمها بلا أخطاء.\n`);

    // ── تحقق ختامي ────────────────────────────────────────────────────────
    const [remaining] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM workOrders WHERE baseVariantId IS NOT NULL AND baseProductUnitId IS NULL`,
    );
    const remainingCount = (remaining[0] as any)?.cnt ?? 0;
    if (remainingCount > 0) {
      console.warn(`⚠️  لا تزال هناك ${remainingCount} أوامر بلا لقطة (صنف محذوف أو بلا وحدات). راجعها يدوياً.\n`);
    } else {
      console.log("✅ تحقق ختامي: صفر أوامر متبقية بلا لقطة.\n");
    }
  } finally {
    await conn.end();
  }
}

run().catch((err) => {
  console.error("\n❌ فشل الـbackfill:", err);
  process.exit(1);
});
