// استيراد العملاء بالجملة.
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { customers } from "../../../drizzle/schema";
import { logger } from "../../logger";
import { money, toDbMoney } from "../money";
import { type Actor, requireDb, withTx } from "../tx";
import type { CustomerImportRow } from "./schemas";
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

export async function importCustomers(
  rows: CustomerImportRow[],
  options: ImportOptions,
  actor: Actor,
): Promise<ImportSummary> {
  const onExisting = options.onExisting ?? "skip";
  const skipFailed = options.skipFailed ?? false;
  const db = requireDb();
  const failures = new Map<number, string>(); // rowNumber → سبب الفشل

  // ١) التكرار داخل الدفعة (legacyCode ← هاتف+اسم ← اسم) + دلالات الرصيد الحسّاسة.
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
    id: customers.id,
    name: customers.name,
    phone: customers.phone,
    legacyCode: customers.legacyCode,
  };
  if (legacies.length)
    candidates.push(
      ...(await db
        .select(identityFields)
        .from(customers)
        .where(inArray(customers.legacyCode, legacies))),
    );
  if (phones.length)
    candidates.push(
      ...(await db
        .select(identityFields)
        .from(customers)
        .where(inArray(customers.phone, phones))),
    );
  if (namesNoPhone.length)
    candidates.push(
      ...(await db
        .select(identityFields)
        .from(customers)
        .where(
          and(inArray(customers.name, namesNoPhone), isNull(customers.phone)),
        )),
    );
  const identities = partyIdentityIndex(candidates);
  const matchedIds = new Set<number>();
  const plannedCanonical = new Set<string>();
  // ٣) التصنيف: فشل / موجود (تخطٍّ أو تحديث) / إنشاء.
  const results: ImportRowResult[] = [];
  const toCreate: CustomerImportRow[] = [];
  const toUpdate: { row: CustomerImportRow; id: number }[] = [];
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
    // الرصيد الافتتاحي يُطبَّق عند الإنشاء فقط (§٥.٢) — عند التحديث يُتجاهَل برسالة صريحة لا بصمت.
    const balanceIgnored =
      u.row.openingBalance !== undefined &&
      !money(u.row.openingBalance).isZero();
    results.push({
      rowNumber: u.row.rowNumber,
      status: "updated",
      message: balanceIgnored
        ? "الرصيد الافتتاحي لا يُطبَّق على موجود — عدّله من شاشة العميل/سند"
        : undefined,
    });
  }

  const anyFailed = results.some((r) => r.status === "failed");
  if (
    options.dryRun ||
    (anyFailed && !skipFailed) ||
    (!toCreate.length && !toUpdate.length)
  ) {
    return finalize("CUSTOMERS", rows.length, results, false, options, actor);
  }

  try {
    await withTx(
      async (tx) => {
        // إدراج صفّاً-صفّاً (لا دفعةً واحدة): نحتاج id كل عميل لقيد OPENING المرجعي ضمن نفس المعاملة.
        for (const r of toCreate) {
          // Current read after the company-exclusive gate: a competing create may
          // have committed since planning. Never duplicate or guess its identity.
          const current = await tx
            .select(identityFields)
            .from(customers)
            .where(
              or(
                and(
                  eq(customers.name, r.name.trim()),
                  norm(r.phone)
                    ? eq(customers.phone, norm(r.phone)!)
                    : isNull(customers.phone),
                ),
                norm(r.legacyCode)
                  ? eq(customers.legacyCode, norm(r.legacyCode)!)
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
          const res = await tx.insert(customers).values({
            name: r.name.trim(),
            phone: norm(r.phone),
            phone2: norm(r.phone2),
            phone3: norm(r.phone3),
            whatsapp: norm(r.whatsapp),
            address: norm(r.address),
            city: norm(r.city),
            district: norm(r.district),
            customerType: r.customerType ?? "فرد",
            defaultPriceTier: r.defaultPriceTier ?? "RETAIL",
            creditLimit: r.creditLimit ? toDbMoney(r.creditLimit) : "0",
            currentBalance: balance,
            legacyCode: norm(r.legacyCode),
            notes: r.lastDealtAt
              ? mergeLastDealt(norm(r.notes), r.lastDealtAt)
              : norm(r.notes),
            isActive: r.isActive ?? true,
          });
          if (!money(balance).isZero())
            await postOpeningEntry(tx, "CUSTOMER", insertId(res), balance);
        }
        for (const { row, id } of toUpdate) {
          const current = await tx
            .select(identityFields)
            .from(customers)
            .where(eq(customers.id, id))
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
          if (norm(row.whatsapp) != null) patch.whatsapp = norm(row.whatsapp);
          if (norm(row.address) != null) patch.address = norm(row.address);
          if (norm(row.city) != null) patch.city = norm(row.city);
          if (norm(row.district) != null) patch.district = norm(row.district);
          if (row.customerType) patch.customerType = row.customerType;
          if (row.defaultPriceTier)
            patch.defaultPriceTier = row.defaultPriceTier;
          if (row.creditLimit) patch.creditLimit = toDbMoney(row.creditLimit);
          // ترصين legacyCode على الموجود (مُطابَق بالهاتف/الاسم) ⇒ إعادة الاستيراد القادمة تطابقه بالمعرّف القديم مباشرة.
          if (norm(row.legacyCode) != null)
            patch.legacyCode = norm(row.legacyCode);
          if (row.lastDealtAt) {
            // دمج آمن مع الملاحظات الموجودة: لا تراكم لسطر «آخر تعامل» عند تكرار الاستيراد.
            const existing = await tx
              .select({ notes: customers.notes })
              .from(customers)
              .where(eq(customers.id, id))
              .limit(1);
            patch.notes = mergeLastDealt(
              norm(row.notes) ?? existing[0]?.notes ?? null,
              row.lastDealtAt,
            );
          } else if (norm(row.notes) != null) {
            patch.notes = norm(row.notes);
          }
          if (Object.keys(patch).length)
            await tx.update(customers).set(patch).where(eq(customers.id, id));
        }
        // Initial bulk creates hold the existing company-exclusive gate only for
        // this transaction. This avoids relying on gap locks or adding a permanent
        // unique name/phone constraint that would forbid legitimate existing parties.
      },
      { gate: toCreate.length ? "GOVERNANCE" : "FINANCIAL_WRITER" },
    );
  } catch (e) {
    // الرسالة الخام تُسجَّل كاملة للتشخيص وتُعرَّب للواجهة (لا نصّ SQL/قيود/بيانات صفوف للمستخدم).
    logger.error({ err: e }, "فشل كتابة دفعة استيراد العملاء");
    return finalize(
      "CUSTOMERS",
      rows.length,
      markWriteError(results, writeErrorMessage(e)),
      false,
      options,
      actor,
    );
  }
  return finalize("CUSTOMERS", rows.length, results, true, options, actor);
}
