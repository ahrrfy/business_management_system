import { tables, quote } from "./schema";
import { rowJsonSql } from "./cash-state";
import { primary, failure, LAB_ID } from "./journal";

import { MAX_PAGE_BYTES } from "./recovery-limits";
export { MAX_PAGE_BYTES } from "./recovery-limits";
export function boundedRows(rows: any[]) {
  const selected: any[] = [];
  let bytes = 512;
  for (const row of rows) {
    const size = new TextEncoder().encode(JSON.stringify(row)).byteLength + 1;
    if (size + 512 > MAX_PAGE_BYTES) throw failure("RECOVERY_ROW_TOO_LARGE");
    if (bytes + size > MAX_PAGE_BYTES) break;
    selected.push(row);
    bytes += size;
  }
  return selected;
}
export function pageInteger(value: string | null, fallback?: number) {
  if (value === null && fallback !== undefined) return fallback;
  if (value === null || !/^\d{1,15}$/.test(value))
    throw failure("INVALID_PAGE_CURSOR", 400);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw failure("INVALID_PAGE_CURSOR", 400);
  return n;
}
const snapshotTables: any[] = [
  ...tables,
  {
    name: "cashEpoch",
    primary: ["id"],
    columns: [
      { name: "id", type: "INTEGER" },
      { name: "epoch", type: "INTEGER" },
    ],
  },
  {
    name: "cashCommands",
    primary: ["requestId"],
    columns: [
      "requestId",
      "requestHash",
      "requestJson",
      "resultJson",
      "planJson",
      "planHash",
    ].map((name) => ({ name, type: "TEXT" })),
  },
  {
    name: "cashOutbox",
    primary: ["eventId"],
    columns: ["eventId", "requestId", "payload", "planHash"].map((name) => ({
      name,
      type: "TEXT",
    })),
  },
];
const marker =
  "(SELECT role FROM cashSandboxIdentity WHERE id='" + LAB_ID + "') AS role";
function identity(row: any) {
  if (
    !row ||
    !["primary", "restore"].includes(row.role) ||
    !Number.isSafeInteger(row.epoch)
  )
    throw failure("SANDBOX_IDENTITY_MISMATCH");
}
export async function snapshotManifest(env: any) {
  const row = await primary(env.DB)
    .prepare(
      "SELECT epoch," +
        marker +
        "," +
        snapshotTables
          .map(
            (t) =>
              "(SELECT COUNT(*) FROM " +
              quote(t.name) +
              ") AS " +
              quote(t.name),
          )
          .join(",") +
        " FROM cashEpoch WHERE id=1",
    )
    .first();
  identity(row);
  return {
    role: row.role,
    epoch: row.epoch,
    tables: snapshotTables.map((t) => ({
      name: t.name,
      primary: t.primary,
      count: row[t.name],
    })),
  };
}
export async function snapshotPage(env: any, url: URL) {
  const t = snapshotTables.find(
    (t) => t.name === url.searchParams.get("table"),
  );
  if (!t) throw failure("INVALID_SNAPSHOT_TABLE", 400);
  const epoch = pageInteger(url.searchParams.get("epoch")),
    limit = pageInteger(url.searchParams.get("limit"), 100);
  if (limit < 1 || limit > 100) throw failure("INVALID_PAGE_LIMIT", 400);
  let after: any = null;
  const raw = url.searchParams.get("after");
  if (raw !== null) {
    try {
      if (raw.length > 4096) throw Error();
      after = JSON.parse(raw);
    } catch {
      throw failure("INVALID_SNAPSHOT_CURSOR", 400);
    }
    if (
      !Array.isArray(after) ||
      after.length !== t.primary.length ||
      t.primary.some((k: string, i: number) =>
        t.columns.find((c: any) => c.name === k).type === "INTEGER"
          ? !Number.isSafeInteger(after[i])
          : typeof after[i] !== "string",
      )
    )
      throw failure("INVALID_SNAPSHOT_CURSOR", 400);
  }
  const fetchLimit = Math.min(
    limit,
    ["cashCommands", "cashOutbox"].includes(t.name) ? 8 : 100,
  );
  const keys = t.primary.map(quote).join(","),
    where = after
      ? "(" + keys + ")>(" + t.primary.map(() => "?").join(",") + ")"
      : "1";
  const sql =
    "SELECT epoch," +
    marker +
    ", (SELECT json_group_array(json(rowJson)) FROM(SELECT " +
    rowJsonSql(t.columns.map((c: any) => c.name)) +
    " AS rowJson FROM " +
    quote(t.name) +
    " WHERE " +
    where +
    " ORDER BY " +
    keys +
    " LIMIT ?)) AS rows FROM cashEpoch WHERE id=1";
  const row = await primary(env.DB)
    .prepare(sql)
    .bind(...(after ?? []), fetchLimit)
    .first();
  identity(row);
  if (row.epoch !== epoch) throw failure("SNAPSHOT_EPOCH_CHANGED_RESTART", 409);
  const fetched = JSON.parse(row.rows),
    rows = boundedRows(fetched),
    complete = rows.length === fetched.length && fetched.length < fetchLimit;
  return {
    epoch,
    table: t.name,
    rows,
    complete,
    nextCursor: complete ? null : t.primary.map((k: string) => rows.at(-1)[k]),
  };
}
