/** يَستخرج `insertId` من نتيجة `tx.insert(...).values(...)` في mysql2/drizzle.
 *
 *  drizzle-mysql2 يُعيد إمّا كائن `ResultSetHeader` مباشرةً (يحوي `insertId`)
 *  أو tuple بصيغة `[ResultSetHeader, FieldPacket[]]` بحسب الإصدار/الاستعلام.
 *  النمط مكرَّر في خدمات الكتابة كلها (٥١ موضعاً) لذا وُحِّد هنا.
 *
 *  يَرمي خطأً واضحاً إن لم يَجد `insertId` رقمياً — لا يُعيد 0 ولا undefined صامتاً
 *  حتى لا تستمر معاملة على معرّف باطل.
 */
export function extractInsertId(result: unknown): number {
  const direct = (result as { insertId?: unknown } | null | undefined)?.insertId;
  const fromTuple = Array.isArray(result)
    ? (result[0] as { insertId?: unknown } | undefined)?.insertId
    : undefined;
  const id = direct ?? fromTuple;
  if (typeof id !== "number" || !Number.isFinite(id)) {
    throw new Error("extractInsertId: no insertId in result");
  }
  return id;
}
