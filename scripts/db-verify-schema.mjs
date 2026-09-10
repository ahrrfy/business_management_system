// تحقّق المخطط بعد الهجرة: يقارن أحدث snapshot لـDrizzle (المخطط المتوقّع بعد كل
// الهجرات) بأعمدة القاعدة الفعلية، ويفشل بصوتٍ عالٍ عند أي انحراف (جدول/عمود ناقص).
//
// لماذا: «تطبيق الهجرات» قد ينجح شكلياً بينما القاعدة منحرفة فعلياً (مثال ١٢/٦: baseline
// سُجّل «مُطبَّقاً» على قاعدة كانت أقدم منه ⇒ عمود branchStock.lastCountedAt ناقص ظهر
// للمستخدم كـ«تعذّر إتمام البيع» بلا أثر). هذه الخطوة تكشف ذلك قبل أن يكسر ميزة إنتاجية.
//
// الاستخدام:  pnpm db:verify   (تُستدعى آلياً ضمن pnpm prod:deploy بعد الهجرة)
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const META_DIR = "./drizzle/migrations/meta";
const REQUIRED_EXPENSE_STATUSES = [
  "PENDING_APPROVAL",
  "ACTIVE",
  "REJECTED",
  "CANCELLED",
];
const BLOCKING_REFERENTIAL_RULES = new Set(["RESTRICT", "NO ACTION"]);

/**
 * عقد حي مستقل عن Drizzle snapshot للهجرتين 0181/0182.
 *
 * الـsnapshot الحالي أقدم من هاتين الهجرتين، لذلك لا يجوز استنتاج سلامتهما من
 * فحص snapshot العام. هذه الدالة تستقبل metadata المقروءة من information_schema
 * وتتحقق من البنية والدلالة المرجعية، لا من مجرد وجود اسم العمود.
 */
function collectOperationalSchemaContractErrors({
  databaseName,
  fulfillmentColumns,
  fulfillmentIndexes,
  fulfillmentForeignKeys,
  expenseStatusColumns,
}) {
  const errors = [];
  const fulfillment = fulfillmentColumns.find(
    (row) =>
      row.tableName === "storeSettings" &&
      row.columnName === "fulfillmentBranchId",
  );
  const branchId = fulfillmentColumns.find(
    (row) => row.tableName === "branches" && row.columnName === "id",
  );

  if (!fulfillment) {
    errors.push(
      "storeSettings.fulfillmentBranchId مفقود (الهجرة 0181 لم تُطبَّق).",
    );
  } else {
    if (String(fulfillment.dataType).toLowerCase() !== "bigint") {
      errors.push(
        `storeSettings.fulfillmentBranchId نوعه ${fulfillment.columnType || fulfillment.dataType || "(مجهول)"} وليس BIGINT.`,
      );
    }
    if (String(fulfillment.isNullable).toUpperCase() !== "YES") {
      errors.push(
        "storeSettings.fulfillmentBranchId يجب أن يقبل NULL لمرحلة bootstrap، بينما فتح المتجر يُحرس تطبيقياً.",
      );
    }
    if (fulfillment.columnDefault != null) {
      errors.push(
        "storeSettings.fulfillmentBranchId يجب ألا يملك فرعاً افتراضياً صامتاً.",
      );
    }
  }

  if (!branchId) {
    errors.push("branches.id مفقود؛ تعذّر إثبات توافق نوع مرجع فرع التنفيذ.");
  } else if (
    fulfillment &&
    String(fulfillment.columnType).toLowerCase() !==
      String(branchId.columnType).toLowerCase()
  ) {
    errors.push(
      `نوع storeSettings.fulfillmentBranchId (${fulfillment.columnType}) لا يطابق branches.id (${branchId.columnType}).`,
    );
  }

  const indexRows = fulfillmentIndexes
    .filter((row) => row.indexName === "idx_store_settings_fulfillment_branch")
    .sort((a, b) => Number(a.seqInIndex) - Number(b.seqInIndex));
  if (!indexRows.length) {
    errors.push(
      "الفهرس storeSettings.idx_store_settings_fulfillment_branch مفقود (الهجرة 0181 ناقصة).",
    );
  } else if (
    indexRows.length !== 1 ||
    indexRows[0].columnName !== "fulfillmentBranchId" ||
    Number(indexRows[0].seqInIndex) !== 1 ||
    Number(indexRows[0].nonUnique) !== 1 ||
    String(indexRows[0].isVisible).toUpperCase() !== "YES"
  ) {
    errors.push(
      "idx_store_settings_fulfillment_branch يجب أن يكون فهرساً عادياً مرئياً وأحادي العمود على fulfillmentBranchId.",
    );
  }

  const fulfillmentFks = fulfillmentForeignKeys.filter(
    (row) => row.columnName === "fulfillmentBranchId",
  );
  const isBlockingRule = (rule) =>
    BLOCKING_REFERENTIAL_RULES.has(String(rule).toUpperCase());
  const isFulfillmentTarget = (row) =>
    row.referencedTableName === "branches" && row.referencedColumnName === "id";
  const validFulfillmentFks = fulfillmentFks.filter(
    (row) =>
      isFulfillmentTarget(row) &&
      row.referencedTableSchema === databaseName &&
      isBlockingRule(row.deleteRule) &&
      isBlockingRule(row.updateRule),
  );
  if (!validFulfillmentFks.length) {
    errors.push(
      "FK محلي صحيح مفقود: storeSettings.fulfillmentBranchId يجب أن يشير إلى branches.id في القاعدة نفسها بقواعد حظر.",
    );
  }
  const wrongTargetFks = fulfillmentFks.filter(
    (row) => !isFulfillmentTarget(row),
  );
  if (wrongTargetFks.length) {
    errors.push(
      "يوجد FK إضافي مخالف على storeSettings.fulfillmentBranchId لا يشير إلى branches.id.",
    );
  }
  const crossSchemaFks = fulfillmentFks.filter(
    (row) =>
      isFulfillmentTarget(row) && row.referencedTableSchema !== databaseName,
  );
  if (crossSchemaFks.length) {
    errors.push(
      `FK فرع التنفيذ يجب أن يشير إلى branches.id داخل القاعدة نفسها (${databaseName})؛ يوجد مرجع عابر لقاعدة أخرى.`,
    );
  }
  const unsafeDeleteFks = fulfillmentFks.filter(
    (row) =>
      isFulfillmentTarget(row) &&
      row.referencedTableSchema === databaseName &&
      !isBlockingRule(row.deleteRule),
  );
  if (unsafeDeleteFks.length) {
    errors.push(
      `FK فرع التنفيذ يجب أن يمنع حذف الفرع (ON DELETE RESTRICT/NO ACTION)، والحالي ${unsafeDeleteFks.map((row) => row.deleteRule || "(مفقود)").join(", ")}.`,
    );
  }
  const unsafeUpdateFks = fulfillmentFks.filter(
    (row) =>
      isFulfillmentTarget(row) &&
      row.referencedTableSchema === databaseName &&
      !isBlockingRule(row.updateRule),
  );
  if (unsafeUpdateFks.length) {
    errors.push(
      `FK فرع التنفيذ يجب أن يمنع تغيير المفتاح (ON UPDATE RESTRICT/NO ACTION)، والحالي ${unsafeUpdateFks.map((row) => row.updateRule || "(مفقود)").join(", ")}.`,
    );
  }

  const expenseStatus = expenseStatusColumns.find(
    (row) => row.tableName === "expenses" && row.columnName === "expenseStatus",
  );
  if (!expenseStatus) {
    errors.push("expenses.expenseStatus مفقود (الهجرة 0182 لم تُطبَّق).");
  } else {
    const columnType = String(expenseStatus.columnType);
    if (String(expenseStatus.dataType).toLowerCase() !== "enum") {
      errors.push(
        `expenses.expenseStatus يجب أن يكون ENUM، والحالي ${columnType || "(مجهول)"}.`,
      );
    }
    const actualStatuses = [...columnType.matchAll(/'((?:''|[^'])*)'/g)].map(
      (match) => match[1].replaceAll("''", "'"),
    );
    if (
      actualStatuses.length !== REQUIRED_EXPENSE_STATUSES.length ||
      actualStatuses.some(
        (status, index) => status !== REQUIRED_EXPENSE_STATUSES[index],
      )
    ) {
      errors.push(
        `expenses.expenseStatus يجب أن يطابق الحالات بالترتيب حصراً: ${REQUIRED_EXPENSE_STATUSES.join(", ")}؛ والحالي: ${actualStatuses.join(", ") || "(فارغ)"}.`,
      );
    }
    if (String(expenseStatus.isNullable).toUpperCase() !== "NO") {
      errors.push("expenses.expenseStatus يجب أن يكون NOT NULL.");
    }
    if (String(expenseStatus.columnDefault) !== "ACTIVE") {
      errors.push(
        `expenses.expenseStatus يجب أن يكون افتراضه ACTIVE للسجلات القديمة، والحالي ${expenseStatus.columnDefault ?? "NULL"}.`,
      );
    }
  }

  return errors;
}

function collectExchangeUsdMigrationAuditErrors({
  invalidRows = [],
  invalidGroups = [],
}) {
  const errors = [];
  for (const row of invalidRows) {
    errors.push(
      `USD_CUSTODY_SOURCE_INVALID txn=${row.txnNumber ?? row.id} ` +
        `house=${row.exchangeHouseId} branch=${row.branchId ?? "NULL"} ` +
        `type=${row.type} usd=${row.usdAmount} carrying=${row.iqdAmount} ` +
        `savedRate=${row.exchangeRate}`,
    );
  }
  for (const row of invalidGroups) {
    errors.push(
      `USD_CUSTODY_GROUP_INVALID house=${row.exchangeHouseId} ` +
        `branch=${row.branchId ?? "NULL"} quantityUsd=${row.quantityUsd} ` +
        `carryingResidualIqd=${row.carryingResidualIqd}`,
    );
  }
  return errors;
}

// عقد trigger حجز طلب المتجر مستقل عن snapshot لأن Drizzle لا يمثل triggers.
function collectOnlineOrderReservationGuardErrors(triggerRows) {
  const errors = [];
  const finalName = "trg_online_orders_expired_activation_bu";
  const preName = "trg_online_orders_expired_activation_pre_bu";
  const preRows = triggerRows.filter((row) => row.triggerName === preName);
  if (preRows.length) {
    errors.push("temporary reservation pre-trigger remains after migration");
  }

  const finalRows = triggerRows.filter((row) => row.triggerName === finalName);
  if (finalRows.length !== 1) {
    errors.push(
      `final trigger must exist exactly once; found ${finalRows.length}`,
    );
    return errors;
  }

  const final = finalRows[0];
  if (
    final.eventObjectTable !== "onlineOrders" ||
    String(final.actionTiming).toUpperCase() !== "BEFORE" ||
    String(final.eventManipulation).toUpperCase() !== "UPDATE"
  ) {
    errors.push("final trigger must be BEFORE UPDATE on onlineOrders");
  }

  const body = String(final.actionStatement ?? "")
    .replaceAll("`", "")
    .replace(/\s+/g, "")
    .toUpperCase();
  if (
    !body.includes("NEW.ORDERSTATUSIN('CONFIRMED','PROCESSING')") ||
    !body.includes("OLD.ORDERSTATUSNOTIN('CONFIRMED','PROCESSING')")
  ) {
    errors.push(
      "final trigger body must guard inactive-to-CONFIRMED/PROCESSING activation",
    );
  }
  if (
    !body.includes(
      "COALESCE(OLD.RESERVATIONEXPIRESAT,DATE_ADD(OLD.ORDERDATE,INTERVAL24HOUR))<=CURRENT_TIMESTAMP(3)",
    )
  ) {
    errors.push(
      "final trigger body must use COALESCE(reservationExpiresAt, orderDate + 24 hours)",
    );
  }
  if (!body.includes("SIGNALSQLSTATE'45000'")) {
    errors.push("final trigger body must fail closed with SQLSTATE 45000");
  }
  return errors;
}

function runOperationalContractSelftest({ quiet = false } = {}) {
  const validInput = {
    databaseName: "erp_contract_test",
    fulfillmentColumns: [
      {
        tableName: "storeSettings",
        columnName: "fulfillmentBranchId",
        dataType: "bigint",
        columnType: "bigint",
        isNullable: "YES",
        columnDefault: null,
      },
      {
        tableName: "branches",
        columnName: "id",
        dataType: "bigint",
        columnType: "bigint",
        isNullable: "NO",
        columnDefault: null,
      },
    ],
    fulfillmentIndexes: [
      {
        indexName: "idx_store_settings_fulfillment_branch",
        columnName: "fulfillmentBranchId",
        seqInIndex: 1,
        nonUnique: 1,
        isVisible: "YES",
      },
    ],
    fulfillmentForeignKeys: [
      {
        columnName: "fulfillmentBranchId",
        referencedTableName: "branches",
        referencedColumnName: "id",
        referencedTableSchema: "erp_contract_test",
        deleteRule: "RESTRICT",
        updateRule: "NO ACTION",
      },
    ],
    expenseStatusColumns: [
      {
        tableName: "expenses",
        columnName: "expenseStatus",
        dataType: "enum",
        columnType: "enum('PENDING_APPROVAL','ACTIVE','REJECTED','CANCELLED')",
        isNullable: "NO",
        columnDefault: "ACTIVE",
      },
    ],
  };

  assert.deepEqual(collectOperationalSchemaContractErrors(validInput), []);

  const missingMigrationErrors = collectOperationalSchemaContractErrors({
    databaseName: validInput.databaseName,
    fulfillmentColumns: validInput.fulfillmentColumns.filter(
      (row) => row.columnName !== "fulfillmentBranchId",
    ),
    fulfillmentIndexes: [],
    fulfillmentForeignKeys: [],
    expenseStatusColumns: [],
  });
  assert.ok(missingMigrationErrors.some((error) => error.includes("0181")));
  assert.ok(missingMigrationErrors.some((error) => error.includes("الفهرس")));
  assert.ok(missingMigrationErrors.some((error) => error.includes("FK")));
  assert.ok(missingMigrationErrors.some((error) => error.includes("0182")));

  const semanticDriftErrors = collectOperationalSchemaContractErrors({
    ...validInput,
    fulfillmentColumns: validInput.fulfillmentColumns.map((row) =>
      row.columnName === "fulfillmentBranchId"
        ? {
            ...row,
            columnType: "bigint unsigned",
            isNullable: "NO",
            columnDefault: 1,
          }
        : row,
    ),
    fulfillmentIndexes: [
      { ...validInput.fulfillmentIndexes[0], nonUnique: 0, isVisible: "NO" },
      {
        indexName: "idx_store_settings_fulfillment_branch",
        columnName: "id",
        seqInIndex: 2,
        nonUnique: 0,
        isVisible: "NO",
      },
    ],
    fulfillmentForeignKeys: validInput.fulfillmentForeignKeys.map((row) => ({
      ...row,
      deleteRule: "CASCADE",
      updateRule: "CASCADE",
    })),
    expenseStatusColumns: validInput.expenseStatusColumns.map((row) => ({
      ...row,
      columnType: "enum('ACTIVE','CANCELLED')",
      isNullable: "YES",
      columnDefault: "CANCELLED",
    })),
  });
  for (const expectedFragment of [
    "لا يطابق branches.id",
    "يقبل NULL",
    "فرعاً افتراضياً",
    "عادياً مرئياً وأحادي العمود",
    "ON DELETE RESTRICT/NO ACTION",
    "ON UPDATE RESTRICT/NO ACTION",
    "بالترتيب حصراً",
    "NOT NULL",
    "افتراضه ACTIVE",
  ]) {
    assert.ok(
      semanticDriftErrors.some((error) => error.includes(expectedFragment)),
      `selftest لم يلتقط الانجراف: ${expectedFragment}`,
    );
  }

  const equivalentBlockingRulesErrors = collectOperationalSchemaContractErrors({
    ...validInput,
    fulfillmentForeignKeys: validInput.fulfillmentForeignKeys.map((row) => ({
      ...row,
      deleteRule: "NO ACTION",
      updateRule: "RESTRICT",
    })),
  });
  assert.deepEqual(
    equivalentBlockingRulesErrors,
    [],
    "RESTRICT وNO ACTION مترادفان كقواعد حظر في MySQL",
  );

  const crossSchemaFk = {
    ...validInput.fulfillmentForeignKeys[0],
    referencedTableSchema: "other_database",
  };
  for (const fulfillmentForeignKeys of [
    [...validInput.fulfillmentForeignKeys, crossSchemaFk],
    [crossSchemaFk, ...validInput.fulfillmentForeignKeys],
  ]) {
    const mixedFkErrors = collectOperationalSchemaContractErrors({
      ...validInput,
      fulfillmentForeignKeys,
    });
    assert.ok(
      mixedFkErrors.some((error) => error.includes("داخل القاعدة نفسها")),
      "يجب رفض FK إضافي عابر لقاعدة أخرى مهما كان ترتيب information_schema",
    );
  }

  const reorderedEnumErrors = collectOperationalSchemaContractErrors({
    ...validInput,
    expenseStatusColumns: validInput.expenseStatusColumns.map((row) => ({
      ...row,
      columnType:
        "enum('ACTIVE','PENDING_APPROVAL','REJECTED','CANCELLED','EXTRA')",
    })),
  });
  assert.ok(
    reorderedEnumErrors.some((error) => error.includes("بالترتيب حصراً")),
    "يجب رفض enum ذي ترتيب مختلف أو قيمة زائدة",
  );

  const exchangeAuditErrors = collectExchangeUsdMigrationAuditErrors({
    invalidRows: [
      {
        id: 71,
        txnNumber: "EX-USD-71",
        exchangeHouseId: 4,
        branchId: null,
        type: "WITHDRAW",
        usdAmount: "10.00",
        iqdAmount: "0.00",
        exchangeRate: "1450.0000",
      },
    ],
    invalidGroups: [
      {
        exchangeHouseId: 4,
        branchId: 2,
        quantityUsd: "0.00",
        carryingResidualIqd: "0.01",
      },
    ],
  });
  assert.equal(exchangeAuditErrors.length, 2);
  assert.ok(exchangeAuditErrors[0].includes("USD_CUSTODY_SOURCE_INVALID"));
  assert.ok(exchangeAuditErrors[1].includes("carryingResidualIqd=0.01"));

  const validReservationGuard = {
    triggerName: "trg_online_orders_expired_activation_bu",
    eventObjectTable: "onlineOrders",
    actionTiming: "BEFORE",
    eventManipulation: "UPDATE",
    actionStatement: `BEGIN
      IF NEW.orderStatus IN ('CONFIRMED', 'PROCESSING')
        AND OLD.orderStatus NOT IN ('CONFIRMED', 'PROCESSING')
        AND COALESCE(OLD.reservationExpiresAt, DATE_ADD(OLD.orderDate, INTERVAL 24 HOUR)) <= CURRENT_TIMESTAMP(3) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'expired';
      END IF;
    END`,
  };
  assert.deepEqual(
    collectOnlineOrderReservationGuardErrors([validReservationGuard]),
    [],
  );
  assert.ok(
    collectOnlineOrderReservationGuardErrors([]).some((error) =>
      error.includes("final trigger"),
    ),
  );
  assert.ok(
    collectOnlineOrderReservationGuardErrors([
      validReservationGuard,
      {
        ...validReservationGuard,
        triggerName: "trg_online_orders_expired_activation_pre_bu",
      },
    ]).some((error) => error.includes("pre-trigger")),
  );
  assert.ok(
    collectOnlineOrderReservationGuardErrors([
      { ...validReservationGuard, actionTiming: "AFTER" },
    ]).some((error) => error.includes("BEFORE UPDATE")),
  );
  assert.ok(
    collectOnlineOrderReservationGuardErrors([
      { ...validReservationGuard, actionStatement: "BEGIN END" },
    ]).some((error) => error.includes("COALESCE")),
  );

  if (!quiet) console.log("db schema operational contracts selftest: OK");
}

if (process.argv.includes("--selftest")) {
  runOperationalContractSelftest();
  process.exit(0);
}

// CI وprod:deploy يستدعيان db:verify مباشرة؛ لذلك تعمل اختبارات الدلالة في كل تشغيل،
// وليس فقط عند تذكّر تشغيل ملف اختبار منفصل.
runOperationalContractSelftest({ quiet: true });

await import("dotenv/config");
const { createConnection } = await import("mysql2/promise");

// 1) أحدث snapshot = المخطط المرجعي الكامل بعد كل الهجرات.
const snapFiles = readdirSync(META_DIR)
  .filter((f) => f.endsWith("_snapshot.json"))
  .sort();
if (!snapFiles.length) {
  console.error("⛔ تحقّق المخطط: لا snapshot في", META_DIR);
  process.exit(1);
}
const snap = JSON.parse(
  readFileSync(join(META_DIR, snapFiles[snapFiles.length - 1]), "utf-8"),
);

// شكل المرجع: table -> Set(column)
const expected = {};
for (const [tname, tdef] of Object.entries(snap.tables ?? {})) {
  // قد يأتي الاسم بصيغة schema.table في بعض اللهجات؛ MySQL يستعمل الاسم المجرّد.
  const bare = tname.includes(".") ? tname.split(".").pop() : tname;
  expected[bare] = new Set(Object.keys(tdef.columns ?? {}));
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("⛔ DATABASE_URL غير محدّد.");
  process.exit(1);
}

const conn = await createConnection(url);
const dbName = new URL(url).pathname.replace(/^\//, "");

try {
  const [rows] = await conn.query(
    "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?",
    [dbName],
  );
  const actual = {}; // table -> Set(column)
  for (const r of rows) (actual[r.TABLE_NAME] ??= new Set()).add(r.COLUMN_NAME);

  const missingTables = [];
  const missingCols = [];
  for (const [table, cols] of Object.entries(expected)) {
    if (!actual[table]) {
      missingTables.push(table);
      continue;
    }
    for (const col of cols)
      if (!actual[table].has(col)) missingCols.push(`${table}.${col}`);
  }

  if (missingTables.length || missingCols.length) {
    console.error("⛔ تحقّق المخطط فشل — القاعدة منحرفة عن snapshot:");
    if (missingTables.length)
      console.error("   جداول ناقصة:", missingTables.join(", "));
    if (missingCols.length)
      console.error("   أعمدة ناقصة:", missingCols.join(", "));
    console.error(
      "   السبب الأرجح: هجرة لم تُطبَّق فعلياً أو baseline سُجّل على قاعدة أقدم.",
    );
    console.error(
      "   عالِج بـ db:generate لهجرة جديدة، أو راجع __drizzle_migrations.",
    );
    await conn.end();
    process.exit(1);
  }

  // ── تحقّق الفهارس الحرجة (سدّ ثغرة F7، ٢٩/٦): db:verify كان يفحص الأعمدة لا الفهارس ⇒ فشل فهرس
  //    0013 الصامت (idx_receipt_bucket_status على عمود bucketId محذوف) بقي غير مرئي حتى أُكتشف بالتدقيق.
  //    هنا نؤكّد وجود الفهارس التي يكسر غيابُها الأداء/التقارير إنتاجياً (أُضيفت في 0030/0031/0032).
  const CRITICAL_INDEXES = [
    ["externalPaymentAttempts", "uq_extpay_reference"], // P0 0183: مرجع عالمي يمنع إعادة القبض عبر فرع/طريقة أخرى
    ["externalPaymentAttempts", "uq_extpay_request"],
    // 0307: الفاتورة تقبل محاولات/دفعات جزئية متعددة؛ يبقى invoiceId مفهرساً للقراءة
    // لكنه ليس فريداً. receiptId/reference/request يحتفظ كلٌّ منها بحارس التفرّد المالي.
    ["externalPaymentAttempts", "idx_extpay_invoice"],
    ["externalPaymentAttempts", "uq_extpay_receipt"],
    ["digitalSaleIntents", "uq_dsi_extpay_attempt"],
    ["receipts", "idx_receipt_bucket_status"], // F1: أُسقط مع bucketId في 0017، أُعيد في 0030
    ["receipts", "uq_receipt_cash_drop"], // 0185: تفرّد رقم السحب النقديّ لكل (رقم × اتجاه)
    ["receipts", "idx_receipt_shift_date"], // Z-report
    ["invoices", "idx_invoice_branch_status_date"], // S1: أعمار الذمم
    ["invoices", "idx_invoice_date_status"], // S2: تقارير المبيعات (مُغطٍّ)
    ["invoices", "idx_invoice_branch_date_status"], // S2: تقارير المبيعات بفرع (مُغطٍّ)
    ["accountingEntries", "idx_entry_branch_type_date"], // GL/P&L
    ["accountingEntries", "idx_entry_customer_date"],
    ["accountingEntries", "idx_entry_supplier_date"],
    ["inventoryMovements", "idx_move_branch_date"],
    ["inventoryMovements", "idx_move_branch_variant_type"],
    ["auditLogs", "idx_audit_user_action_date"],
    ["auditLogs", "idx_audit_entity"],
    ["branchStock", "idx_stock_branch_qty"],
    ["crmCampaigns", "idx_crm_campaign_branch_status"],
    ["promotions", "idx_promo_application"],
    ["coupons", "uq_coupon_hash"],
    ["couponRedemptions", "uq_coupon_redemption_invoice"],
    ["invoices", "idx_invoice_shift"], // ش٠ استقبال (0153): طابور المحطة keyset — غيابه مسح كامل
    ["orderPayments", "uq_orderpay_receipt"], // ش٤ (0155): الإصلاح البنيوي لالتقاط الإيصال الظنّي
    ["deliveryConsignments", "uq_consignment_source"],
    ["deliveryConsignments", "idx_consignment_parcel_queue"],
    ["deliveryConsignments", "idx_consignment_money_queue"],
    ["deliveryPartyMembers", "uq_delivery_party_member_user"],
    ["deliveryRemittanceLines", "idx_delivery_remittance_line_cn"],
    ["deliveryLedgerEntries", "idx_delivery_ledger_party_time"],
    ["deliveryEvents", "idx_delivery_event_cn_time"],
    ["deliveryOutbox", "idx_delivery_outbox_pending"],
    ["receptionDrafts", "uq_draft_commit_request"],
    ["receptionDrafts", "idx_draft_branch_status_id"],
    ["receptionDraftLines", "idx_dline_draft"],
    ["orderPayments", "uq_orderpay_request"],
    ["workOrders", "idx_wo_deposit_receipt"],
    ["invoices", "idx_invoice_correction_of"],
    ["invoices", "idx_invoice_corrected_by"],
    ["deliveryConsignments", "idx_consignment_workorder"],
    ["exchangeTransactions", "idx_exchange_custody_scope"],
  ];
  const [idxRows] = await conn.query(
    "SELECT TABLE_NAME, INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? GROUP BY TABLE_NAME, INDEX_NAME",
    [dbName],
  );
  const haveIdx = new Set(
    idxRows.map((r) => `${r.TABLE_NAME}.${r.INDEX_NAME}`),
  );
  const missingIdx = CRITICAL_INDEXES.filter(
    ([t, i]) => !haveIdx.has(`${t}.${i}`),
  ).map(([t, i]) => `${t}.${i}`);
  if (missingIdx.length) {
    console.error(
      "⛔ تحقّق الفهارس فشل — فهارس حرجة مفقودة (خطر مسح جداول كاملة أو علّة صامتة كـ0013):",
    );
    console.error("   " + missingIdx.join(", "));
    console.error(
      "   السبب الأرجح: هجرة فهرس لم تُطبَّق، أو أُسقط الفهرس مع عمود محذوف، أو خطأ اسم عمود في الهجرة.",
    );
    console.error(
      "   عالِج: راجع الهجرة المعنيّة وأعد إنشاء الفهرس (نمط idempotent كـ0030/0031/0032).",
    );
    await conn.end();
    process.exit(1);
  }

  // 0185: وجود الفهرس الفريد وحده **لا يكفي** — إن بقي `cashDropKey` عموداً عادياً (كما يكتبه
  // `db:push` من schema.ts) فقيمه كلّها NULL والفهرس لا يمنع شيئاً، بينما سجلّ الهجرات يقول
  // إنّ 0185 طُبِّقت. هذا بالضبط انجراف المخطّط الذي وُجد `db:verify` لالتقاطه، فنفحص
  // **دلالة** العمود لا اسمه: يجب أن يحمل تعبير توليدٍ فعلياً.
  const [genRows] = await conn.query(
    "SELECT GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'receipts' AND COLUMN_NAME = 'cashDropKey'",
    [dbName],
  );
  const genExpr = genRows[0]?.GENERATION_EXPRESSION ?? "";
  if (!genExpr) {
    console.error(
      "⛔ تحقّق العمود المولَّد فشل — receipts.cashDropKey ليس GENERATED (تفرّد رقم السحب النقديّ معطَّل فعلياً).",
    );
    console.error("   الإصلاح: أعِد تطبيق drizzle/migrations/0185_cash_drop_reference_uniqueness.sql");
    await conn.end();
    process.exit(1);
  }

  // مرجع فريد وحده لا يكفي: هذه القيود تمنع قواعد البيانات المنشأة بـdb:push من قبول
  // حالة مؤكدة بلا دليل أو استهلاك نصف مربوط. افحص أسماءها صراحةً مثل الفهارس الحرجة.
  const CRITICAL_CHECKS = [
    "chk_extpay_amount_positive",
    "chk_extpay_reference_normalized",
    "chk_extpay_confirmed_evidence",
    "chk_extpay_consumption_complete",
  ];
  const [constraintRows] = await conn.query(
    "SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'externalPaymentAttempts' AND CONSTRAINT_TYPE = 'CHECK'",
    [dbName],
  );
  const haveChecks = new Set(constraintRows.map((r) => r.CONSTRAINT_NAME));
  const missingChecks = CRITICAL_CHECKS.filter((name) => !haveChecks.has(name));
  if (missingChecks.length) {
    console.error("⛔ تحقّق قيود الدفع الخارجي فشل — قيود CHECK مفقودة:");
    console.error("   " + missingChecks.join(", "));
    await conn.end();
    process.exit(1);
  }

  // ── تحقّق كائنات ما بعد snapshot 0034 (سدّ النقطة العمياء، ٢/٧): الـsnapshot مُجمَّد عند 0034 ⇒
  //    فحص الأعمدة أعلاه أعمى عن كل ما أضافته الهجرات 0035-0040 (searchNorm/الصيرفة/السندات/USD).
  //    طريقة قديمة (drizzle-kit migrate) كانت تُسجّل هجراتٍ «مُطبَّقة» دون تنفيذ SQL فعلاً ⇒ انحراف
  //    صامت (كائن غائب رغم تسجيل الهجرة) لم يكن db:verify يمسكه ⇒ ثقة كاذبة. نفحصها صراحةً هنا.
  //    (هجرة 0041 المصالحة تُعيد إنشاء أي مفقود idempotently.)
  const CRITICAL_TABLES = [
    "externalPaymentAttempts",
    "receptionDrafts",
    "receptionDraftLines",
    "orderPayments",
    "voucherCategories",
    "exchangeHouses",
    "exchangeTransactions",
    "crmCampaigns",
    "couponPrograms",
    "coupons",
    "couponRedemptions",
    // D4 digital cards.  The latest Drizzle snapshot is intentionally frozen
    // before these migrations, so the generic snapshot check above cannot see
    // a partially applied digital-cards rollout.  Missing any of these tables
    // otherwise presents to the POS as an empty catalogue rather than a
    // deploy-time schema error.
    "digitalProviders",
    "digitalWallets",
    "digitalWalletTransactions",
    "digitalOfferings",
    "digitalOfferingBranches",
    "digitalPriceBatches",
    "digitalPriceVersions",
    "digitalCurrentPrices",
    "digitalSaleIntents",
    "digitalWalletReservations",
    "digitalSaleIntentItems",
    "digitalSaleDetails",
    "digitalWalletReconciliations",
    "digitalSubscriptionContracts",
    "deliveryPartyMembers",
    "deliveryRemittanceLines",
    "deliveryLedgerEntries",
    "deliveryEvents",
    "deliveryOutbox",
    "monthCloseCertificates",
    "monthCloseCertificateEvidence",
    "monthCloseEvents",
    "monthCloseSequence",
    "yearEndReopenRequests",
    // 0203: managed expense categories.  A missing table degrades the expense
    // picker to an empty list rather than failing loudly at deploy time.
    "expenseCategories",
  ];
  const CRITICAL_COLUMNS = [
    ["externalPaymentAttempts", "externalPaymentChannel"],
    ["externalPaymentAttempts", "externalPaymentMethod"],
    ["externalPaymentAttempts", "externalReference"],
    ["externalPaymentAttempts", "normalizedReference"],
    ["externalPaymentAttempts", "externalPaymentState"],
    ["externalPaymentAttempts", "invoiceId"],
    ["externalPaymentAttempts", "receiptId"],
    ["digitalSaleIntents", "externalPaymentAttemptId"],
    ["digitalSaleIntents", "externalPaymentDeviceId"],
    ["products", "searchNorm"],
    ["customers", "searchNorm"],
    ["suppliers", "searchNorm"], // 0035/0039
    ["receipts", "voucherCategoryId"],
    ["expenses", "expenseCategoryId"], // 0203
    ["receipts", "counterpartyName"],
    ["receipts", "voucherDate"], // 0036
    ["receipts", "attachmentUrl"],
    ["receipts", "internalNote"],
    ["receipts", "signatureHash"],
    ["receipts", "receiptApprovalStatus"],
    ["receipts", "approvedBy"],
    ["receipts", "approvedAt"],
    ["accountingEntries", "exchangeHouseId"], // 0037
    ["purchaseOrders", "poCurrency"],
    ["purchaseOrders", "usdTotal"],
    ["purchaseOrders", "agreedRate"], // 0038
    ["promotions", "campaignId"],
    ["promotions", "promotionApplicationMode"], // 0076 CRM
    ["invoices", "taxRatePercent"],
    ["quotations", "taxRatePercent"],
    ["purchaseOrders", "taxRatePercent"], // 0123
    ["deliveryConsignments", "sourceType"],
    ["deliveryConsignments", "sourceId"],
    ["deliveryConsignments", "assignedUserId"],
    ["deliveryConsignments", "parcelStatus"],
    ["deliveryConsignments", "governorate"],
    ["deliveryConsignments", "latitude"],
    ["deliveryConsignments", "longitude"],
    ["deliveryConsignments", "moneyStatus"],
    ["deliveryConsignments", "acceptedAt"],
    ["deliveryConsignments", "pickedUpAt"],
    ["deliveryConsignments", "outForDeliveryAt"],
    ["deliveryConsignments", "failedAt"],
    ["deliveryConsignments", "failureReason"],
    ["deliveryConsignments", "cancelledAt"],
    ["deliveryConsignments", "cancellationReason"],
    ["deliveryConsignments", "cancelledBy"],
    ["deliveryConsignments", "returnedAt"],
    ["deliveryConsignments", "custodyRecognizedAt"],
    ["deliveryPartyMembers", "memberRole"],
    ["deliveryRemittanceLines", "grossApplied"],
    ["deliveryLedgerEntries", "entryType"],
    ["deliveryEvents", "eventKey"],
    ["deliveryOutbox", "processedAt"],
    ["invoices", "contactName"],
    ["invoices", "contactPhone"], // 0150 reception identity snapshot
    ["invoices", "deliveryFree"],
    ["invoices", "deliveryWaivedAmount"], // 0152 reception/free-delivery disclosure
    ["productUnits", "isStoreSaleUnit"], // 0121 storefront eligibility; غيابه يحوّل API الكتالوج/الفئات إلى 500
    ["invoices", "correctionOfInvoiceId"],
    ["invoices", "correctedByInvoiceId"], // 0169 correction lineage
    ["invoiceItems", "isGift"], // 0149 gift line disclosure
    ["workOrders", "deliveryFeeCollection"],
    ["workOrders", "contactName"],
    ["workOrders", "contactPhone"],
    ["workOrders", "depositReceiptId"],
    ["workOrders", "deliveryPhone"], // 0147/0150/0153 reception work-order trail
    ["deliveryConsignments", "consignmentFeeCollection"],
    ["deliveryConsignments", "feeSettledAt"], // 0150 courier fee custody
    ["deliveryConsignments", "courierDeliveredAt"], // 0166 courier delivery evidence timestamp
    // D4: the POS catalogue requires an offering-to-branch mapping and a
    // materialized current price.  Check the key fields as well as the tables
    // so a stale/baselined production database cannot make enabled cards
    // silently disappear for cashiers.
    ["digitalOfferings", "isActive"],
    ["digitalOfferings", "subscriptionDurationDays"],
    ["digitalOfferingBranches", "branchId"],
    ["digitalOfferingBranches", "walletId"],
    ["digitalPriceBatches", "status"],
    ["digitalPriceVersions", "validUntil"],
    ["digitalCurrentPrices", "priceVersionId"],
    ["digitalSaleIntents", "status"],
    ["digitalSaleIntentItems", "providerId"],
    ["digitalSaleDetails", "fulfillmentStatus"],
    ["digitalSubscriptionContracts", "expiresAt"],
    ["exchangeHouses", "balanceUsdCarryingIqd"],
    ["financialPeriods", "closeMonth"],
    ["financialPeriods", "closeRevision"],
    ["financialPeriods", "predecessorPeriodId"],
    ["monthCloseRequests", "closeRevision"],
    ["monthCloseRequests", "requestedSequenceVersion"],
    ["yearEndSnapshots", "scopeKey"],
    ["yearEndSnapshots", "revision"],
    ["yearEndSnapshots", "supersedesSnapshotId"],
    ["monthCloseCertificates", "snapshotCanonical"],
    ["monthCloseCertificates", "monthCloseCertificateKind"],
    ["monthCloseCertificates", "certificateDoubleEntryMode"],
    ["monthCloseCertificateEvidence", "referenceCanonical"],
    ["monthCloseEvents", "payloadCanonical"],
    ["monthCloseEvents", "monthCloseEventType"],
    ["monthCloseSequence", "lastEventHash"],
    ["monthCloseSequence", "monthCloseSequenceStatus"],
    ["yearEndReopenRequests", "snapshotId"],
    ["yearEndReopenRequests", "certificateId"],
    ["yearEndReopenRequests", "periodId"],
    ["yearEndReopenRequests", "requestPayloadHash"],
    ["yearEndReopenRequests", "reversalEntryId"],
    ["yearEndReopenRequests", "reopenEventId"],
    ["yearEndReopenRequests", "yearEndReopenStatus"],
  ];
  const missingCritTables = CRITICAL_TABLES.filter((t) => !actual[t]);
  const missingCritCols = CRITICAL_COLUMNS.filter(
    ([t, c]) => !actual[t] || !actual[t].has(c),
  ).map(([t, c]) => `${t}.${c}`);
  if (missingCritTables.length || missingCritCols.length) {
    console.error(
      "⛔ تحقّق كائنات ما بعد snapshot 0034 فشل — انحراف صامت (كائنات هجرات 0035-0040 مسجَّلة «مُطبَّقة» لكنها غائبة فعلاً):",
    );
    if (missingCritTables.length)
      console.error("   جداول مفقودة:", missingCritTables.join(", "));
    if (missingCritCols.length)
      console.error("   أعمدة مفقودة:", missingCritCols.join(", "));
    console.error(
      "   السبب الأرجح: هجرة طُبِّقت بطريقة تفشل صامتاً سابقاً (drizzle-kit migrate) ⇒ سُجِّلت دون تنفيذ.",
    );
    console.error(
      "   عالِج: pnpm db:backup && pnpm db:migrate:safe (هجرة 0041 المصالحة تُعيد إنشاءها idempotently).",
    );
    await conn.end();
    process.exit(1);
  }

  const MONTH_CLOSE_CHECKS = [
    ["financialPeriods", "chk_period_close_identity"],
    ["monthCloseRequests", "chk_mcr_sequence_identity"],
    ["yearEndSnapshots", "chk_year_snapshot_revision"],
    ["monthCloseCertificates", "chk_mcc_identity"],
    ["monthCloseCertificates", "chk_mcc_previous_pair"],
    ["monthCloseCertificates", "chk_mcc_kind_refs"],
    ["monthCloseCertificates", "chk_mcc_runtime_tuple"],
    ["monthCloseCertificateEvidence", "chk_mcce_chunk_shape"],
    ["monthCloseEvents", "chk_mce_reference_shape"],
    ["monthCloseSequence", "chk_month_close_sequence_singleton"],
    ["monthCloseSequence", "chk_mcs_status_tuple"],
    ["yearEndReopenRequests", "chk_yerr_identity"],
    ["yearEndReopenRequests", "chk_yerr_lifecycle"],
  ];
  const [monthCloseCheckRows] = await conn.query(
    `SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE
       FROM information_schema.TABLE_CONSTRAINTS tc
       JOIN information_schema.CHECK_CONSTRAINTS cc
         ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
        AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA = ? AND tc.CONSTRAINT_TYPE = 'CHECK'`,
    [dbName],
  );
  const monthCloseChecks = new Set(
    monthCloseCheckRows.map(
      (row) => `${row.TABLE_NAME}.${row.CONSTRAINT_NAME}`,
    ),
  );
  const missingMonthCloseChecks = MONTH_CLOSE_CHECKS.filter(
    ([table, name]) => !monthCloseChecks.has(`${table}.${name}`),
  ).map(([table, name]) => `${table}.${name}`);
  if (missingMonthCloseChecks.length) {
    console.error(
      "⛔ month-close semantic CHECK constraints are missing:",
      missingMonthCloseChecks.join(", "),
    );
    await conn.end();
    process.exit(1);
  }
  const eventReferenceShape = monthCloseCheckRows.find(
    (row) =>
      row.TABLE_NAME === "monthCloseEvents" &&
      row.CONSTRAINT_NAME === "chk_mce_reference_shape",
  );
  const normalizedEventReferenceShape = String(
    eventReferenceShape?.CHECK_CLAUSE ?? "",
  )
    .replaceAll("`", "")
    // MySQL 8.4 exposes string literals through information_schema as
    // _utf8mb4\'VALUE\'.  Normalize that display-only introducer before the
    // semantic check so a correct physical CHECK is not rejected merely
    // because the server reports its charset explicitly.
    .replace(/_[a-z0-9]+\\'/gi, "'")
    .replaceAll("\\'", "'")
    .replace(/\s+/g, " ")
    .toUpperCase();
  if (!normalizedEventReferenceShape.includes("PERIODID IS NULL")) {
    console.error(
      "⛔ chk_mce_reference_shape is stale: BOOTSTRAP must pair fresh month/period NULL or legacy month/period non-NULL.",
    );
    await conn.end();
    process.exit(1);
  }
  if (
    !/MONTHCLOSEEVENTTYPE\s*=\s*'UNLOCK'.*REQUESTID IS NULL.*PERIODID IS NOT NULL/.test(
      normalizedEventReferenceShape,
    )
  ) {
    console.error(
      "⛔ chk_mce_reference_shape is stale: UNLOCK must not claim a month-close request reference.",
    );
    await conn.end();
    process.exit(1);
  }

  const MONTH_CLOSE_IMMUTABLE_TRIGGERS = [
    "trg_period_predecessor_bi",
    "trg_period_predecessor_bu",
    "trg_year_supersedes_bi",
    "trg_year_supersedes_bu",
    "trg_mcc_supersedes_bi",
    "trg_mcc_supersedes_bu",
    "trg_mcc_no_update",
    "trg_mcc_no_delete",
    "trg_mcce_no_update",
    "trg_mcce_no_delete",
    "trg_mce_no_update",
    "trg_mce_no_delete",
    "trg_year_snapshot_no_update",
    "trg_year_snapshot_no_delete",
    "trg_yerr_guard_update",
    "trg_yerr_no_delete",
    "trg_advrep_alloc_no_update",
    "trg_advrep_alloc_no_delete",
    "trg_accrual_event_no_update",
    "trg_accrual_event_no_delete",
  ];
  const [monthCloseTriggerRows] = await conn.query(
    "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?",
    [dbName],
  );
  const monthCloseTriggers = new Set(
    monthCloseTriggerRows.map((row) => row.TRIGGER_NAME),
  );
  const missingMonthCloseTriggers = MONTH_CLOSE_IMMUTABLE_TRIGGERS.filter(
    (name) => !monthCloseTriggers.has(name),
  );
  if (missingMonthCloseTriggers.length) {
    console.error(
      "⛔ month-close immutable triggers are missing:",
      missingMonthCloseTriggers.join(", "),
    );
    await conn.end();
    process.exit(1);
  }

  const [reservationGuardRows] = await conn.query(
    `SELECT TRIGGER_NAME AS triggerName,
            EVENT_OBJECT_TABLE AS eventObjectTable,
            ACTION_TIMING AS actionTiming,
            EVENT_MANIPULATION AS eventManipulation,
            ACTION_STATEMENT AS actionStatement
       FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = ?
        AND TRIGGER_NAME IN (?, ?)`,
    [
      dbName,
      "trg_online_orders_expired_activation_bu",
      "trg_online_orders_expired_activation_pre_bu",
    ],
  );
  const reservationGuardErrors =
    collectOnlineOrderReservationGuardErrors(reservationGuardRows);
  if (reservationGuardErrors.length) {
    console.error(
      "⛔ online-order reservation trigger contract failed:",
      reservationGuardErrors.join("; "),
    );
    await conn.end();
    process.exit(1);
  }

  const [exchangeCheckRows] = await conn.query(
    "SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'exchangeHouses' AND CONSTRAINT_TYPE = 'CHECK'",
    [dbName],
  );
  if (
    !exchangeCheckRows.some(
      (row) => row.CONSTRAINT_NAME === "chk_exchange_usd_carrying_sign",
    )
  ) {
    console.error(
      "⛔ قيد chk_exchange_usd_carrying_sign مفقود من exchangeHouses (0186 ناقصة أو schema drift).",
    );
    await conn.end();
    process.exit(1);
  }

  // 0186 direct-USD historical bridge.  The migration may only use each
  // transaction's own saved usdAmount/exchangeRate.  This post-migration gate
  // is deliberately operational, not just structural: it prints the exact
  // unresolved rows and the signed cent residual per (house, branch), then
  // stops prod:deploy before build/reload.
  const [invalidUsdCustodyRows] = await conn.query(
    `SELECT id,
            txnNumber,
            exchangeHouseId,
            branchId,
            exchangeTxnType AS type,
            usdAmount,
            iqdAmount,
            exchangeRate
       FROM exchangeTransactions
      WHERE exchangeTxnStatus = 'ACTIVE'
        AND exchangeTxnCurrency = 'USD'
        AND exchangeTxnType IN ('FX_BUY','WITHDRAW','DEPOSIT')
        AND (branchId IS NULL OR usdAmount <= 0 OR iqdAmount <= 0)
      ORDER BY exchangeHouseId, branchId, id`,
  );
  const [invalidUsdCustodyGroups] = await conn.query(
    `SELECT exchangeHouseId,
            branchId,
            ROUND(SUM(CASE WHEN exchangeTxnType IN ('FX_BUY','WITHDRAW')
                           THEN usdAmount ELSE -usdAmount END), 2) AS quantityUsd,
            ROUND(SUM(CASE WHEN exchangeTxnType IN ('FX_BUY','WITHDRAW')
                           THEN iqdAmount ELSE -iqdAmount END), 2) AS carryingResidualIqd
       FROM exchangeTransactions
      WHERE exchangeTxnStatus = 'ACTIVE'
        AND exchangeTxnCurrency = 'USD'
        AND exchangeTxnType IN ('FX_BUY','WITHDRAW','DEPOSIT')
      GROUP BY exchangeHouseId, branchId
     HAVING quantityUsd < 0
         OR carryingResidualIqd < 0
         OR (quantityUsd = 0 AND carryingResidualIqd <> 0)
         OR (quantityUsd <> 0 AND carryingResidualIqd = 0)
      ORDER BY exchangeHouseId, branchId`,
  );
  const exchangeUsdAuditErrors = collectExchangeUsdMigrationAuditErrors({
    invalidRows: invalidUsdCustodyRows,
    invalidGroups: invalidUsdCustodyGroups,
  });
  if (exchangeUsdAuditErrors.length) {
    console.error("⛔ Legacy direct-USD custody verification failed:");
    for (const error of exchangeUsdAuditErrors.slice(0, 50)) {
      console.error(`   - ${error}`);
    }
    if (exchangeUsdAuditErrors.length > 50) {
      console.error(
        `   - ... ${exchangeUsdAuditErrors.length - 50} more blocker(s)`,
      );
    }
    console.error(
      "   أصلح المصدر التاريخي بوثيقة محاسبية؛ لا تنسخ WAVG حالياً ولا معدل حركة أخرى، ثم أعد pnpm db:verify.",
    );
    await conn.end();
    process.exit(1);
  }

  // ── ش٥ (I23): كل قيمة enum جديدة تصل الإنتاج فعلاً — TELECOM على receipts.paymentMethod.
  //    توسيع enum على عمود قائم لا يمثّله push، وهجرة migrator فاشلة صامتاً كانت ستترك القيمة
  //    غائبة ⇒ كلّ قبض رصيد اتصال يسقط بخطأ بيانات. الفحص هنا يُفشل النشر **قبل** pm2 reload.
  const [telecomRows] = await conn.query(
    "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'receipts' AND COLUMN_NAME = 'paymentMethod'",
    [dbName],
  );
  const telecomType = String(telecomRows?.[0]?.t ?? "");
  if (!telecomType.includes("TELECOM")) {
    console.error(
      "⛔ قيمة enum مفقودة: receipts.paymentMethod بلا 'TELECOM' (هجرة 0156 لم تصل فعلياً).",
    );
    console.error("   COLUMN_TYPE الحالي:", telecomType || "(غير موجود)");
    console.error("   عالِج: طبّق 0154 (migrator) أو extras/0154 (CI push).");
    await conn.end();
    process.exit(1);
  }

  const [deliveryCancellationEnumRows] = await conn.query(
    "SELECT COLUMN_NAME AS c, COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME IN ('parcelStatus', 'consignmentStatus')",
    [dbName],
  );
  const deliveryCancellationEnums = new Map(
    deliveryCancellationEnumRows.map((row) => [String(row.c), String(row.t)]),
  );
  const missingDeliveryCancellationEnums = [
    "parcelStatus",
    "consignmentStatus",
  ].filter(
    (column) =>
      !String(deliveryCancellationEnums.get(column) ?? "").includes(
        "CANCELLED",
      ),
  );
  if (missingDeliveryCancellationEnums.length) {
    console.error(
      "⛔ قيم enum مفقودة: deliveryConsignments بلا CANCELLED في " +
        missingDeliveryCancellationEnums.join(", "),
    );
    console.error("   عالِج: طبّق الهجرة 0179 قبل إعادة تشغيل خادم الإنتاج.");
    await conn.end();
    process.exit(1);
  }

  // ── عقود 0181/0182 الحيّة: لا تعتمد على snapshot لأنه أقدم من الهجرتين.
  //    نتحقق من الدلالة الكاملة (النوع/الفهرس/FK وسياسة الحذف + enum)، لا من اسم العمود فقط.
  const [fulfillmentColumns] = await conn.query(
    `SELECT TABLE_NAME AS tableName,
            COLUMN_NAME AS columnName,
            DATA_TYPE AS dataType,
            COLUMN_TYPE AS columnType,
            IS_NULLABLE AS isNullable,
            COLUMN_DEFAULT AS columnDefault
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND ((TABLE_NAME = 'storeSettings' AND COLUMN_NAME = 'fulfillmentBranchId')
          OR (TABLE_NAME = 'branches' AND COLUMN_NAME = 'id'))`,
    [dbName],
  );
  const [fulfillmentIndexes] = await conn.query(
    `SELECT INDEX_NAME AS indexName,
            COLUMN_NAME AS columnName,
            SEQ_IN_INDEX AS seqInIndex,
            NON_UNIQUE AS nonUnique,
            IS_VISIBLE AS isVisible
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = 'storeSettings'
        AND INDEX_NAME = 'idx_store_settings_fulfillment_branch'
      ORDER BY SEQ_IN_INDEX`,
    [dbName],
  );
  const [fulfillmentForeignKeys] = await conn.query(
    `SELECT kcu.CONSTRAINT_NAME AS constraintName,
            kcu.COLUMN_NAME AS columnName,
            kcu.REFERENCED_TABLE_SCHEMA AS referencedTableSchema,
            kcu.REFERENCED_TABLE_NAME AS referencedTableName,
            kcu.REFERENCED_COLUMN_NAME AS referencedColumnName,
            rc.DELETE_RULE AS deleteRule,
            rc.UPDATE_RULE AS updateRule
       FROM information_schema.KEY_COLUMN_USAGE kcu
       JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        AND rc.TABLE_NAME = kcu.TABLE_NAME
      WHERE kcu.TABLE_SCHEMA = ?
        AND kcu.TABLE_NAME = 'storeSettings'
        AND kcu.COLUMN_NAME = 'fulfillmentBranchId'`,
    [dbName],
  );
  const [expenseStatusColumns] = await conn.query(
    `SELECT TABLE_NAME AS tableName,
            COLUMN_NAME AS columnName,
            DATA_TYPE AS dataType,
            COLUMN_TYPE AS columnType,
            IS_NULLABLE AS isNullable,
            COLUMN_DEFAULT AS columnDefault
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = 'expenses'
        AND COLUMN_NAME = 'expenseStatus'`,
    [dbName],
  );
  const operationalContractErrors = collectOperationalSchemaContractErrors({
    databaseName: dbName,
    fulfillmentColumns,
    fulfillmentIndexes,
    fulfillmentForeignKeys,
    expenseStatusColumns,
  });
  if (operationalContractErrors.length) {
    console.error(
      "⛔ عقود المخطط التشغيلية 0181/0182 فشلت — الهجرة ناقصة أو البنية منجرفة:",
    );
    for (const error of operationalContractErrors)
      console.error(`   - ${error}`);
    console.error(
      "   عالِج: راجع 0181_store_fulfillment_branch.sql و0182_expense_approval_lifecycle.sql ثم طبّق pnpm db:migrate:safe.",
    );
    await conn.end();
    process.exit(1);
  }

  console.log(
    `✓ تحقّق المخطط: ${Object.keys(expected).length} جدولاً مطابقة لـ snapshot (${snapFiles[snapFiles.length - 1]}).`,
  );
  console.log(
    `✓ تحقّق الفهارس: ${CRITICAL_INDEXES.length} فهرساً حرجاً موجودة.`,
  );
  console.log("✓ تحقّق enum: receipts.paymentMethod يحوي TELECOM (I23).");
  console.log(
    "✓ تحقّق enum: إلغاء إسناد التوصيل متاح في parcelStatus وconsignmentStatus.",
  );
  console.log(
    "✓ عقود 0181/0182: فرع تنفيذ المتجر (نوع+فهرس+FK) ودورة اعتماد المصروفات مطابقة.",
  );
  console.log(
    "✓ حارس حجز طلب المتجر: final BEFORE UPDATE صحيح وpre-trigger المؤقت غائب.",
  );
  console.log(
    `✓ تحقّق كائنات ما بعد 0034: ${CRITICAL_TABLES.length} جدولاً + ${CRITICAL_COLUMNS.length} عموداً (سدّ النقطة العمياء).`,
  );
  await conn.end();
} catch (e) {
  await conn.end().catch(() => {});
  console.error("✗ تحقّق المخطط تعذّر:", e?.message ?? e);
  process.exit(1);
}
