import Decimal from "decimal.js";
// Called only after exact original-SQL allowlist admission. All monetary
// reductions read the CURRENT private transaction, including earlier writes.
export function exactReturnQuery(
  local: any,
  original: string,
  params: any[],
  method: string,
) {
  const sql = original
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ for (update|share)$/i, "");
  const read = (query: string, values: any[] = []) => {
    const s = local.prepare(query);
    try {
      s.bind(values);
      const out: any[] = [];
      while (s.step()) out.push(s.getAsObject());
      return out;
    } finally {
      s.free();
    }
  };
  const raw = (rows: any[]) => ({ rows: [rows] });
  if (
    sql.startsWith("SELECT `receipts`.`paymentMethod` AS rail,") &&
    sql.includes("CAST(`receipts`.`amount` AS CHAR)")
  )
    return raw(
      read(
        sql.replace("CAST(`receipts`.`amount` AS CHAR)", "`receipts`.`amount`"),
        params,
      ),
    );
  if (sql.startsWith("SELECT coll.orderPayMethod AS rail,")) {
    if (
      read("SELECT id FROM orderPayments LIMIT 1").length ||
      read("SELECT id FROM workOrders LIMIT 1").length
    )
      throw Error("UNSUPPORTED_ORDER_PAYMENT_HISTORY");
    return raw([]);
  }
  if (sql.startsWith("SELECT CAST(COALESCE(SUM(x.remittedAmount)")) {
    if (read("SELECT id FROM deliveryConsignments LIMIT 1").length)
      throw Error("UNSUPPORTED_DELIVERY_HISTORY");
    return raw([{ remittedAmount: "0.00", unremittedAmount: "0.00" }]);
  }
  if (sql.startsWith("SELECT dr.shiftId AS shiftId,")) {
    if (read("SELECT id FROM deliveryConsignments LIMIT 1").length)
      throw Error("UNSUPPORTED_DELIVERY_HISTORY");
    return raw([]);
  }
  if (
    /^select COALESCE\(SUM\(`/i.test(sql) &&
    sql.includes(" from `accountingEntries` where ")
  ) {
    const fields = [
      ...sql.slice(0, sql.indexOf(" from ")).matchAll(/SUM\(`(\w+)`\)/g),
    ].map((m) => m[1]);
    if (
      !fields.length ||
      fields.some((f) => !["revenue", "taxAmount", "amount"].includes(f))
    )
      throw Error("UNSUPPORTED_LEDGER_AGGREGATE");
    const rows = read(
      "SELECT " +
        fields.map((f) => "`" + f + "`").join(",") +
        sql.slice(sql.indexOf(" from ")),
      params,
    );
    const sums = fields.map((f) =>
      rows.reduce((sum, r) => sum.plus(r[f] ?? "0"), new Decimal(0)).toFixed(2),
    );
    if (method !== "all") throw Error("UNEXPECTED_LEDGER_AGGREGATE_METHOD");
    return { rows: [sums] };
  }
  if (
    sql.startsWith("SELECT a.id, a.documentType,") ||
    sql.startsWith("SELECT a.effectKind, SUM(a.signedAmount)")
  ) {
    let index = 2;
    const filters: any = {};
    for (const [key, column] of [
      ["kind", "effectKind"],
      ["scope", "scope"],
    ]) {
      const m = new RegExp("a\\." + column + " IN \\(([^)]+)\\)").exec(sql);
      if (m) {
        const count = (m[1].match(/\?/g) ?? []).length;
        filters[key] = params.slice(index, index + count);
        index += count;
      }
    }
    if (index !== params.length) throw Error("INVALID_EFFECT_PARAMETERS");
    const rows = read(
      "SELECT * FROM documentEffects WHERE documentType=? AND documentId=? ORDER BY id",
      [params[0], params[1]],
    ).filter(
      (r) =>
        (!filters.kind || filters.kind.includes(r.effectKind)) &&
        (!filters.scope || filters.scope.includes(r.scope)),
    );
    const safe = (n: Decimal) => {
      if (!n.isInteger() || n.abs().gt(Number.MAX_SAFE_INTEGER))
        throw Error("UNSAFE_EFFECT_QUANTITY");
      return n.toNumber();
    };
    if (sql.startsWith("SELECT a.id,")) {
      return raw(
        rows
          .filter((r) => r.phase === "APPLY")
          .map((r) => {
            // The source child subqueries deliberately impose no parent scope filter.
            const children = read(
              "SELECT signedAmount,signedQuantity FROM documentEffects WHERE reversalOfEffectId=? AND phase='REVERSE'",
              [r.id],
            );
            return {
              ...r,
              reversedAmount: children
                .reduce((s, c) => s.plus(c.signedAmount), new Decimal(0))
                .toFixed(4),
              reversedQuantity: safe(
                children.reduce(
                  (s, c) => s.plus(c.signedQuantity),
                  new Decimal(0),
                ),
              ),
            };
          })
          .filter(
            (r) =>
              !sql.includes(" HAVING ") ||
              !new Decimal(r.signedAmount).plus(r.reversedAmount).isZero() ||
              r.signedQuantity + r.reversedQuantity !== 0,
          ),
      );
    }
    const groups = new Map<string, { amount: Decimal; quantity: Decimal }>();
    for (const r of rows) {
      const g = groups.get(r.effectKind) ?? {
        amount: new Decimal(0),
        quantity: new Decimal(0),
      };
      g.amount = g.amount.plus(r.signedAmount);
      g.quantity = g.quantity.plus(r.signedQuantity);
      groups.set(r.effectKind, g);
    }
    return raw(
      [...groups]
        .filter(([, g]) => !g.amount.isZero() || !g.quantity.isZero())
        .slice(0, 1)
        .map(([effectKind, g]) => ({
          effectKind,
          sumAmount: g.amount.toFixed(4),
          sumQuantity: safe(g.quantity),
        })),
    );
  }
  if (
    sql ===
    "update `invoices` set `paidAmount` = GREATEST(`invoices`.`paidAmount` - ?, 0) where `invoices`.`id` = ?"
  ) {
    const row = read("SELECT paidAmount FROM invoices WHERE id=?", [
      params[1],
    ])[0];
    if (!row) throw Error("INVOICE_BALANCE_MISSING");
    local.run("UPDATE invoices SET paidAmount=? WHERE id=?", [
      Decimal.max(new Decimal(row.paidAmount).minus(params[0]), 0).toFixed(2),
      params[1],
    ]);
    return { rows: [{ affectedRows: local.getRowsModified(), insertId: 0 }] };
  }
  return undefined;
}
