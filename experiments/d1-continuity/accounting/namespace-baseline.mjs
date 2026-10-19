import { createHash } from "node:crypto";
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function captureLegacy(bindings) {
  const result = {};
  await Promise.all(
    Object.entries(bindings).map(async ([role, db]) => {
      const ddl = (
        await db
          .prepare(
            "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE substr(tbl_name,1,5)<>'q1gl_' AND substr(name,1,4)<>'_cf_' ORDER BY type,name",
          )
          .all()
      ).results;
      const tables = {};
      const names = ddl.filter((r) => r.type === "table").map((r) => r.name);
      const selected = await db.batch(
        names.map((name) =>
          db.prepare(
            'SELECT * FROM "' +
              name.replaceAll('"', '""') +
              '"' +
              (name === "sqlite_sequence"
                ? " WHERE substr(name,1,5)<>'q1gl_'"
                : ""),
          ),
        ),
      );
      for (const [index, name] of names.entries()) {
        const rows = selected[index].results;
        rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        tables[name] = { rows, rowCount: rows.length, sha256: hash(rows) };
      }
      result[role] = {
        ddl,
        tables,
        ddlSha256: hash(ddl),
        rowsSha256: hash(tables),
        rowCount: Object.values(tables).reduce((n, t) => n + t.rowCount, 0),
      };
    }),
  );
  return result;
}
