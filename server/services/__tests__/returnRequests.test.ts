/**
 * طلبات الإرجاع من المحطة (١٩/٨) — قرار المالك «طلب موظف + اعتماد مدير».
 *
 * الحال قبلها: `returns.create` محصورٌ بالمدير وشاشة المحطة تقول «استدعِ المدير» وتقف —
 * بينما رفضُ الزبون وإرجاعُ المندوب حدثٌ يوميّ. فإمّا يتوقّف العمل حتى يحضر المدير، أو
 * يُحفَظ المرتجع بحسابه فتضيع نسبةُ الفاعل ويسقط فصلُ المهام معاً.
 *
 * الثوابت المحروسة هنا:
 *  ① الطلب **مستند نيّةٍ لا مال**: صفرُ قيدٍ وإيصالٍ وحركةِ مخزونٍ ومسٍّ للأرصدة قبل الاعتماد.
 *  ② الاعتماد ينفّذ المسار الماليّ **القائم** بحرفه — لا نسخةَ منطقٍ ثانية.
 *  ③ فصل المهام: لا يعتمد أحدٌ طلبه بنفسه.
 *  ④ اللقطة التفاؤلية: تحرّكُ مرتجع الفاتورة بين الطلب والاعتماد يُبطل الطلب.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import { returnSale } from "../returnService";
import {
  createReturnRequest,
  listReturnRequests,
  loadApprovableRequest,
  loadApprovableRequestTx,
  markRequestApproved,
  markRequestApprovedTx,
  rejectReturnRequest,
} from "../returns/requests";
import { ensureFinancialPostingGate } from "../reports/monthCloseGate";
import { withTx } from "../tx";

const TABLES = [
  "returnRequests", "idempotencyKeys", "auditLogs", "accountingEntries", "receipts",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "branches", "users",
];

const MANAGER_A = { userId: 1, branchId: 1, role: "manager" };
const MANAGER_B = { userId: 3, branchId: 1, role: "manager" };
const CLERK = { userId: 2, branchId: 1, role: "cashier" };

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

beforeEach(async () => {
  const d = db();
  await d.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    for (const t of TABLES) await tx.execute(sql.raw(`DELETE FROM \`${t}\``));
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  });
  await ensureFinancialPostingGate(d);
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "الثاني", code: "B2", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "m1", name: "مدير أ", email: "m1@t.test", role: "manager", loginMethod: "local", branchId: 1,
    },
    { id: 2, openId: "c1", name: "موظف استقبال", email: "c1@t.test", role: "cashier", loginMethod: "local", branchId: 1,
    },
    { id: 3, openId: "m2", name: "مدير ب", email: "m2@t.test", role: "manager", loginMethod: "local", branchId: 1,
    },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل", phone: "+9647701234567", currentBalance: "0.00", creditLimit: null,
    },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB", costPrice: "400.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true,
    },
  ]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
  await d.insert(s.shifts).values([{ id: 1, branchId: 1, userId: 2, openingBalance: "0", status: "OPEN" },
    ]);
});

/** بيعٌ نقديّ كامل بكميّة 5 (٥٬٠٠٠). */
async function cashSale() {
  return createSale({
    branchId: 1, shiftId: 1, sourceType: "POS",
    lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
    payment: { amount: "5000.00", method: "CASH" },
  }, { userId: 2, branchId: 1 },
  );
}
const firstItem = async (invoiceId: number) =>
  (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, invoiceId)))[0];
const stock = async () =>
  Number((await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0].quantity,
  );

describe("طلب الإرجاع — مستند نيّةٍ لا مال", () => {
  it("⭐ طلبُ موظّفٍ لا يمسّ مالاً ولا مخزوناً ولا فاتورةً", async () => {
    const sale = await cashSale();
    const item = await firstItem(sale.invoiceId);
    const entriesBefore = (await db().select().from(s.accountingEntries)).length;
    const receiptsBefore = (await db().select().from(s.receipts)).length;

    const res = await createReturnRequest({
      invoiceId: sale.invoiceId,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 2 }],
      reason: "العميل رفض الاستلام",
    }, CLERK,
    );

    expect(res.status).toBe("PENDING_APPROVAL");
    // صفرُ أثرٍ ماليّ أو مخزنيّ — هذا هو جوهر التصميم.
    expect((await db().select().from(s.accountingEntries)).length).toBe(entriesBefore,
    );
    expect((await db().select().from(s.receipts)).length).toBe(receiptsBefore);
    expect(await stock()).toBe(95); // كما بعد البيع، بلا إرجاع
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv.returnedTotal).toBe("0.00");
    expect(inv.status).toBe("PAID");
  });

  it("عزل الفرع وحالة الفاتورة: طلبٌ على فاتورة فرعٍ آخر أو فاتورةٍ ميتة ⇒ يُرفض", async () => {
    const sale = await cashSale();
    const item = await firstItem(sale.invoiceId);
    await expect(createReturnRequest(
      { invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }], reason: "سبب",
        },
      { userId: 2, branchId: 2, role: "cashier" },
    ),
    ).rejects.toThrowError(/فرعاً آخر|فرعا اخر/);

    await db().update(s.invoices).set({ status: "CANCELLED" }).where(eq(s.invoices.id, sale.invoiceId));
    await expect(createReturnRequest(
      { invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }], reason: "سبب",
        },
      CLERK,
    ),
    ).rejects.toThrowError(/لا يُطلَب إرجاعٌ|لا يطلب/);
  });

  it("كميّةٌ تتجاوز المتبقّي ⇒ تُرفض قبل الحفظ", async () => {
    const sale = await cashSale();
    const item = await firstItem(sale.invoiceId);
    await expect(createReturnRequest(
      { invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 9 }], reason: "سبب",
        },
      CLERK,
    ),
    ).rejects.toThrowError(/خارج المتبقّي|خارج المتبقي/);
    expect(await db().select().from(s.returnRequests)).toHaveLength(0);
  });

  it("طلبٌ معلَّقٌ قائم ⇒ لا يُكدَّس طلبٌ ثانٍ على نفس الفاتورة", async () => {
    const sale = await cashSale();
    const item = await firstItem(sale.invoiceId);
    const line = [{ invoiceItemId: Number(item.id), baseQuantity: 1 }];
    await createReturnRequest({ invoiceId: sale.invoiceId, lines: line, reason: "أول" }, CLERK,
    );
    await expect(createReturnRequest({ invoiceId: sale.invoiceId, lines: line, reason: "ثانٍ" }, CLERK,
      ),
    )
      .rejects.toThrowError(/معلَّقٌ|معلق/);
  });
});

describe("الاعتماد — فصل المهام واللقطة التفاؤلية", () => {
  it("⭐ مديرٌ آخر يعتمد فيقع المرتجع فعلاً بالمسار القائم", async () => {
    const sale = await cashSale();
    const item = await firstItem(sale.invoiceId);
    const req = await createReturnRequest({
      invoiceId: sale.invoiceId,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 2 }],
      reason: "رفض العميل",
    }, CLERK,
    );

    const { lines, invoiceId } = await loadApprovableRequest(req.requestId, MANAGER_A,
    );
    await returnSale({
      invoiceId, lines,
      resolution: {
        kind: "IMMEDIATE_REFUND", method: "CASH", amount: "2000.00", shiftId: 1,
        reason: "اعتماد طلب مرتجع موثق من مدير مستقل", disposition: "RESTOCK",
      },
      clientRequestId: `retreq-${req.requestId}`,
    }, MANAGER_A,
    );
    await markRequestApproved(req.requestId, MANAGER_A.userId, invoiceId);

    // الأثر الماليّ والمخزنيّ وقع الآن (لا قبل الاعتماد).
    expect(await stock()).toBe(97);
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv.returnedTotal).toBe("2000.00");
    const stored = (await db().select().from(s.returnRequests).where(eq(s.returnRequests.id, req.requestId)))[0];
    expect(stored.status).toBe("APPROVED");
    expect(Number(stored.approvedBy)).toBe(MANAGER_A.userId);
  });

  it("⭐ فصل المهام: لا يعتمد أحدٌ طلبه بنفسه", async () => {
    const sale = await cashSale();
    const item = await firstItem(sale.invoiceId);
    // المدير «ب» يقدّم الطلب بنفسه، ثم يحاول اعتماده.
    const req = await createReturnRequest({
      invoiceId: sale.invoiceId,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
      reason: "سبب",
    }, MANAGER_B,
    );
    await expect(loadApprovableRequest(req.requestId, MANAGER_B),
    )
      .rejects.toThrowError(/لا تعتمد طلبك بنفسك/);
    // ومديرٌ آخر يمرّ.
    await expect(loadApprovableRequest(req.requestId, MANAGER_A),
    ).resolves.toBeTruthy();
  });

  it("⭐ اللقطة التفاؤلية: تحرّكُ مرتجع الفاتورة بين الطلب والاعتماد يُبطل الطلب", async () => {
    const sale = await cashSale();
    const item = await firstItem(sale.invoiceId);
    const req = await createReturnRequest({
      invoiceId: sale.invoiceId,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 3 }],
      reason: "سبب",
    }, CLERK,
    );

    // مرتجعٌ مباشرٌ وقع في نافذة الاعتماد ⇒ الكميات المطلوبة بُنيت على حالةٍ لم تعد قائمة.
    await returnSale({
      invoiceId: sale.invoiceId,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 2 }],
      resolution: {
        kind: "IMMEDIATE_REFUND", method: "CASH", amount: "2000.00", shiftId: 1,
        reason: "مرتجع مباشر يختبر إبطال لقطة طلب قديم", disposition: "RESTOCK",
      },
    }, MANAGER_A,
    );

    await expect(loadApprovableRequest(req.requestId, MANAGER_A),
    )
      .rejects.toThrowError(/تغيّر مرتجع الفاتورة|تغير مرتجع/);

    // الطلب stale لا يبقى معلّقاً إلى الأبد: يمكن رفضه بسببٍ موثق ثم إنشاء طلب صحيح جديد.
    await expect(
      rejectReturnRequest(
        req.requestId,
        "الطلب قديم بعد تنفيذ مرتجع أحدث",
        MANAGER_A,
      ),
    ).resolves.toMatchObject({ status: "REJECTED" });
    const stale = (
      await db()
        .select()
        .from(s.returnRequests)
        .where(eq(s.returnRequests.id, req.requestId))
    )[0];
    expect(stale.status).toBe("REJECTED");
  });

  it("الرفض بسببٍ إلزاميّ يُغلق الطلب ويُبقيه مرئياً للموظّف", async () => {
    const sale = await cashSale();
    const item = await firstItem(sale.invoiceId);
    const req = await createReturnRequest({
      invoiceId: sale.invoiceId,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
      reason: "سبب",
    }, CLERK,
    );

    await expect(rejectReturnRequest(req.requestId, "لا", MANAGER_A),
    ).rejects.toThrowError(/سبب الرفض/);
    await rejectReturnRequest(req.requestId, "البضاعة سليمة ولم تُرجَع فعلاً", MANAGER_A,
    );

    const mine = await listReturnRequests({ branchId: 1, createdBy: CLERK.userId,
    });
    expect(mine[0].status).toBe("REJECTED");
    expect(mine[0].rejectionReason).toContain("سليمة");
    // ولا أثر ماليّ من الرفض.
    expect(await stock()).toBe(95);
  });

  it("⭐ سباق اعتماد/رفض: الرافض المتأخر لا يقلب طلباً معتمداً إلى مرفوض", async () => {
    const sale = await cashSale();
    const item = await firstItem(sale.invoiceId);
    const req = await createReturnRequest(
      {
        invoiceId: sale.invoiceId,
        lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
        reason: "رفض العميل",
      },
      CLERK,
    );

    let releaseApproval!: () => void;
    const approvalMayFinish = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    let requestLocked!: () => void;
    const approvalHasLock = new Promise<void>((resolve) => {
      requestLocked = resolve;
    });

    const approval = withTx(async (tx) => {
      await loadApprovableRequestTx(tx, req.requestId, MANAGER_A);
      requestLocked();
      await approvalMayFinish;
      await markRequestApprovedTx(
        tx,
        req.requestId,
        MANAGER_A.userId,
        sale.invoiceId,
      );
    });
    await approvalHasLock;

    // يبدأ الرفض بعد أخذ الاعتماد قفل FOR UPDATE؛ يبقى منتظراً ثم يجب أن يرى APPROVED
    // بعد الالتزام، لا أن يكتب REJECTED فوق الأثر المالي المعتمد.
    const rejection = rejectReturnRequest(
      req.requestId,
      "لا يوجد دليل يبرر الإرجاع",
      MANAGER_B,
    );
    releaseApproval();
    await approval;
    await expect(rejection).rejects.toMatchObject({ code: "CONFLICT" });

    const stored = (
      await db()
        .select()
        .from(s.returnRequests)
        .where(eq(s.returnRequests.id, req.requestId))
    )[0];
    expect(stored.status).toBe("APPROVED");
    expect(Number(stored.approvedBy)).toBe(MANAGER_A.userId);
    expect(stored.rejectionReason).toBeNull();
  });
});
