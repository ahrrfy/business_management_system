import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import {
  purchaseTenderSchema,
  type PurchaseTenderInput,
} from "@shared/purchaseTender";
import { appErrorMessage } from "@shared/errors";
import {
  accounts,
  purchaseOrderRevisions,
  shifts,
  suppliers,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { requireDb, type Actor } from "../tx";
import { assertPurchaseBranch } from "./internal";
import {
  listPurchasePriorPayments,
  readPurchasePriorPaymentEvidence,
} from "./priorPayment";
import { assertSupplierAdvanceInboundHistory } from "./advanceRefundEvidence";
import { money } from "../money";
import { sha256 } from "./grniAccounting";
import { openShiftIdTx } from "../shiftService";
import { isPurchaseTreasuryAllowedTx } from "./supplierPayments";

export function purchaseTenderError(what: string, why: string) {
  return new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what,
      why,
      doThis:
        "راجع طريقة السداد ومصدره في فاتورة الشراء ثم أعد إرسالها للاعتماد",
    }),
  });
}

export async function readPurchaseTenderTx(
  db: DB | Tx,
  purchaseOrderId: number,
  revisionId: number | null,
): Promise<PurchaseTenderInput | null> {
  if (revisionId == null) return null;
  const [revision] = await db
    .select({
      payload: purchaseOrderRevisions.payloadCanonical,
      hash: purchaseOrderRevisions.payloadHash,
    })
    .from(purchaseOrderRevisions)
    .where(
      and(
        eq(purchaseOrderRevisions.id, revisionId),
        eq(purchaseOrderRevisions.purchaseOrderId, purchaseOrderId),
      ),
    )
    .limit(1);
  if (!revision)
    throw purchaseTenderError(
      "تعذر قراءة طريقة سداد الفاتورة",
      "نسخة الفاتورة المحددة غير موجودة",
    );
  const raw = JSON.parse(revision.payload) as { tender?: unknown };
  if (raw.tender == null) return null;
  if (sha256(revision.payload) !== revision.hash) {
    throw purchaseTenderError(
      "تعذر التحقق من طريقة السداد",
      "بصمة نسخة الفاتورة لا تطابق بياناتها المحفوظة",
    );
  }
  const parsed = purchaseTenderSchema.safeParse(raw.tender);
  if (!parsed.success)
    throw purchaseTenderError(
      "تعذر قراءة طريقة السداد",
      "بيانات طريقة السداد المحفوظة غير صالحة",
    );
  return parsed.data;
}

export async function capturePurchaseTenderTx(
  tx: Tx,
  input: {
    tender?: PurchaseTenderInput | null;
    settlementType: string;
    supplierId: number;
    branchId: number;
    previous?: {
      id: number;
      currentRevisionId: number | null;
      createdBy: number | null;
      supplierId: number;
      settlementType: string;
    };
  },
  actor: Actor,
): Promise<PurchaseTenderInput | null> {
  const tender =
    input.tender === undefined && input.previous?.settlementType === "CASH"
      ? await readPurchaseTenderTx(
          tx,
          input.previous.id,
          input.previous.currentRevisionId,
        )
      : (input.tender ?? null);
  if (input.settlementType !== "CASH") {
    if (input.tender != null)
      throw purchaseTenderError(
        "تعذر حفظ طريقة سداد فورية لفاتورة آجلة",
        "الفاتورة الآجلة تسجل المبلغ على حساب المورد",
      );
    return null;
  }
  if (!tender) return null;
  if (tender.previousReceiptId != null) {
    const value = await readPurchasePriorPaymentEvidence(
      tx,
      tender.previousReceiptId,
      false,
    );
    if (
      value.native ||
      value.receipt.partyId !== input.supplierId ||
      value.receipt.branchId !== input.branchId ||
      !money(value.availableAmount).gt(0)
    ) {
      throw purchaseTenderError(
        "تعذر ربط الدفعة السابقة",
        "الدفعة غير متاحة للتخصيص لهذا المورد والفرع",
      );
    }
    await assertSupplierAdvanceInboundHistory(
      tx,
      input.supplierId,
      input.branchId,
    );
  }
  let normalizedTender: PurchaseTenderInput = tender;
  if (normalizedTender.mode === "CARD") {
    await assertPurchaseCardAccountTx(tx, normalizedTender.accountId);
  } else if (normalizedTender.mode === "TREASURY") {
    const prevTender =
      input.previous && input.previous.settlementType === "CASH"
        ? await readPurchaseTenderTx(
            tx,
            input.previous.id,
            input.previous.currentRevisionId,
          )
        : null;
    if (
      prevTender?.mode !== "TREASURY" &&
      !(await isPurchaseTreasuryAllowedTx(tx, actor))
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذر اختيار الخزينة الرئيسية لسداد الشراء",
          why: "اختيار الخزينة يتطلب صلاحية الخزينة الكاملة أو حساب مالك نشط",
          doThis:
            "اختر درج ورديتك المفتوحة أو اطلب من مخول الخزينة حفظ مصدر السداد",
        }),
      });
    }
  } else if (normalizedTender.mode === "DRAWER") {
    const creatorId = Number(input.previous?.createdBy ?? actor.userId);
    let resolvedShiftId: number | undefined = normalizedTender.shiftId;
    if (resolvedShiftId == null) {
      const openId = await openShiftIdTx(tx, creatorId, input.branchId);
      if (openId != null) {
        resolvedShiftId = openId;
      } else if (normalizedTender.previousReceiptId == null) {
        throw purchaseTenderError(
          "تعذر اختيار وردية السداد",
          "لا توجد وردية مفتوحة لمنشئ الفاتورة في الفرع المحدد",
        );
      }
    }
    if (resolvedShiftId != null) {
      const [shift] = await tx
        .select()
        .from(shifts)
        .where(eq(shifts.id, resolvedShiftId))
        .limit(1);
      if (!shift) {
        throw purchaseTenderError(
          "تعذر اختيار وردية السداد",
          "الوردية المحددة غير موجودة",
        );
      }
      if (Number(shift.userId) !== creatorId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذر اختيار وردية السداد",
            why: "درج السداد في فاتورة الشراء النقدية يجب أن يخص منشئ الأمر حصراً",
            doThis: "اختر وردية المنشئ المفتوحة أو الخزينة الرئيسية وفق صلاحياتها",
          }),
        });
      }
      if (shift.status !== "OPEN" || Number(shift.branchId) !== input.branchId) {
        throw purchaseTenderError(
          "تعذر اختيار وردية السداد",
          "الوردية ليست مفتوحة لمنشئ الفاتورة في الفرع المحدد",
        );
      }
      normalizedTender = { ...normalizedTender, shiftId: Number(shift.id) };
    }
  }
  return purchaseTenderSchema.parse(normalizedTender);
}

export async function assertPurchaseCardAccountTx(
  db: DB | Tx,
  accountId: number,
) {
  const [account] = await db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(
      and(
        eq(accounts.id, accountId),
        eq(accounts.systemRole, "CARD_BANK"),
        eq(accounts.isActive, true),
      ),
    )
    .for("share")
    .limit(1);
  if (!account)
    throw purchaseTenderError(
      "تعذر السداد ببطاقة الشركة",
      "الحساب المحدد ليس حساب البطاقة والبنك الفعال في دليل الحسابات",
    );
  return account;
}

export async function listPurchaseTenderSources(
  input: { supplierId: number; branchId: number },
  actor: Actor,
) {
  assertPurchaseBranch(input, actor);
  const db = requireDb();
  const [supplier] = await db
    .select({ id: suppliers.id, kind: suppliers.supplierKind })
    .from(suppliers)
    .where(eq(suppliers.id, input.supplierId))
    .limit(1);
  if (!supplier || supplier.kind === "CONSIGNOR")
    throw purchaseTenderError(
      "تعذر تحميل مصادر السداد",
      "المورد المحدد غير صالح لفاتورة شراء",
    );
  const [cardAccount] = await db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(
      and(eq(accounts.systemRole, "CARD_BANK"), eq(accounts.isActive, true)),
    )
    .limit(1);
  const previousPayments = await listPurchasePriorPayments(db, input);
  return { cardAccount: cardAccount ?? null, previousPayments };
}
