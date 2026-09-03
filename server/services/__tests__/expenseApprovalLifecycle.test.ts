import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { TrpcContext } from "../../context";
import { appRouter } from "../../routers";
import {
  approveExpense,
  cancelExpense,
  createExpense,
  listExpenses,
  rejectExpense,
} from "../expenseService";
import { getExpensesReport } from "../reportsTreasuryService";
import { toDateStr } from "../money";

const creator = {
  userId: 1,
  branchId: 1,
  role: "cashier" as const,
};
const ownerA = {
  userId: 2,
  branchId: 1,
  role: "admin" as const,
  isOwner: true,
};
const ownerB = {
  userId: 3,
  branchId: 1,
  role: "admin" as const,
  isOwner: true,
};

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

async function reset() {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "idempotencyKeys",
    "auditLogs",
    "accountingEntries",
    "expenses",
    "receipts",
    "shifts",
    "branches",
    "users",
  ]) {
    await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  await db().insert(s.branches).values({
    id: 1,
    name: "الرئيسي",
    code: "MAIN",
    type: "MAIN",
    isActive: true,
  });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "expense-creator",
        name: "الموظف المنشئ",
        role: "cashier",
        loginMethod: "local",
        branchId: 1,
        isActive: true,
        isOwner: false,
      },
      {
        id: 2,
        openId: "expense-owner-a",
        name: "المالك أ",
        role: "admin",
        loginMethod: "local",
        branchId: 1,
        isActive: true,
        isOwner: true,
      },
      {
        id: 3,
        openId: "expense-owner-b",
        name: "المالك ب",
        role: "admin",
        loginMethod: "local",
        branchId: 1,
        isActive: true,
        isOwner: true,
      },
      {
        id: 4,
        openId: "expense-non-owner",
        name: "مدير ليس مالكاً",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
        isActive: true,
        isOwner: false,
      },
      {
        id: 5,
        openId: "expense-inactive-owner",
        name: "مالك معطل",
        role: "admin",
        loginMethod: "local",
        branchId: 1,
        isActive: false,
        isOwner: true,
      },
    ]);
}

async function openCreatorDrawer(openingBalance: string) {
  await db().insert(s.shifts).values({
    id: 1,
    userId: creator.userId,
    branchId: 1,
    openingBalance,
    status: "OPEN",
    shiftType: "RETAIL",
    openGuard: "1:1:RETAIL",
  });
}

async function fundTreasury(amount: string) {
  await db()
    .insert(s.receipts)
    .values({
      branchId: 1,
      direction: "IN",
      amount,
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      referenceNumber: `TREASURY-FUND-${amount}`,
      createdBy: 2,
    });
}

async function pendingExpense(
  amount = "500000.00",
  paymentMethod: "CASH" | "CARD" | "TRANSFER" | "WALLET" = "CASH",
) {
  return createExpense(
    {
      branchId: 1,
      category: "RENT",
      amount,
      paymentMethod,
      description: "طلب مصروف يحتاج اعتماداً",
      payee: "جهة مستفيدة",
    },
    creator,
  );
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("دورة اعتماد المصروفات", () => {
  it("دون الحد مع درج صفري يُرفض ويرجع كل الأثر", async () => {
    await openCreatorDrawer("0.00");
    await expect(
      createExpense(
        {
          branchId: 1,
          category: "SUPPLIES",
          amount: "1000.00",
          paymentMethod: "CASH",
          description: "نثرية غير ممولة",
        },
        creator,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.expenses)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  });

  it("دون الحد مع درج ممول يُنفذ فوراً على وردية المنشئ", async () => {
    await openCreatorDrawer("100000.00");
    const result = await createExpense(
      {
        branchId: 1,
        category: "SUPPLIES",
        amount: "25000.00",
        paymentMethod: "CASH",
        description: "نثرية ممولة",
      },
      creator,
    );
    const expense = (
      await db()
        .select()
        .from(s.expenses)
        .where(eq(s.expenses.id, result.expenseId))
    )[0];
    const receipt = (
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.id, Number(result.receiptId)))
    )[0];
    expect(expense.status).toBe("ACTIVE");
    expect(expense.cashBucket).toBe("DRAWER");
    expect(Number(expense.shiftId)).toBe(1);
    expect(receipt.status).toBe("COMPLETED");
    expect(receipt.cashBucket).toBe("DRAWER");
    expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
  });

  it("500000 بالضبط ينشئ طلباً وإيصالاً معلّقاً بلا قيد أو أثر نقدي", async () => {
    await openCreatorDrawer("900000.00");
    const result = await pendingExpense("500000.00");
    const expense = (
      await db()
        .select()
        .from(s.expenses)
        .where(eq(s.expenses.id, result.expenseId))
    )[0];
    const receipt = (
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.id, Number(result.receiptId)))
    )[0];
    expect(expense.status).toBe("PENDING_APPROVAL");
    expect(expense.shiftId).toBeNull();
    expect(expense.cashBucket).toBeNull();
    expect(receipt.status).toBe("PENDING");
    expect(receipt.approvalStatus).toBe("PENDING_APPROVAL");
    expect(receipt.shiftId).toBeNull();
    expect(receipt.cashBucket).toBeNull();
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  });

  it("499999.995 يُقرّب أولاً إلى الحد ولا يخرج فورياً من الدرج", async () => {
    await openCreatorDrawer("900000.00");
    const result = await pendingExpense("499999.995");
    const [expense] = await db()
      .select()
      .from(s.expenses)
      .where(eq(s.expenses.id, result.expenseId));
    expect(expense).toMatchObject({
      amount: "500000.00",
      status: "PENDING_APPROVAL",
      shiftId: null,
      cashBucket: null,
    });
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  });

  it("مفتاح إنشاء المصروف يعيد الحمولة نفسها ويرفض استعماله بمبلغ مختلف", async () => {
    const first = await createExpense(
      {
        branchId: 1,
        category: "RENT",
        amount: "500000.00",
        paymentMethod: "TRANSFER",
        description: "طلب شبكي قابل للإعادة",
        clientRequestId: "expense-payload-bound-key",
      },
      creator,
    );
    const replay = await createExpense(
      {
        branchId: 1,
        category: "RENT",
        amount: "500000.0",
        paymentMethod: "TRANSFER",
        description: "طلب شبكي قابل للإعادة",
        clientRequestId: "expense-payload-bound-key",
      },
      creator,
    );
    expect(replay).toMatchObject({
      expenseId: first.expenseId,
      idempotent: true,
    });
    await expect(
      createExpense(
        {
          branchId: 1,
          category: "RENT",
          amount: "600000.00",
          paymentMethod: "TRANSFER",
          description: "طلب شبكي قابل للإعادة",
          clientRequestId: "expense-payload-bound-key",
        },
        creator,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db().select().from(s.expenses)).toHaveLength(1);
    expect(await db().select().from(s.receipts)).toHaveLength(1);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  });

  it("إعادة مفتاح صالح لا تخفي cashSource محظوراً على تحويل غير نقدي", async () => {
    const base = {
      branchId: 1,
      category: "RENT" as const,
      amount: "500000.00",
      paymentMethod: "TRANSFER" as const,
      description: "تحويل بلا مصدر نقدي",
      clientRequestId: "expense-invalid-cash-source-replay",
    };
    await createExpense(base, creator);
    await expect(
      createExpense({ ...base, cashSource: "TREASURY" }, creator),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await db().select().from(s.expenses)).toHaveLength(1);
  });

  it("مفتاح إعادة محاولة معلّق على مرجع مفقود يفشل مغلقاً", async () => {
    await db().insert(s.idempotencyKeys).values({
      operation: "expense.create.CASH",
      clientRequestId: "expense-dangling-key",
      refId: 999999,
      payloadHash: null,
    });
    await expect(
      createExpense(
        {
          branchId: 1,
          category: "RENT",
          amount: "500000.00",
          paymentMethod: "TRANSFER",
          description: "مرجع مفقود",
          clientRequestId: "expense-dangling-key",
        },
        creator,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db().select().from(s.expenses)).toHaveLength(0);
  });

  it("إعادتان متزامنتان لنفس طلب الإنشاء تنتهيان بمصروف واحد", async () => {
    const caller = appRouter.createCaller({
      req: { headers: {} },
      res: {},
      sessionId: null,
      platformAdmin: null,
      user: {
        id: creator.userId,
        openId: "expense-creator",
        name: "الموظف المنشئ",
        role: "cashier",
        branchId: 1,
        isActive: true,
        isOwner: false,
      },
    } as unknown as TrpcContext);
    const input = {
      branchId: 1,
      category: "RENT" as const,
      amount: "500000.00",
      paymentMethod: "TRANSFER" as const,
      description: "طلب متزامن",
      clientRequestId: "expense-concurrent-create-key",
    };
    const results = await Promise.all([
      caller.expenses.create(input),
      caller.expenses.create(input),
    ]);
    expect(new Set(results.map((result) => result.expenseId)).size).toBe(1);
    expect(await db().select().from(s.expenses)).toHaveLength(1);
    expect(await db().select().from(s.receipts)).toHaveLength(1);
  });

  it("إعادتان متزامنتان لصرف درج يساوي كامل الرصيد تعيدان المصروف نفسه", async () => {
    await openCreatorDrawer("1000.00");
    const input = {
      branchId: 1,
      category: "SUPPLIES" as const,
      amount: "1000.00",
      paymentMethod: "CASH" as const,
      description: "صرف فوري مع إعادة شبكة متزامنة",
      clientRequestId: "expense-concurrent-drawer-key",
    };
    const results = await Promise.all([
      createExpense(input, creator),
      createExpense(input, creator),
    ]);
    expect(new Set(results.map((result) => result.expenseId)).size).toBe(1);
    expect(await db().select().from(s.expenses)).toHaveLength(1);
    expect(await db().select().from(s.receipts)).toHaveLength(1);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
  });

  it("مفتاح قديم بلا بصمة يفشل مغلقاً ولو كان مرجعه موجوداً", async () => {
    const original = await pendingExpense("500000.00", "TRANSFER");
    await db().insert(s.idempotencyKeys).values({
      operation: "expense.create.CASH",
      clientRequestId: "expense-legacy-unverifiable-key",
      refId: original.expenseId,
      payloadHash: null,
    });

    await expect(
      createExpense(
        {
          branchId: 1,
          category: "RENT",
          amount: "500000.00",
          paymentMethod: "TRANSFER",
          description: "طلب قديم لا يمكن إثبات حمولته",
          clientRequestId: "expense-legacy-unverifiable-key",
        },
        creator,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db().select().from(s.expenses)).toHaveLength(1);
    expect(await db().select().from(s.receipts)).toHaveLength(1);
  });

  it("اختيار الخزينة للصغير يحوله إلى طلب ولا يتجاوز الحد", async () => {
    await openCreatorDrawer("100000.00");
    const result = await createExpense(
      {
        branchId: 1,
        category: "SUPPLIES",
        amount: "1000.00",
        paymentMethod: "CASH",
        cashSource: "TREASURY",
        description: "ليس نثرية درج",
      },
      creator,
    );
    const expense = (
      await db()
        .select()
        .from(s.expenses)
        .where(eq(s.expenses.id, result.expenseId))
    )[0];
    expect(expense).toMatchObject({
      status: "PENDING_APPROVAL",
      shiftId: null,
      cashBucket: null,
    });
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  });

  it("مالك نشط غير المنشئ يعتمد فينفذ CASH من الخزينة بذرة واحدة", async () => {
    await fundTreasury("750000.00");
    const request = await pendingExpense();
    await approveExpense(request.expenseId, ownerA);

    const expense = (
      await db()
        .select()
        .from(s.expenses)
        .where(eq(s.expenses.id, request.expenseId))
    )[0];
    const receipt = (
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.id, Number(request.receiptId)))
    )[0];
    expect(expense.status).toBe("ACTIVE");
    expect(expense.cashBucket).toBe("TREASURY");
    expect(expense.shiftId).toBeNull();
    expect(receipt.status).toBe("COMPLETED");
    expect(receipt.approvalStatus).toBe("APPROVED");
    expect(Number(receipt.approvedBy)).toBe(ownerA.userId);
    expect(receipt.cashBucket).toBe("TREASURY");
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.receiptId, Number(request.receiptId))),
    ).toHaveLength(1);
    expect(
      await db()
        .select()
        .from(s.auditLogs)
        .where(eq(s.auditLogs.action, "expense.approveDisburse")),
    ).toHaveLength(1);
  });

  it("راية المالك وحدها تفتح endpoint الاعتماد ولو كان قالب الدور user", async () => {
    await fundTreasury("750000.00");
    const request = await pendingExpense();
    await db()
      .update(s.users)
      .set({ role: "user" })
      .where(eq(s.users.id, ownerA.userId));
    const caller = appRouter.createCaller({
      req: { headers: {} },
      res: {},
      sessionId: null,
      platformAdmin: null,
      user: {
        id: ownerA.userId,
        openId: "expense-owner-a",
        name: "المالك أ",
        role: "user",
        branchId: 1,
        isActive: true,
        isOwner: true,
      },
    } as unknown as TrpcContext);

    await expect(
      caller.expenses.approve({ expenseId: request.expenseId }),
    ).resolves.toMatchObject({ status: "ACTIVE" });
    expect(
      (
        await db()
          .select()
          .from(s.expenses)
          .where(eq(s.expenses.id, request.expenseId))
      )[0]?.status,
    ).toBe("ACTIVE");
  });

  it("نقص الخزينة يرجع الاعتماد كاملاً ويبقي الطلب معلّقاً", async () => {
    await fundTreasury("100000.00");
    const request = await pendingExpense();
    await expect(
      approveExpense(request.expenseId, ownerA),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const expense = (
      await db()
        .select()
        .from(s.expenses)
        .where(eq(s.expenses.id, request.expenseId))
    )[0];
    const receipt = (
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.id, Number(request.receiptId)))
    )[0];
    expect(expense.status).toBe("PENDING_APPROVAL");
    expect(expense.cashBucket).toBeNull();
    expect(receipt.status).toBe("PENDING");
    expect(receipt.approvalStatus).toBe("PENDING_APPROVAL");
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(await db().select().from(s.auditLogs)).toHaveLength(0);
  });

  it("اعتماد المصروف الكبير غير النقدي ينفذه بلا cashBucket", async () => {
    const request = await pendingExpense("800000.00", "TRANSFER");
    await approveExpense(request.expenseId, ownerA);
    const expense = (
      await db()
        .select()
        .from(s.expenses)
        .where(eq(s.expenses.id, request.expenseId))
    )[0];
    const receipt = (
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.id, Number(request.receiptId)))
    )[0];
    expect(expense).toMatchObject({
      status: "ACTIVE",
      paymentMethod: "TRANSFER",
      shiftId: null,
      cashBucket: null,
    });
    expect(receipt).toMatchObject({
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      shiftId: null,
      cashBucket: null,
    });
    expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
  });

  it("كل الطرق غير النقدية الصغيرة تبقى معلّقة حتى اعتماد المالك", async () => {
    const methods = ["CARD", "CHECK", "TRANSFER", "WALLET"] as const;
    const requests = [];
    for (const paymentMethod of methods) {
      requests.push(
        await createExpense(
          {
            branchId: 1,
            category: "UTILITIES",
            amount: "100.00",
            paymentMethod,
            description: `مصروف صغير بطريقة ${paymentMethod}`,
          },
          creator,
        ),
      );
    }
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(
      (await db().select().from(s.expenses)).every(
        (row) => row.status === "PENDING_APPROVAL" && row.cashBucket == null,
      ),
    ).toBe(true);

    for (const request of requests) {
      await approveExpense(request.expenseId, ownerA);
    }
    expect(await db().select().from(s.accountingEntries)).toHaveLength(4);
    expect(
      (await db().select().from(s.expenses)).every(
        (row) =>
          row.status === "ACTIVE" &&
          row.cashBucket == null &&
          row.shiftId == null,
      ),
    ).toBe(true);
  });

  it("غير المالك والمالك المعطل لا يستطيعان الرفض، والمالك المنشئ يعتمد ويرفض نفسه (قرار المالك ٣/٩/٢٦)", async () => {
    const request = await pendingExpense();
    await expect(
      rejectExpense(
        request.expenseId,
        {
          userId: 4,
          branchId: 1,
          role: "manager",
        },
        "غير مستحق",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      rejectExpense(
        request.expenseId,
        {
          userId: 5,
          branchId: 1,
          role: "admin",
          isOwner: true,
        },
        "غير مستحق",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const selfApproveRequest = await createExpense(
      {
        branchId: 1,
        category: "RENT",
        amount: "500000.00",
        paymentMethod: "TRANSFER",
        description: "طلب أنشأه المالك",
      },
      ownerA,
    );
    await expect(
      approveExpense(selfApproveRequest.expenseId, ownerA),
    ).resolves.toMatchObject({ status: "ACTIVE" });

    const selfRejectRequest = await createExpense(
      {
        branchId: 1,
        category: "RENT",
        amount: "500000.00",
        paymentMethod: "TRANSFER",
        description: "طلب أنشأه المالك — يسحبه بنفسه",
      },
      ownerA,
    );
    await expect(
      rejectExpense(selfRejectRequest.expenseId, ownerA, "طلب ذاتي"),
    ).resolves.toMatchObject({ status: "REJECTED" });
  });

  it("اعتمادان متزامنان يصنعان أثراً مالياً واحداً فقط", async () => {
    await fundTreasury("1000000.00");
    const request = await pendingExpense();
    const results = await Promise.all([
      approveExpense(request.expenseId, ownerA),
      approveExpense(request.expenseId, ownerB),
    ]);
    expect(results.filter((result) => !result.idempotent)).toHaveLength(1);
    expect(results.filter((result) => result.idempotent)).toHaveLength(1);
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.receiptId, Number(request.receiptId))),
    ).toHaveLength(1);
    expect(
      await db()
        .select()
        .from(s.auditLogs)
        .where(eq(s.auditLogs.action, "expense.approveDisburse")),
    ).toHaveLength(1);
    const completedOut = await db()
      .select()
      .from(s.receipts)
      .where(
        and(
          eq(s.receipts.id, Number(request.receiptId)),
          eq(s.receipts.status, "COMPLETED"),
          eq(s.receipts.direction, "OUT"),
        ),
      );
    expect(completedOut).toHaveLength(1);
  });

  it("اعتماد مصروفين متزامنين لا يتجاوز رصيد خزينة يكفي واحداً", async () => {
    await fundTreasury("750000.00");
    const first = await pendingExpense();
    const second = await pendingExpense();
    const settled = await Promise.allSettled([
      approveExpense(first.expenseId, ownerA),
      approveExpense(second.expenseId, ownerB),
    ]);
    expect(
      settled.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      settled.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const expenseRows = await db().select().from(s.expenses);
    expect(expenseRows.filter((row) => row.status === "ACTIVE")).toHaveLength(
      1,
    );
    expect(
      expenseRows.filter((row) => row.status === "PENDING_APPROVAL"),
    ).toHaveLength(1);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
  });

  it("سباق الاعتماد والرفض ينتهي بحالة طرفية واحدة متماسكة", async () => {
    await fundTreasury("750000.00");
    const request = await pendingExpense();
    const settled = await Promise.allSettled([
      approveExpense(request.expenseId, ownerA),
      rejectExpense(request.expenseId, ownerB, "المستند غير مؤيد"),
    ]);
    expect(
      settled.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      settled.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const [expense] = await db()
      .select()
      .from(s.expenses)
      .where(eq(s.expenses.id, request.expenseId));
    const [receipt] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, Number(request.receiptId)));
    const entries = await db().select().from(s.accountingEntries);
    if (expense.status === "ACTIVE") {
      expect(receipt).toMatchObject({
        status: "COMPLETED",
        approvalStatus: "APPROVED",
      });
      expect(entries).toHaveLength(1);
    } else {
      expect(expense.status).toBe("REJECTED");
      expect(receipt).toMatchObject({
        status: "FAILED",
        approvalStatus: "REJECTED",
      });
      expect(entries).toHaveLength(0);
    }
    expect(await db().select().from(s.auditLogs)).toHaveLength(1);
  });

  it("إلغاء مصروف خزينة واعتماد OUT متزامن يتمان بلا deadlock", async () => {
    await fundTreasury("1000000.00");
    const activeRequest = await pendingExpense();
    await approveExpense(activeRequest.expenseId, ownerA);
    const waitingRequest = await pendingExpense();

    const settled = await Promise.allSettled([
      // نفس المالك في الاتصالين: approve يأخذ owner SHARE ثم source، والإلغاء
      // يأخذ source ثم يحتاج FK SHARE على المستخدم نفسه. SHARE يمنع دورة user↔source.
      cancelExpense(activeRequest.expenseId, ownerA),
      approveExpense(waitingRequest.expenseId, ownerA),
    ]);
    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    const rows = await db().select().from(s.expenses);
    expect(
      rows.find((row) => Number(row.id) === activeRequest.expenseId)?.status,
    ).toBe("CANCELLED");
    expect(
      rows.find((row) => Number(row.id) === waitingRequest.expenseId)?.status,
    ).toBe("ACTIVE");
  });

  it("المجاميع والتقرير المالي يستبعدان المعلّق والمرفوض", async () => {
    const pending = await pendingExpense("500000.00");
    const rejected = await pendingExpense("600000.00", "TRANSFER");
    await rejectExpense(rejected.expenseId, ownerA, "المستند غير مكتمل");

    const rejectedReceipt = (
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.id, Number(rejected.receiptId)))
    )[0];
    expect(rejectedReceipt).toMatchObject({
      status: "FAILED",
      approvalStatus: "REJECTED",
      cashBucket: null,
      shiftId: null,
    });
    const [rejectAudit] = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.action, "expense.reject"));
    expect(rejectAudit.newValue).toMatchObject({
      rejectionReason: "المستند غير مكتمل",
    });

    const list = await listExpenses({ branchId: 1 });
    expect(list.totals.active).toBe("0.00");
    expect(list.totals.pendingApproval).toBe("500000.00");
    expect(list.totals.rejected).toBe("600000.00");
    expect(
      list.rows.find((row) => Number(row.id) === pending.expenseId)?.needsAudit,
    ).toBe(false);
    expect(
      list.rows.find((row) => Number(row.id) === rejected.expenseId)
        ?.needsAudit,
    ).toBe(false);

    const report = await getExpensesReport({
      from: toDateStr(),
      to: toDateStr(),
      branchId: 1,
    });
    expect(report.total).toBe("0.00");
    expect(report.byCategory).toHaveLength(0);
    expect(report.byPayee).toHaveLength(0);
  });

  it("طلب المصروف يظهر كنوع مستقل للمالك ولا يتسرّب كسند عام", async () => {
    const request = await pendingExpense();
    const caller = appRouter.createCaller({
      req: { headers: {} },
      res: {},
      sessionId: null,
      platformAdmin: null,
      user: {
        id: ownerA.userId,
        openId: "expense-owner-a",
        name: "المالك أ",
        role: "admin",
        branchId: 1,
        isActive: true,
        isOwner: true,
      },
    } as unknown as TrpcContext);

    const selfRequest = await createExpense(
      {
        branchId: 1,
        category: "RENT",
        amount: "600000.00",
        paymentMethod: "TRANSFER",
        description: "طلب أحدث أنشأه المالك نفسه",
      },
      ownerA,
    );
    await db()
      .update(s.expenses)
      .set({ createdAt: new Date(Date.now() + 60_000) })
      .where(eq(s.expenses.id, selfRequest.expenseId));
    const driftedRequest = await pendingExpense("700000.00", "TRANSFER");
    await db()
      .update(s.receipts)
      .set({ direction: "IN" })
      .where(eq(s.receipts.id, Number(driftedRequest.receiptId)));

    const inbox = await caller.superApp.approvalInbox({ limit: 1, offset: 0 });
    expect(
      inbox.some(
        (item) =>
          item.kind === "voucher" &&
          Number(item.id) === Number(request.receiptId),
      ),
    ).toBe(false);
    expect(
      inbox.some(
        (item) =>
          item.kind === "expense" && Number(item.id) === request.expenseId,
      ),
    ).toBe(true);
    expect(
      inbox.some(
        (item) =>
          item.kind === "expense" &&
          (Number(item.id) === selfRequest.expenseId ||
            Number(item.id) === driftedRequest.expenseId),
      ),
    ).toBe(false);
    const pulse = await caller.superApp.modulePulse({ moduleKey: "treasury" });
    expect(
      pulse.metrics.find((metric) => metric.key === "expense-approvals")?.value,
    ).toBe(1);
    await expect(
      caller.superApp.approvalDetail({
        kind: "expense",
        id: request.expenseId,
      }),
    ).resolves.toMatchObject({
      kind: "expense",
      id: request.expenseId,
      capabilities: { canApprove: true, rejectionReason: "required" },
    });
    await expect(
      caller.superApp.approvalDetail({
        kind: "voucher",
        id: Number(request.receiptId),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.superApp.approvalDetail({
        kind: "expense",
        id: driftedRequest.expenseId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
