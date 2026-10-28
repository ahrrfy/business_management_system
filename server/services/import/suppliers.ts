// استيراد الموردين بالجملة.
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { suppliers } from "../../../drizzle/schema";
import { logger } from "../../logger";
import { money } from "../money";
import { type Actor, requireDb, withTx } from "../tx";
import type { SupplierImportRow } from "./schemas";
import type { ImportOptions, ImportRowResult, ImportSummary } from "./types";
import {
  finalize,
  insertId,
  markWriteError,
  norm,
  uniq,
  writeErrorMessage,
} from "./helpers";
import {
  dupKeyOf,
  dupMessage,
  balanceValidationError,
  mergeLastDealt,
  postOpeningEntry,
  storedOpeningBalance,
} from "./balanceSemantics";
import {
  type PartyIdentity,
  canonicalPartyKey,
  partyIdentityIndex,
  resolvePartyIdentity,
  repeatedPartyIdentityMessage,
} from "./partyIdentity";

export async function importSuppliers(
  rows: SupplierImportRow[],
  options: ImportOptions,
  actor: Actor,
): Promise<ImportSummary> {
  const onExisting = options.onExisting ?? "skip";
  const skipFailed = options.skipFailed ?? false;
  const db = requireDb();
  const failures = new Map<number, string>();

  // ١) التكرار داخل الدفعة + دلالات الرصيد (نفس قواعد العملاء — §٥.٢).
  const firstSeen = new Map<string, number>();
  for (const r of rows) {
    const k = dupKeyOf(r);
    if (firstSeen.has(k)) failures.set(r.rowNumber, dupMessage(r));
    else firstSeen.set(k, r.rowNumber);
  }
  for (const r of rows) {
    if (failures.has(r.rowNumber)) continue;
    const err = balanceValidationError(r, options);
    if (err) failures.set(r.rowNumber, err);
  }

  // ٢) Keep every candidate: a phone alone cannot identify a party, and duplicate
  // canonical identities must fail explicitly instead of selecting the last row.
  const legacies = uniq(rows.map((r) => norm(r.legacyCode)));
  const phones = uniq(rows.map((r) => norm(r.phone)));
  const namesNoPhone = uniq(
    rows.filter((r) => !norm(r.phone)).map((r) => r.name.trim()),
  );
  const candidates: PartyIdentity[] = [];
  const identityFields = {
    id: suppliers.id,
    name: suppliers.name,
    phone: suppliers.phone,
    legacyCode: suppliers.legacyCode,
  };
  if (legacies.length)
    candidates.push(
      ...(await db
        .select(identityFields)
        .from(suppliers)
        .where(inArray(suppliers.legacyCode, legacies))),
    );
  if (phones.length)
    candidates.push(
      ...(await db
        .select(identityFields)
        .from(suppliers)
        .where(inArray(suppliers.phone, phones))),
    );
  if (namesNoPhone.length)
    candidates.push(
      ...(await db
        .select(identityFields)
        .from(suppliers)
        .where(
          and(inArray(suppliers.name, namesNoPhone), isNull(suppliers.phone)),
        )),
    );
  const identities = partyIdentityIndex(candidates);
  const matchedIds = new Set<number>();
  const plannedCanonical = new Set<string>();
  // ٣) التصنيف.
  const results: ImportRowResult[] = [];
  const toCreate: SupplierImportRow[] = [];
  const toUpdate: { row: SupplierImportRow; id: number }[] = [];
  for (const r of rows) {
    if (failures.has(r.rowNumber)) {
      results.push({
        rowNumber: r.rowNumber,
        status: "failed",
        message: failures.get(r.rowNumber),
      });
      continue;
    }
    const match = resolvePartyIdentity(r, identities);
    if (match.error || (match.id !== undefined && matchedIds.has(match.id))) {
      results.push({
        rowNumber: r.rowNumber,
        status: "failed",
        message: match.error ?? repeatedPartyIdentityMessage,
      });
      continue;
    }
    const existingId = match.id;
    if (existingId !== undefined) matchedIds.add(existingId);
    if (existingId) {
      if (onExisting === "skip")
        results.push({
          rowNumber: r.rowNumber,
          status: "skipped",
          message: "موجود مسبقاً",
        });
      else if (onExisting === "error")
        results.push({
          rowNumber: r.rowNumber,
          status: "failed",
          message: "موجود مسبقاً",
        });
      else toUpdate.push({ row: r, id: existingId });
    } else {
      const canonical = canonicalPartyKey(r);
      if (plannedCanonical.has(canonical)) {
        results.push({
          rowNumber: r.rowNumber,
          status: "failed",
          message: repeatedPartyIdentityMessage,
        });
        continue;
      }
      plannedCanonical.add(canonical);
      toCreate.push(r);
    }
  }
  for (const r of toCreate)
    results.push({ rowNumber: r.rowNumber, status: "created" });
  for (const u of toUpdate) {
    const balanceIgnored =
      u.row.openingBalance !== undefined &&
      !money(u.row.openingBalance).isZero();
    results.push({
      rowNumber: u.row.rowNumber,
      status: "updated",
      message: balanceIgnored
        ? "الرصيد الافتتاحي لا يُطبَّق على موجود — عدّله من شاشة المورد/سند"
        : undefined,
    });
  }

  const anyFailed = results.some((r) => r.status === "failed");
  if (
    options.dryRun ||
    (anyFailed && !skipFailed) ||
    (!toCreate.length && !toUpdate.length)
  ) {
    return finalize("SUPPLIERS", rows.length, results, false, options, actor);
  }

  try {
    await withTx(
      async (tx) => {
        // إدراج صفّاً-صفّاً: نحتاج id كل مورد لقيد OPENING المرجعي ضمن نفس المعاملة.
        for (const r of toCreate) {
          // Current read after the company-exclusive gate; planning alone cannot
          // authorize a second canonical identity created by a concurrent import.
          const current = await tx
            .select(identityFields)
            .from(suppliers)
            .where(
              or(
                and(
                  eq(suppliers.name, r.name.trim()),
                  norm(r.phone)
                    ? eq(suppliers.phone, norm(r.phone)!)
                    : isNull(suppliers.phone),
                ),
                norm(r.legacyCode)
                  ? eq(suppliers.legacyCode, norm(r.legacyCode)!)
                  : undefined,
              ),
            )
            .for("update");
          const freshMatch = resolvePartyIdentity(
            r,
            partyIdentityIndex(current),
          );
          if (freshMatch.error || freshMatch.id !== undefined)
            throw new Error(
              freshMatch.error ??
                "IDENTITY_MISMATCH: أُنشئ طرف مطابق بعد المعاينة — راجع هوية المصدر ثم أعد الاستيراد",
            );
          const balance = storedOpeningBalance(r, options);
          const res = await tx.insert(suppliers).values({
            name: r.name.trim(),
            phone: norm(r.phone),
            phone2: norm(r.phone2),
            phone3: norm(r.phone3),
            email: norm(r.email),
            whatsapp: norm(r.whatsapp),
            address: norm(r.address),
            city: norm(r.city),
            taxId: norm(r.taxId),
            productTypes: norm(r.productTypes),
            paymentTerms: norm(r.paymentTerms),
            currentBalance: balance,
            legacyCode: norm(r.legacyCode),
            notes: r.lastDealtAt
              ? mergeLastDealt(norm(r.notes), r.lastDealtAt)
              : norm(r.notes),
            isActive: r.isActive ?? true,
          });
          if (!money(balance).isZero())
            await postOpeningEntry(tx, "SUPPLIER", insertId(res), balance);
        }
        for (const { row, id } of toUpdate) {
          const current = await tx
            .select(identityFields)
            .from(suppliers)
            .where(eq(suppliers.id, id))
            .for("update");
          const freshMatch = resolvePartyIdentity(
            row,
            partyIdentityIndex(current),
          );
          if (freshMatch.error || freshMatch.id !== id) {
            throw new Error(
              freshMatch.error ??
                "IDENTITY_MISMATCH: تغيّرت هوية الطرف بعد المعاينة — أعد الاستيراد بعد مراجعة الرقم القديم والاسم والهاتف",
            );
          }
          const patch: Record<string, unknown> = {};
          if (norm(row.phone) != null) patch.phone = norm(row.phone);
          if (norm(row.phone2) != null) patch.phone2 = norm(row.phone2);
          if (norm(row.phone3) != null) patch.phone3 = norm(row.phone3);
          if (norm(row.email) != null) patch.email = norm(row.email);
          if (norm(row.whatsapp) != null) patch.whatsapp = norm(row.whatsapp);
          if (norm(row.address) != null) patch.address = norm(row.address);
          if (norm(row.city) != null) patch.city = norm(row.city);
          if (norm(row.taxId) != null) patch.taxId = norm(row.taxId);
          if (norm(row.productTypes) != null)
            patch.productTypes = norm(row.productTypes);
          if (norm(row.paymentTerms) != null)
            patch.paymentTerms = norm(row.paymentTerms);
          if (norm(row.legacyCode) != null)
            patch.legacyCode = norm(row.legacyCode);
          if (row.lastDealtAt) {
            const existing = await tx
              .select({ notes: suppliers.notes })
              .from(suppliers)
              .where(eq(suppliers.id, id))
              .limit(1);
            patch.notes = mergeLastDealt(
              norm(row.notes) ?? existing[0]?.notes ?? null,
              row.lastDealtAt,
            );
          } else if (norm(row.notes) != null) {
            patch.notes = norm(row.notes);
          }
          if (Object.keys(patch).length)
            await tx.update(suppliers).set(patch).where(eq(suppliers.id, id));
        }
        // Bounded bulk-import exclusion uses the existing company gate. A permanent
        // name/phone uniqueness rule would incorrectly forbid real distinct parties.
      },
      { gate: toCreate.length ? "GOVERNANCE" : "FINANCIAL_WRITER" },
    );
  } catch (e) {
    // الرسالة الخام تُسجَّل كاملة للتشخيص وتُعرَّب للواجهة (لا نصّ SQL/قيود/بيانات صفوف للمستخدم).
    logger.error({ err: e }, "فشل كتابة دفعة استيراد الموردين");
    return finalize(
      "SUPPLIERS",
      rows.length,
      markWriteError(results, writeErrorMessage(e)),
      false,
      options,
      actor,
    );
  }
  return finalize("SUPPLIERS", rows.length, results, true, options, actor);
}
