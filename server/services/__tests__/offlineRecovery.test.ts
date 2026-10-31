import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auditService from "../auditService";
import * as saleService from "../sale/create";
import * as returnReplay from "../offline/replayReturn";
import * as returnService from "../returnService";
import {
  replayOfflineSale,
  type ReplayOfflineSaleInput,
} from "../offline/replaySale";
import {
  discardRecoveryItem,
  listRecoveryQueue,
  postRecoveryItem,
} from "../offline/recovery";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

/**
 * المسار و-٤ من ورقة الإصلاحات (١٦/٨): «بيعٌ أوفلاينيّ محتجَز خارج الدفتر».
 *
 * الزبون دفع نقداً والبضاعة خرجت من الرفّ، ثم وصل البيع بعد إغلاق الوردية فرفضه الخادم
 * ولم يكتب شيئاً — والعنصر بقي في طابور الجهاز وحده. مسحُ بيانات المتصفّح = ضياع الإيراد
 * والمخزون والنقد نهائياً، بلا أن يعلم أحد.
 *
 * الثابت المطلوب: **الرفض يُوثَّق خادمياً لحظته**، ويبقى للمدير مسارُ ترحيلٍ مُدقَّق.
 */

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function makeCtx(user: any) {
  return {
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    user,
  } as any;
}

const CASHIER = 41;
const MANAGER = 42;

async function user(id: number) {
  return (
    await db().select().from(s.users).where(eq(s.users.id, id)).limit(1)
  )[0];
}

function saleInput(over: Record<string, unknown> = {}) {
  return {
    branchId: 1,
    lines: [
      {
        variantId: 1,
        productUnitId: 1,
        quantity: "1",
        unitPriceOverride: "1000",
      },
    ],
    payment: { amount: "1000", method: "CASH" as const },
    clientRequestId: "offline-recovery-1",
    capturedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    offlineReceiptNumber: "OFF-1-dev1-1",
    deviceId: "dev1",
    shiftId: 1,
    ...over,
  };
}

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "offlineRecoveryItems",
    "auditLogs",
    "accountingEntries",
    "receipts",
    "invoiceItems",
    "invoices",
    "inventoryMovements",
    "branchStock",
    "productUnits",
    "productVariants",
    "products",
    "shifts",
    "users",
    "branches",
  ]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d
    .insert(s.branches)
    .values({ id: 1, name: "Main", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    {
      id: CASHIER,
      openId: "or-cashier",
      name: "كاشير",
      role: "cashier",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: MANAGER,
      openId: "or-manager",
      name: "مدير",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
  ]);
  await d.insert(s.products).values({ id: 1, name: "قلم", categoryId: null });
  await d
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "PEN", costPrice: "500" });
  await d.insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: 1,
    isBaseUnit: true,
  });
  await d
    .insert(s.branchStock)
    .values({ variantId: 1, branchId: 1, quantity: 50 });
  // وردية **مغلقة**: هي بالضبط الحالة التي كانت تبتلع البيع.
  await d.insert(s.shifts).values({
    id: 1,
    branchId: 1,
    userId: CASHIER,
    openingBalance: "0",
    status: "CLOSED",
    closedAt: new Date(),
  });
});

const reviewer = { userId: MANAGER, branchId: 1, role: "manager" };
async function recoveryFixture(kind: "SALE" | "RETURN") {
  await db().insert(s.shifts).values({
    id: 2,
    branchId: 1,
    userId: MANAGER,
    openingBalance: "10000",
    status: "OPEN",
    shiftType: "RETAIL",
  });
  await db()
    .update(s.users)
    .set({ isOwner: true })
    .where(eq(s.users.id, MANAGER));
  const payload =
    kind === "SALE"
      ? saleInput()
      : await (async () => {
          const sale = await saleService.createSale(
            {
              branchId: 1,
              shiftId: 2,
              sourceType: "POS",
              lines: saleInput().lines,
              payment: { amount: "1000", method: "CASH" },
            },
            reviewer,
          );
          const [line] = await db()
            .select()
            .from(s.invoiceItems)
            .where(eq(s.invoiceItems.invoiceId, sale.invoiceId));
          return {
            invoiceId: sale.invoiceId,
            lines: [{ invoiceItemId: Number(line.id), baseQuantity: 1 }],
            refund: { amount: "1000", method: "CASH" as const, shiftId: 1 },
            restock: true,
            reason: "إعادة بضاعة أثناء الانقطاع",
            clientRequestId: "atomic-return",
            capturedAt: new Date().toISOString(),
            offlineReceiptNumber: "OFF-atomic-return",
          };
        })();
  const [insert] = await db()
    .insert(s.offlineRecoveryItems)
    .values({
      branchId: 1,
      clientRequestId: payload.clientRequestId,
      offlineReceiptNumber: payload.offlineReceiptNumber,
      payload: JSON.stringify(payload),
      capturedAt: new Date(payload.capturedAt),
      rejectCode: "PRECONDITION_FAILED",
      submittedByUserId: CASHIER,
      channel: kind === "SALE" ? "RETAIL" : "RETURN",
    });
  return { id: Number(insert.insertId), ctx: makeCtx(await user(MANAGER)) };
}
async function effects() {
  return {
    invoices: await db().select().from(s.invoices),
    entries: await db().select().from(s.accountingEntries),
    receipts: await db().select().from(s.receipts),
    movements: await db().select().from(s.inventoryMovements),
    stock: await db().select().from(s.branchStock),
    keys: await db().select().from(s.idempotencyKeys),
  };
}

function transactionBarrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { enter, entered, held, release };
}

// Observe an actual InnoDB lock wait, not a timer that can pass on a slow host.
async function lockWaitOrSettlement(isSettled: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!isSettled()) {
    const [rows] = await db().execute(sql`
      SELECT 1 FROM performance_schema.data_lock_waits w
      JOIN performance_schema.data_locks l
        ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
      WHERE l.OBJECT_SCHEMA = DATABASE()
        AND l.OBJECT_NAME = 'monthCloseSequence' LIMIT 1
    `);
    if ((rows as unknown as unknown[]).length) return "waiting";
    if (Date.now() > deadline)
      throw new Error("No transaction lock wait or settlement observed");
  }
  return "settled";
}

async function insufficientCashReturnFixture() {
  const initial = await recoveryFixture("RETURN");
  const [captured] = await db()
    .select()
    .from(s.offlineRecoveryItems)
    .where(eq(s.offlineRecoveryItems.id, initial.id));
  const payload = JSON.parse(
    captured.payload,
  ) as returnReplay.ReplayOfflineReturnInput;
  await db()
    .delete(s.offlineRecoveryItems)
    .where(eq(s.offlineRecoveryItems.id, initial.id));
  await db()
    .update(s.shifts)
    .set({ status: "OPEN", userId: MANAGER })
    .where(eq(s.shifts.id, 1));
  const before = await effects();
  const caller = appRouter.createCaller(initial.ctx);
  await expect(
    caller.offline.replayReturn({
      ...payload,
      branchId: 1,
      refund: { ...payload.refund, shiftId: 1 },
      deviceId: undefined,
    }),
  ).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
    message: expect.stringContaining("رصيد الدرج المتاح"),
  });
  expect(await effects()).toEqual(before);
  const [item] = await db().select().from(s.offlineRecoveryItems);
  expect(item).toMatchObject({
    channel: "RETURN",
    recoveryStatus: "PENDING",
    clientRequestId: payload.clientRequestId,
  });
  // Replenish the original drawer through a real cash sale with its receipt/ledger.
  await saleService.createSale(
    {
      branchId: 1,
      shiftId: 1,
      sourceType: "POS",
      lines: saleInput().lines,
      payment: { amount: "1000", method: "CASH" },
    },
    reviewer,
  );
  return { id: Number(item.id), ctx: initial.ctx, payload };
}

describe("standalone RETURN replay versus recovery discard", () => {
  it("discard wins before a standalone replay can commit the previously cash-rejected refund", async () => {
    const { id, ctx, payload } = await insufficientCashReturnFixture();
    const before = await effects();
    const barrier = transactionBarrier();
    const original = auditService.logAuditTx;
    const audit = vi
      .spyOn(auditService, "logAuditTx")
      .mockImplementationOnce(async (...args) => {
        barrier.enter();
        await barrier.held;
        return original(...args);
      });
    const discard = discardRecoveryItem(id, "test receipt", reviewer, ctx);
    await barrier.entered;
    let settled = false;
    const replay = returnReplay
      .replayOfflineReturn(payload, reviewer)
      .then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      )
      .finally(() => {
        settled = true;
      });
    let observed: string;
    try {
      observed = await lockWaitOrSettlement(() => settled);
    } finally {
      barrier.release();
      audit.mockRestore();
      await discard;
      await replay;
    }
    expect(observed).toBe("waiting");
    expect((await replay).error).toMatchObject({ code: "CONFLICT" });
    expect(await effects()).toEqual(before);
    expect((await db().select().from(s.offlineRecoveryItems))[0]).toMatchObject(
      {
        recoveryStatus: "DISCARDED",
        invoiceId: null,
      },
    );
  });

  it("standalone replay wins and discard observes its committed original result", async () => {
    const { id, ctx, payload } = await insufficientCashReturnFixture();
    const barrier = transactionBarrier();
    const original = returnService.returnSaleInTx;
    const domain = vi
      .spyOn(returnService, "returnSaleInTx")
      .mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        barrier.enter();
        await barrier.held;
        return result;
      });
    const replay = returnReplay.replayOfflineReturn(payload, reviewer);
    await barrier.entered;
    let settled = false;
    const discard = discardRecoveryItem(id, "test receipt", reviewer, ctx)
      .then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      )
      .finally(() => {
        settled = true;
      });
    let observed: string;
    try {
      observed = await lockWaitOrSettlement(() => settled);
    } finally {
      barrier.release();
      domain.mockRestore();
      await replay;
      await discard;
    }
    expect(observed).toBe("waiting");
    expect((await discard).error).toMatchObject({ code: "CONFLICT" });
    expect((await db().select().from(s.offlineRecoveryItems))[0]).toMatchObject(
      {
        recoveryStatus: "PENDING",
        invoiceId: null,
      },
    );
    const committed = await effects();
    expect(
      committed.receipts.filter((row) => row.direction === "OUT"),
    ).toHaveLength(1);
    expect(await postRecoveryItem(id, 2, reviewer, ctx)).toMatchObject({
      invoiceId: payload.invoiceId,
    });
    expect(await effects()).toEqual(committed);
  });

  it("a committed discard cannot be bypassed by a later standalone original replay", async () => {
    const { id, ctx, payload } = await insufficientCashReturnFixture();
    await discardRecoveryItem(id, "test receipt", reviewer, ctx);
    const before = await effects();
    await expect(
      returnReplay.replayOfflineReturn(payload, reviewer),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await effects()).toEqual(before);
  });
});

it("standalone SALE replay respects a committed discard without cash, stock or notification effects", async () => {
  const { id, ctx } = await recoveryFixture("SALE");
  await discardRecoveryItem(id, "test receipt", reviewer, ctx);
  await db().update(s.shifts).set({ status: "OPEN" }).where(eq(s.shifts.id, 1));
  const before = await effects();
  const notify = vi.spyOn(saleService, "notifySaleCustomerAfterCommit");
  try {
    await expect(
      replayOfflineSale(saleInput(), {
        userId: CASHIER,
        branchId: 1,
        role: "cashier",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(notify).not.toHaveBeenCalled();
  } finally {
    notify.mockRestore();
  }
  expect(await effects()).toEqual(before);
});

describe.each(["SALE", "RETURN"] as const)("atomic recovery %s", (kind) => {
  it("keeps legacy original results without a stored full hash for evidence review", async () => {
    const { id, ctx } = await recoveryFixture(kind);
    const [row] = await db()
      .select()
      .from(s.offlineRecoveryItems)
      .where(eq(s.offlineRecoveryItems.id, id));
    await db()
      .update(s.shifts)
      .set({
        status: "OPEN",
        openingBalance: "10000",
        userId: kind === "SALE" ? CASHIER : MANAGER,
      })
      .where(eq(s.shifts.id, 1));
    if (kind === "SALE")
      await replayOfflineSale(
        JSON.parse(row.payload) as ReplayOfflineSaleInput,
        { userId: CASHIER, branchId: 1, role: "cashier" },
      );
    else
      await returnReplay.replayOfflineReturn(
        JSON.parse(row.payload) as returnReplay.ReplayOfflineReturnInput,
        reviewer,
      );
    await db()
      .update(s.idempotencyKeys)
      .set({ payloadHash: null })
      .where(eq(s.idempotencyKeys.clientRequestId, row.clientRequestId));
    const before = await effects();
    await expect(
      discardRecoveryItem(id, "test receipt", reviewer, ctx),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(postRecoveryItem(id, 2, reviewer, ctx)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await effects()).toEqual(before);
    expect((await listRecoveryQueue(reviewer)).map((row) => row.id)).toContain(
      id,
    );
  });
  it("resolves original offline commit before validating a replacement drawer", async () => {
    const { id, ctx } = await recoveryFixture(kind);
    const [row] = await db()
      .select()
      .from(s.offlineRecoveryItems)
      .where(eq(s.offlineRecoveryItems.id, id));
    await db()
      .update(s.shifts)
      .set({
        status: "OPEN",
        openingBalance: "10000",
        userId: kind === "SALE" ? CASHIER : MANAGER,
      })
      .where(eq(s.shifts.id, 1));
    let originalInvoiceId: number;
    if (kind === "SALE") {
      const original = await replayOfflineSale(
        JSON.parse(row.payload) as ReplayOfflineSaleInput,
        { userId: CASHIER, branchId: 1, role: "cashier" },
      );
      originalInvoiceId = original.invoiceId;
    } else {
      const payload = JSON.parse(
        row.payload,
      ) as returnReplay.ReplayOfflineReturnInput;
      await returnReplay.replayOfflineReturn(payload, reviewer);
      originalInvoiceId = payload.invoiceId;
    }
    // Original response was lost; choose a different currently open drawer.
    await db()
      .update(s.shifts)
      .set({ status: "CLOSED" })
      .where(eq(s.shifts.id, 1));
    const before = await effects();
    await expect(
      discardRecoveryItem(id, "test receipt", reviewer, ctx),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await postRecoveryItem(id, 2, reviewer, ctx)).toMatchObject({
      invoiceId: originalInvoiceId,
    });
    expect(await effects()).toEqual(before);
    const [saved] = await db()
      .select()
      .from(s.offlineRecoveryItems)
      .where(eq(s.offlineRecoveryItems.id, id));
    expect(saved).toMatchObject({
      recoveryStatus: "POSTED",
      invoiceId: originalInvoiceId,
    });
  });
  it("abort before replay leaves a visible retryable row and no effects", async () => {
    const { id, ctx } = await recoveryFixture(kind);
    const before = await effects();
    const fault =
      kind === "SALE"
        ? vi
            .spyOn(saleService, "createSaleInTx")
            .mockRejectedValueOnce(new Error("before replay"))
        : vi
            .spyOn(returnReplay, "replayOfflineReturnInTx")
            .mockRejectedValueOnce(new Error("before replay"));
    try {
      await expect(postRecoveryItem(id, 2, reviewer, ctx)).rejects.toThrow(
        "before replay",
      );
    } finally {
      fault.mockRestore();
    }
    expect(await effects()).toEqual(before);
    expect((await listRecoveryQueue(reviewer)).map((row) => row.id)).toContain(
      id,
    );
    await postRecoveryItem(id, 2, reviewer, ctx);
  });

  it("abort after real domain work rolls back all effects and never notifies", async () => {
    const { id, ctx } = await recoveryFixture(kind);
    const before = await effects();
    const notify = vi.spyOn(saleService, "notifySaleCustomerAfterCommit");
    const fault = vi
      .spyOn(auditService, "logAuditTx")
      .mockRejectedValueOnce(new Error("after domain work"));
    try {
      await expect(postRecoveryItem(id, 2, reviewer, ctx)).rejects.toThrow(
        "after domain work",
      );
    } finally {
      fault.mockRestore();
    }
    expect(notify).not.toHaveBeenCalled();
    notify.mockRestore();
    expect(await effects()).toEqual(before);
    expect((await listRecoveryQueue(reviewer)).map((row) => row.id)).toContain(
      id,
    );
    const first = await postRecoveryItem(id, 2, reviewer, ctx);
    const committed = await effects();
    await db()
      .update(s.shifts)
      .set({ status: "CLOSED" })
      .where(eq(s.shifts.id, 2));
    expect(await postRecoveryItem(id, 1, reviewer, ctx)).toEqual(first);
    expect(await effects()).toEqual(committed);
    await expect(
      discardRecoveryItem(id, "test receipt", reviewer, ctx),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it.each(["post", "discard"] as const)(
    "serializes a competing %s behind real uncommitted domain work",
    async (operation) => {
      const { id, ctx } = await recoveryFixture(kind);
      const original = auditService.logAuditTx;
      let entered!: () => void;
      let release!: () => void;
      const atAudit = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const audit = vi
        .spyOn(auditService, "logAuditTx")
        .mockImplementationOnce(async (...args) => {
          entered();
          await barrier;
          return original(...args);
        });
      const first = postRecoveryItem(id, 2, reviewer, ctx);
      await atAudit;
      let settled = false;
      const second = (
        operation === "post"
          ? postRecoveryItem(id, 2, reviewer, ctx)
          : discardRecoveryItem(id, "test receipt", reviewer, ctx)
      )
        .then(
          (value) => ({ value, error: null }),
          (error) => ({ value: null, error }),
        )
        .finally(() => {
          settled = true;
        });
      try {
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(settled).toBe(false);
        expect(
          (await listRecoveryQueue(reviewer)).map((row) => row.id),
        ).toContain(id);
      } finally {
        release();
        audit.mockRestore();
      }
      const result = await first;
      const competing = await second;
      if (operation === "post") expect(competing.value).toEqual(result);
      else expect(competing.error).toMatchObject({ code: "CONFLICT" });
      const [row] = await db()
        .select()
        .from(s.offlineRecoveryItems)
        .where(eq(s.offlineRecoveryItems.id, id));
      expect(row).toMatchObject({
        recoveryStatus: "POSTED",
        invoiceId: result.invoiceId,
      });
      const actual = await effects();
      expect(actual.invoices).toHaveLength(1);
      expect(actual.receipts).toHaveLength(kind === "SALE" ? 1 : 2);
      expect(actual.stock[0].quantity).toBe(kind === "SALE" ? 49 : 50);
    },
  );

  it("closed drawer and wrong branch fail without consuming the queue", async () => {
    const { id, ctx } = await recoveryFixture(kind);
    const before = await effects();
    await expect(postRecoveryItem(id, 1, reviewer, ctx)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      postRecoveryItem(id, 2, { ...reviewer, branchId: 2 }, ctx),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await effects()).toEqual(before);
    expect((await listRecoveryQueue(reviewer)).map((row) => row.id)).toContain(
      id,
    );
  });
});

it("proves omitted original approval metadata by full hash and preserves original seller", async () => {
  const { id, ctx } = await recoveryFixture("SALE");
  const [row] = await db()
    .select()
    .from(s.offlineRecoveryItems)
    .where(eq(s.offlineRecoveryItems.id, id));
  const payload = JSON.parse(row.payload) as ReplayOfflineSaleInput;
  await db()
    .update(s.shifts)
    .set({ status: "OPEN", userId: MANAGER })
    .where(eq(s.shifts.id, 1));
  const original = await replayOfflineSale(
    { ...payload, priceOverrideApproved: true },
    reviewer,
  );
  await db()
    .update(s.shifts)
    .set({ status: "CLOSED" })
    .where(eq(s.shifts.id, 1));
  const before = await effects();
  await db()
    .update(s.offlineRecoveryItems)
    .set({
      payload: JSON.stringify({
        ...payload,
        payment: { ...payload.payment, amount: "999" },
      }),
    })
    .where(eq(s.offlineRecoveryItems.id, id));
  await expect(postRecoveryItem(id, 2, reviewer, ctx)).rejects.toMatchObject({
    code: "CONFLICT",
  });
  expect(await effects()).toEqual(before);
  await db()
    .update(s.offlineRecoveryItems)
    .set({ payload: row.payload })
    .where(eq(s.offlineRecoveryItems.id, id));
  expect(await postRecoveryItem(id, 2, reviewer, ctx)).toMatchObject({
    invoiceId: original.invoiceId,
  });
  expect(await effects()).toEqual(before);
  expect(before.invoices[0]).toMatchObject({ shiftId: 1, createdBy: MANAGER });
  const [audit] = (await db().select().from(s.auditLogs)).filter(
    (log) => log.action === "offline.recovery.post",
  );
  expect(audit.newValue).toMatchObject({ targetShiftId: 1 });
});

it("legacy POSTED without linked result remains visible and requires evidence", async () => {
  const { id, ctx } = await recoveryFixture("SALE");
  await db()
    .update(s.offlineRecoveryItems)
    .set({ recoveryStatus: "POSTED" })
    .where(eq(s.offlineRecoveryItems.id, id));
  expect(await listRecoveryQueue(reviewer)).toEqual([
    expect.objectContaining({
      id,
      postable: false,
      rejectReason: expect.stringContaining("POSTED"),
    }),
  ]);
  await expect(postRecoveryItem(id, 2, reviewer, ctx)).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
  await expect(
    discardRecoveryItem(id, "test receipt", reviewer, ctx),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await db().select().from(s.invoices)).toHaveLength(0);
});

it.each(["owner", "cap", "cash"] as const)(
  "RETURN recovery preserves the %s rejection and visible queue",
  async (failure) => {
    const { id, ctx } = await recoveryFixture("RETURN");
    if (failure === "owner")
      await db()
        .update(s.users)
        .set({ isOwner: false })
        .where(eq(s.users.id, MANAGER));
    else {
      const [row] = await db()
        .select()
        .from(s.offlineRecoveryItems)
        .where(eq(s.offlineRecoveryItems.id, id));
      const payload = JSON.parse(
        row.payload,
      ) as returnReplay.ReplayOfflineReturnInput;
      if (failure === "cap") payload.refund.amount = "2000";
      else payload.refund.method = "CARD" as "CASH";
      await db()
        .update(s.offlineRecoveryItems)
        .set({ payload: JSON.stringify(payload) })
        .where(eq(s.offlineRecoveryItems.id, id));
    }
    const before = await effects();
    await expect(postRecoveryItem(id, 2, reviewer, ctx)).rejects.toThrow();
    expect(await effects()).toEqual(before);
    expect((await listRecoveryQueue(reviewer)).map((row) => row.id)).toContain(
      id,
    );
  },
);

it("rejects an unrelated existing sale fingerprint without changing its attribution", async () => {
  const { id, ctx } = await recoveryFixture("SALE");
  const first = await saleService.createSale(
    {
      ...saleInput(),
      shiftId: 2,
      sourceType: "POS",
      allowNegativeStock: true,
    },
    reviewer,
  );
  const before = await effects();
  await expect(postRecoveryItem(id, 2, reviewer, ctx)).rejects.toMatchObject({
    code: "CONFLICT",
  });
  expect(await effects()).toEqual(before);
  expect(before.invoices[0].id).toBe(first.invoiceId);
  expect(before.invoices[0].createdBy).toBe(MANAGER);
  expect((await listRecoveryQueue(reviewer)).map((row) => row.id)).toContain(
    id,
  );
});

describe("المسار و-٤ — استرداد البيع الأوفلاينيّ المحتجَز", () => {
  it("rolls back actual sale, cash and stock when recovery audit fails before commit", async () => {
    const cashier = appRouter.createCaller(makeCtx(await user(CASHIER)));
    await expect(cashier.offline.replaySale(saleInput())).rejects.toBeTruthy();
    await db().insert(s.shifts).values({
      id: 2,
      branchId: 1,
      userId: MANAGER,
      openingBalance: "0",
      status: "OPEN",
      shiftType: "RETAIL",
    });
    const manager = appRouter.createCaller(makeCtx(await user(MANAGER)));
    const [item] = await manager.offline.recoveryQueue();
    const audit = vi
      .spyOn(auditService, "logAuditTx")
      .mockRejectedValueOnce(new Error("injected precommit fault"));
    try {
      await expect(
        manager.offline.postRecoveryItem({ id: item.id, targetShiftId: 2 }),
      ).rejects.toThrow("injected precommit fault");
    } finally {
      audit.mockRestore();
    }
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(50);
    expect(
      (await manager.offline.recoveryQueue()).map((row) => row.id),
    ).toContain(item.id);
    await manager.offline.postRecoveryItem({ id: item.id, targetShiftId: 2 });
    expect(await db().select().from(s.invoices)).toHaveLength(1);
  });
  it("الرفض لوردية مغلقة يُوثَّق خادمياً بدل أن يضيع على الجهاز", async () => {
    const cashier = appRouter.createCaller(makeCtx(await user(CASHIER)));
    await expect(cashier.offline.replaySale(saleInput())).rejects.toMatchObject(
      {
        code: "PRECONDITION_FAILED",
      },
    );

    // الثابت: لا فاتورة (الإقفال حدٌّ محاسبيّ) — **لكن** العنصر محفوظٌ خادمياً.
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    const parked = await db().select().from(s.offlineRecoveryItems);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      offlineReceiptNumber: "OFF-1-dev1-1",
      recoveryStatus: "PENDING",
      branchId: 1,
    });
  });

  it("إعادة محاولة الجهاز لا تُضاعف العنصر", async () => {
    const cashier = appRouter.createCaller(makeCtx(await user(CASHIER)));
    for (let i = 0; i < 3; i++) {
      await expect(
        cashier.offline.replaySale(saleInput()),
      ).rejects.toBeTruthy();
    }
    expect(await db().select().from(s.offlineRecoveryItems)).toHaveLength(1);
  });

  it("المدير يرى الطابور ويُرحّل العنصر إلى وردية مفتوحة فيدخل الدفتر", async () => {
    const cashier = appRouter.createCaller(makeCtx(await user(CASHIER)));
    await expect(cashier.offline.replaySale(saleInput())).rejects.toBeTruthy();

    await db().insert(s.shifts).values({
      id: 2,
      branchId: 1,
      userId: MANAGER,
      openingBalance: "0",
      status: "OPEN",
      shiftType: "RETAIL",
    });

    const manager = appRouter.createCaller(makeCtx(await user(MANAGER)));
    const queue = await manager.offline.recoveryQueue();
    expect(queue).toHaveLength(1);

    const posted = await manager.offline.postRecoveryItem({
      id: queue[0].id,
      targetShiftId: 2,
    });
    expect(posted.invoiceId).toBeGreaterThan(0);

    const invoices = await db().select().from(s.invoices);
    expect(invoices).toHaveLength(1);
    // الرقم الأوفلاينيّ المطبوع للزبون يبقى مربوطاً بالفاتورة (رابط الاحتجاز بالدفتر).
    expect(invoices[0].offlineReceiptNumber).toBe("OFF-1-dev1-1");

    const row = (await db().select().from(s.offlineRecoveryItems))[0];
    expect(row.recoveryStatus).toBe("POSTED");
    expect(Number(row.invoiceId)).toBe(Number(invoices[0].id));
  });

  it("الفاتورة تُنسَب للكاشير الملتقِط لا للمدير المُراجِع (وعاء العمولة)", async () => {
    const cashier = appRouter.createCaller(makeCtx(await user(CASHIER)));
    await expect(cashier.offline.replaySale(saleInput())).rejects.toBeTruthy();
    await db().insert(s.shifts).values({
      id: 2,
      branchId: 1,
      userId: MANAGER,
      openingBalance: "0",
      status: "OPEN",
      shiftType: "RETAIL",
    });
    const manager = appRouter.createCaller(makeCtx(await user(MANAGER)));
    const queue = await manager.offline.recoveryQueue();
    const posted = await manager.offline.postRecoveryItem({
      id: queue[0].id,
      targetShiftId: 2,
    });

    const inv = (
      await db()
        .select()
        .from(s.invoices)
        .where(eq(s.invoices.id, posted.invoiceId))
    )[0];
    // محرّك العمولات ينسب بـcreatedBy ⇒ لولا الإعادة لتحوّلت عمولة الكاشير إلى المدير.
    expect(Number(inv.createdBy)).toBe(CASHIER);
    expect(inv.salespersonNameSnapshot).toBe("كاشير");
    const saleEntry = (
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.invoiceId, posted.invoiceId))
    ).find((entry) => entry.entryType === "SALE");
    expect(saleEntry).toMatchObject({
      createdBy: CASHIER,
      createdByNameSnapshot: "كاشير",
    });
  });

  it("لا يُرحَّل بيع التجزئة إلى وردية استقبال/طباعة", async () => {
    const cashier = appRouter.createCaller(makeCtx(await user(CASHIER)));
    await expect(cashier.offline.replaySale(saleInput())).rejects.toBeTruthy();
    await db().insert(s.shifts).values({
      id: 3,
      branchId: 1,
      userId: MANAGER,
      openingBalance: "0",
      status: "OPEN",
      shiftType: "RECEPTION",
    });
    const manager = appRouter.createCaller(makeCtx(await user(MANAGER)));
    const queue = await manager.offline.recoveryQueue();
    await expect(
      manager.offline.postRecoveryItem({ id: queue[0].id, targetShiftId: 3 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // ويبقى العنصر معلّقاً للمحاولة الصحيحة — لا يُستهلك بالرفض.
    expect(await manager.offline.recoveryQueue()).toHaveLength(1);
  });

  it("الكاشير لا يُرحّل ولا يرى الطابور", async () => {
    const cashier = appRouter.createCaller(makeCtx(await user(CASHIER)));
    await expect(cashier.offline.recoveryQueue()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("الترحيل مرّةً واحدة — إعادة الترحيل لا تُنشئ فاتورة ثانية", async () => {
    const cashier = appRouter.createCaller(makeCtx(await user(CASHIER)));
    await expect(cashier.offline.replaySale(saleInput())).rejects.toBeTruthy();
    await db().insert(s.shifts).values({
      id: 2,
      branchId: 1,
      userId: MANAGER,
      openingBalance: "0",
      status: "OPEN",
      shiftType: "RETAIL",
    });
    const manager = appRouter.createCaller(makeCtx(await user(MANAGER)));
    const queue = await manager.offline.recoveryQueue();
    const first = await manager.offline.postRecoveryItem({
      id: queue[0].id,
      targetShiftId: 2,
    });
    await db()
      .update(s.shifts)
      .set({ status: "CLOSED" })
      .where(eq(s.shifts.id, 2));
    expect(
      await manager.offline.postRecoveryItem({
        id: queue[0].id,
        targetShiftId: 1,
      }),
    ).toEqual(first);
    expect(await db().select().from(s.invoices)).toHaveLength(1);
  });

  it("الإهمال يتطلّب سبباً ويُكتب في التدقيق", async () => {
    const cashier = appRouter.createCaller(makeCtx(await user(CASHIER)));
    await expect(cashier.offline.replaySale(saleInput())).rejects.toBeTruthy();
    const manager = appRouter.createCaller(makeCtx(await user(MANAGER)));
    const queue = await manager.offline.recoveryQueue();

    await manager.offline.discardRecoveryItem({
      id: queue[0].id,
      reason: "إيصال تجريبيّ من جهاز الفحص",
    });
    const row = (await db().select().from(s.offlineRecoveryItems))[0];
    expect(row.recoveryStatus).toBe("DISCARDED");

    const logs = await db().select().from(s.auditLogs);
    expect(logs.some((l) => l.action === "offline.recovery.discard")).toBe(
      true,
    );
    expect(await db().select().from(s.invoices)).toHaveLength(0);
  });
});
