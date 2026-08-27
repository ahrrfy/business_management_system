// مخزن القيود المزدوجة (P2 — الشريحة ٠، خطة docs/double-entry-p2-plan-2026-08-11.md).
//
// طبقةُ كتابةٍ رقيقةٌ فوق `journalEntries`/`journalLines` **لا تقرّر شيئاً**: الترجمة من حدثٍ ماليّ
// إلى أسطر مدين/دائن مسؤوليةُ `postingEngine` (وحدةٌ نقيّة)، وقرارُ الكتابة من عدمها مسؤوليةُ
// خطّاف الظلّ (الشريحة ١).
//
// **حدٌّ مقصود:** هذا المخزن **يرمي** عند الخلل (قيدٌ غير متوازن، ازدواج). ابتلاعُ الرمية مسؤوليةُ
// الخطّاف وحده — فهو الذي يعرف أنّه في وضع الظلّ وأنّ سلامة عملية الأعمال تسبق سلامة القيد.
// لو ابتلع المخزنُ الأخطاءَ لصار الخللُ غيرَ مرئيٍّ في وضع ACTIVE أيضاً، وهو ما لا يُقبَل.
import { eq, isNotNull } from "drizzle-orm";
import { accountingEntries, accounts, doubleEntrySettings, journalEntries, journalLines } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, round2 } from "../money";
import {
  ACCOUNT_ROLES,
  assertBalanced,
  type JournalLine,
  type JournalPostingProfile,
  POSTING_POLICY_HASH,
  type PostingProfile,
} from "./postingEngine";

const accountRoleSet: ReadonlySet<string> = new Set(ACCOUNT_ROLES);

/**
 * Tier-2 #5 (٢٦/٨): يبني خريطة `role → accountId` من `accounts.systemRole`.
 * استعلامٌ واحد لكل استدعاء كتابةِ يومية — رخيصٌ (جدولٌ صغير مفهرَس). صفوفٌ بلا
 * `systemRole` لا تدخل الخريطة (حسابٌ مخصّص) — الأسطر التي لا تُطابق تبقى بـ`accountId=null`
 * (الحقل nullable في المخطّط، والـFK يقبل NULL) وتُطبَع لاحقاً بحدثِ backfill عند تعديل
 * الحساب. لا انحدار على الكتابة القائمة.
 */
async function loadAccountIdByRole(tx: Tx): Promise<Map<string, number>> {
  const rows = await tx
    .select({ id: accounts.id, systemRole: accounts.systemRole })
    .from(accounts)
    .where(isNotNull(accounts.systemRole));
  const map = new Map<string, number>();
  for (const row of rows) {
    if (row.systemRole) map.set(row.systemRole, Number(row.id));
  }
  return map;
}

function assertValidLines(
  lines: readonly JournalLine[],
  context: string,
): void {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const debit = money(line.debit);
    const credit = money(line.credit);
    if (!accountRoleSet.has(line.role)) {
      throw new Error(`دور محاسبي غير معروف في ${context}، السطر ${index + 1}.`);
    }
    if (
      !debit.isFinite() ||
      !credit.isFinite() ||
      debit.isNegative() ||
      credit.isNegative() ||
      !debit.eq(round2(debit)) ||
      !credit.eq(round2(credit)) ||
      debit.isZero() === credit.isZero()
    ) {
      throw new Error(
        `سطر غير صالح في ${context}، السطر ${index + 1}: يجب أن يكون أحد الطرفين فقط موجباً وبدقتين عشريتين.`,
      );
    }
  }
}

export type DoubleEntryMode = "OFF" | "SHADOW" | "ACTIVE";

export interface DoubleEntryRuntime {
  mode: DoubleEntryMode;
  cycleId: string | null;
}

/**
 * وضع الدفتر المزدوج. **غياب صفّ الإعدادات ⇒ `OFF`** (فشلٌ آمن، بوّابة س٢): قاعدةٌ لم تُهيَّأ
 * بعد، أو صفٌّ حُذف، لا يجوز أن يُفعّل كتابةً لم يطلبها أحد.
 */
export async function getDoubleEntryRuntime(
  tx: Tx,
): Promise<DoubleEntryRuntime> {
  let row = (
    await tx
      .select({
        mode: doubleEntrySettings.mode,
        cycleId: doubleEntrySettings.shadowCycleId,
        openingHash: doubleEntrySettings.shadowOpeningHash,
        approvalReference: doubleEntrySettings.policyApprovalReference,
        approvalAccountant: doubleEntrySettings.policyAccountantName,
        approvalAt: doubleEntrySettings.policyApprovedAt,
        approvalBy: doubleEntrySettings.policyApprovedBy,
        approvalCycleId: doubleEntrySettings.policyApprovalCycleId,
        approvalOpeningHash: doubleEntrySettings.policyApprovalOpeningHash,
        approvalPolicyHash: doubleEntrySettings.policyApprovalPolicyHash,
      })
      .from(doubleEntrySettings)
      .where(eq(doubleEntrySettings.id, 1))
      // قفلٌ مشترك طوال معاملة الحدث المالي: كل الكتّاب يتوازون معاً، لكن انتقال الوضع (FOR UPDATE)
      // ينتظرهم قبل فحص بوابة ACTIVE. بدونه يستطيع حدثٌ جارٍ تسجيل فجوة بعد أن ترى البوابة صفراً.
      .for("share")
      .limit(1)
  )[0];
  if (!row) {
    // ثبّت صف singleton قبل تقرير OFF. من دون الصف لا يوجد شيء يمكن قفله،
    // وقد يسبقنا start بإدراجه بعد القراءة ويقسم الحدث حول لحظة القطع.
    await tx
      .insert(doubleEntrySettings)
      .values({ id: 1, mode: "OFF" })
      .onDuplicateKeyUpdate({ set: { id: 1 } });
    row = (
      await tx
        .select({
          mode: doubleEntrySettings.mode,
          cycleId: doubleEntrySettings.shadowCycleId,
          openingHash: doubleEntrySettings.shadowOpeningHash,
          approvalReference: doubleEntrySettings.policyApprovalReference,
          approvalAccountant: doubleEntrySettings.policyAccountantName,
          approvalAt: doubleEntrySettings.policyApprovedAt,
          approvalBy: doubleEntrySettings.policyApprovedBy,
          approvalCycleId: doubleEntrySettings.policyApprovalCycleId,
          approvalOpeningHash: doubleEntrySettings.policyApprovalOpeningHash,
          approvalPolicyHash: doubleEntrySettings.policyApprovalPolicyHash,
        })
        .from(doubleEntrySettings)
        .where(eq(doubleEntrySettings.id, 1))
        .for("share")
        .limit(1)
    )[0];
  }
  const mode = (row?.mode as DoubleEntryMode | undefined) ?? "OFF";
  const cycleId = row?.cycleId ?? null;
  if (
    mode === "ACTIVE" &&
    (!cycleId ||
      !row?.openingHash ||
      !row.approvalReference ||
      !row.approvalAccountant ||
      !row.approvalAt ||
      row.approvalBy == null ||
      row.approvalCycleId !== cycleId ||
      row.approvalOpeningHash !== row.openingHash ||
      row.approvalPolicyHash !== POSTING_POLICY_HASH)
  ) {
    throw new Error(
      "وضع ACTIVE غير صالح: اعتماد المحاسب لا يطابق الدورة/بصمة الافتتاح/سياسة الترحيل الحالية.",
    );
  }
  return { mode, cycleId };
}

export async function getDoubleEntryMode(tx: Tx): Promise<DoubleEntryMode> {
  return (await getDoubleEntryRuntime(tx)).mode;
}

interface JournalMetadata {
  cycleId?: string | null;
  postingProfile?: JournalPostingProfile | null;
}

interface ShadowOpeningJournalInput {
  cycleId: string;
  sourceKey: string;
  entryDate: Date;
  branchId: number | null;
  lines: readonly JournalLine[];
}

/**
 * يكتب قيداً مزدوجاً متوازناً لحدثٍ ماليّ. يرمي إن اختلّ التوازن (س٦) أو خلت الأسطر أو تكرّر
 * الحدث (`uq_journal_entry` — س٥). يستعمل **نفس المعاملة** المُمرَّرة ⇒ لا حالةَ جزئيةٌ ممكنة (س٤).
 */
export async function writeJournal(
  tx: Tx,
  entryId: number,
  entryDate: Date,
  branchId: number | null,
  lines: JournalLine[],
  metadata: JournalMetadata = {},
): Promise<void> {
  // رأسٌ POSTED بلا أسطر يُخفي مبلغاً عن ميزان المراجعة بصمت ⇒ خللٌ لا فجوة. استعمل
  // writeJournalGap للحالة المشروعة (نوعٌ غير مُخطَّط).
  if (lines.length === 0) {
    throw new Error(`قيدٌ مزدوجٌ بلا أسطر (الحدث ${entryId}) — استعمل writeJournalGap للفجوة.`);
  }
  assertValidLines(lines, `الحدث ${entryId}`);
  assertBalanced(lines, `الحدث ${entryId}`);

  const res = await tx.insert(journalEntries).values({
    entryId,
    cycleId: metadata.cycleId ?? null,
    postingProfile: metadata.postingProfile ?? null,
    entryDate,
    branchId,
    status: "POSTED",
  });
  const journalId = extractInsertId(res);

  const accountIdByRole = await loadAccountIdByRole(tx);
  // Tier-3 #2/#4 (٢٧/٨): أبعاد الطرف من رأس القيد المصدريّ `accountingEntries`. استعلامٌ
  // مفردٌ لكل كتابة — رخيصٌ (PK lookup). كل سطر يرث الأبعاد نفسها لأنّ الرأس هو المصدر.
  const [srcRow] = await tx
    .select({
      customerId: accountingEntries.customerId,
      supplierId: accountingEntries.supplierId,
      deliveryPartyId: accountingEntries.deliveryPartyId,
      exchangeHouseId: accountingEntries.exchangeHouseId,
      digitalWalletId: accountingEntries.digitalWalletId,
    })
    .from(accountingEntries)
    .where(eq(accountingEntries.id, entryId));
  const dims = {
    customerId: srcRow?.customerId ?? null,
    supplierId: srcRow?.supplierId ?? null,
    deliveryPartyId: srcRow?.deliveryPartyId ?? null,
    exchangeHouseId: srcRow?.exchangeHouseId ?? null,
    digitalWalletId: srcRow?.digitalWalletId ?? null,
  };
  await tx.insert(journalLines).values(
    lines.map((l) => ({
      journalId,
      role: l.role,
      accountId: accountIdByRole.get(l.role) ?? null,
      // Tier-2 #6: البعد التحليليّ على السطر يأخذ فرع الرأس افتراضياً — أدوات المستقبل
      // (تقسيمُ قيدٍ على فروع) قد تمرّر فرعاً لكل سطر إن دُعم في `JournalLine`.
      branchId,
      ...dims,
      debit: l.debit,
      credit: l.credit,
    })),
  );
}

/**
 * يثبت حدثاً تشغيلياً مقصوداً بلا أثر دفتري. وجود الرأس يمنع اعتباره قيداً مفقوداً، بينما
 * `MEMO` يمنعه من دخول ميزان المراجعة أو مجاميع المدين/الدائن.
 */
export async function writeJournalMemo(
  tx: Tx,
  entryId: number,
  entryDate: Date,
  branchId: number | null,
  cycleId: string,
  postingProfile: PostingProfile,
): Promise<void> {
  await tx.insert(journalEntries).values({
    entryId,
    cycleId,
    postingProfile,
    entryDate,
    branchId,
    status: "MEMO",
  });
}

/**
 * يكتب مجموعةً متوازنة من لقطة القطع الافتتاحية. لا يختلق صفاً في `accountingEntries`؛
 * المصدر الاصطناعي مميز صراحةً ومربوط بالدورة وبمفتاح لقطة فريد قابل للتحقق من بصمته.
 */
export async function writeShadowOpeningJournal(
  tx: Tx,
  input: ShadowOpeningJournalInput,
): Promise<void> {
  if (input.lines.length === 0) {
    throw new Error("مجموعة الافتتاح لا يجوز أن تكون بلا أسطر.");
  }
  assertValidLines(input.lines, input.sourceKey);
  assertBalanced(input.lines, input.sourceKey);
  const result = await tx.insert(journalEntries).values({
    entryId: null,
    sourceType: "SHADOW_OPENING",
    sourceKey: input.sourceKey,
    postingProfile: "SHADOW_OPENING_V1",
    cycleId: input.cycleId,
    entryDate: input.entryDate,
    branchId: input.branchId,
    status: "POSTED",
  });
  const journalId = extractInsertId(result);
  const accountIdByRole = await loadAccountIdByRole(tx);
  await tx.insert(journalLines).values(
    input.lines.map((line) => ({
      journalId,
      role: line.role,
      accountId: accountIdByRole.get(line.role) ?? null,
      branchId: input.branchId,
      debit: line.debit,
      credit: line.credit,
    })),
  );
}

/** شهادة افتتاح صفرية صريحة؛ MEMO وحيد بلا أسطر، ولا تُستعمل لأي رصيد غير صفري. */
export async function writeShadowOpeningMemo(
  tx: Tx,
  input: Omit<ShadowOpeningJournalInput, "lines">,
): Promise<void> {
  const asOf = input.entryDate.toISOString().slice(0, 10);
  if (
    input.branchId !== null ||
    input.sourceKey !== `SHADOW_OPENING:${input.cycleId}:${asOf}:GLOBAL`
  ) {
    throw new Error(
      "شهادة الافتتاح الصفرية يجب أن تكون عالمية وبمفتاح الدورة/تاريخ القطع المطابق.",
    );
  }
  await tx.insert(journalEntries).values({
    entryId: null,
    sourceType: "SHADOW_OPENING",
    sourceKey: input.sourceKey,
    postingProfile: "SHADOW_OPENING_V1",
    cycleId: input.cycleId,
    entryDate: input.entryDate,
    branchId: input.branchId,
    status: "MEMO",
  });
}

/**
 * يسجّل **فجوة**: حدثٌ ماليٌّ لم تُكتَب خريطته بعد (أو تعذّرت ترجمته). رأسٌ `UNMAPPED` بلا أسطر
 * ⇒ لا يدخل ميزان المراجعة، لكنه **مرئيٌّ ومعدود**: عدّاده صفراً شرطُ الانتقال إلى ACTIVE (س٧).
 */
export async function writeJournalGap(
  tx: Tx,
  entryId: number,
  entryDate: Date,
  branchId: number | null,
  reason: string,
  metadata: JournalMetadata = {},
): Promise<void> {
  await tx.insert(journalEntries).values({
    entryId,
    cycleId: metadata.cycleId ?? null,
    postingProfile: metadata.postingProfile ?? null,
    entryDate,
    branchId,
    status: "UNMAPPED",
    unmappedReason: reason.slice(0, 255),
  });
}

/**
 * يحذف القيد المزدوج لحدثٍ ماليّ (أسطرُه تُجرَف بـ`ON DELETE CASCADE`). يصمت إن لم يوجد قيد.
 * يُستعمل قبل إعادة كتابة قيدٍ تغيّر مبلغُه — `upsertOpeningEntry` يُعدّل مبالغ قيودٍ قائمة،
 * فلولا الحذف-ثمّ-الكتابة لبقي القيد المزدوج بائتاً يخالف الدفتر.
 */
export async function dropJournal(tx: Tx, entryId: number): Promise<void> {
  await tx.delete(journalEntries).where(eq(journalEntries.entryId, entryId));
}
