import { tables, initializationSql } from "./schema";

// Build-selected accounting experiment only. Never derive this from a request.
export const NAMESPACE = "q1gl_";
export const JOURNAL_GUARDS = [
  "cashJournalCommitted_no_update",
  "cashJournalCommitted_no_delete",
  "cashJournalCommitted_contiguous",
  "cashJournalCommitted_advance_head",
  "cashJournalHead_guard",
  "cashJournalHead_no_delete",
];
export const namespaceObjects = [
  ...tables.map((t) => t.name),
  "cashEpoch",
  "cashAssert",
  "cashCommands",
  "cashOutbox",
  "cashSandboxIdentity",
  "cashJournalIdentity",
  "cashJournalAssert",
  "cashJournalRequests",
  "cashJournalAttempts",
  "cashJournalCommitted",
  "cashJournalHead",
  "cashJournalRequests_no_update",
  "cashJournalRequests_no_delete",
  "cashJournalAttempts_no_update",
  "cashJournalAttempts_no_delete",
  ...JOURNAL_GUARDS,
  ...Array.from(
    initializationSql.matchAll(/CREATE INDEX(?: IF NOT EXISTS)? (\w+)/g),
    (m) => m[1],
  ),
];
const objects = new Map(namespaceObjects.map((n) => [n.toLowerCase(), n]));
const indexNames = new Set(
  Array.from(
    initializationSql.matchAll(/CREATE INDEX(?: IF NOT EXISTS)? (\w+)/g),
    (m) => m[1].toLowerCase(),
  ),
);
const triggerNames = new Set(
  namespaceObjects
    .filter((n) =>
      /_(?:no_update|no_delete|contiguous|advance_head|guard)$/.test(n),
    )
    .map((n) => n.toLowerCase()),
);
const tableNames = new Set(
  [
    ...tables.map((t) => t.name),
    "cashEpoch",
    "cashAssert",
    "cashCommands",
    "cashOutbox",
    "cashSandboxIdentity",
    "cashJournalIdentity",
    "cashJournalAssert",
    "cashJournalRequests",
    "cashJournalAttempts",
    "cashJournalCommitted",
    "cashJournalHead",
  ].map((n) => n.toLowerCase()),
);
const fail = () => {
  throw Error("NAMESPACE_SQL_REJECTED");
};
type Token = {
  text: string;
  value: string;
  kind: "id" | "string" | "punct" | "trivia";
  quote?: string;
};
function tokens(sql: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < sql.length; ) {
    const start = i,
      c = sql[i];
    if (sql.startsWith("*/", i)) fail();
    if (/\s/.test(c)) {
      while (i < sql.length && /\s/.test(sql[i])) i++;
      out.push({ text: sql.slice(start, i), value: "", kind: "trivia" });
    } else if (sql.startsWith("--", i)) {
      i = sql.indexOf("\n", i);
      if (i < 0) i = sql.length;
      out.push({ text: sql.slice(start, i), value: "", kind: "trivia" });
    } else if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0 || sql.slice(i + 2, end).includes("/*")) fail();
      i = end + 2;
      out.push({ text: sql.slice(start, i), value: "", kind: "trivia" });
    } else if (["'", '"', "`", "["].includes(c)) {
      const end = c === "[" ? "]" : c;
      let value = "",
        closed = false;
      i++;
      while (i < sql.length) {
        if (sql[i] === end) {
          if (sql[i + 1] === end) {
            value += end;
            i += 2;
          } else {
            i++;
            closed = true;
            break;
          }
        } else value += sql[i++];
      }
      if (!closed || (c !== "'" && !value.length)) fail();
      out.push({
        text: sql.slice(start, i),
        value,
        kind: c === "'" ? "string" : "id",
        quote: c,
      });
    } else if (/[A-Za-z_]/.test(c)) {
      i++;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      out.push({
        text: sql.slice(start, i),
        value: sql.slice(start, i),
        kind: "id",
      });
    } else {
      if (!/[0-9?(),.;+*/%<>=!|&~:-]/.test(c)) fail();
      out.push({ text: c, value: c, kind: "punct" });
      i++;
    }
  }
  return out;
}
const render = (t: Token, value: string) =>
  t.quote === "["
    ? "[" + value.replaceAll("]", "]]") + "]"
    : t.quote
      ? t.quote + value.replaceAll(t.quote, t.quote + t.quote) + t.quote
      : value;

export function namespaceSql(sql: string): string {
  if (typeof sql !== "string" || !sql.length) return fail();
  const all = tokens(sql),
    ts = all.filter((t) => t.kind !== "trivia");
  const word = (i: number) =>
    ts[i]?.kind === "string" || ts[i]?.quote
      ? "<literal>"
      : ts[i]?.value.toUpperCase();
  if (
    !["SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "CREATE"].includes(
      word(0),
    )
  )
    fail();
  const trigger = word(0) === "CREATE" && word(1) === "TRIGGER";
  if (word(0) === "CREATE" && !["TABLE", "INDEX", "TRIGGER"].includes(word(1)))
    fail();
  if (
    ts.some(
      (t) =>
        t.kind === "id" &&
        !t.quote &&
        [
          "PRAGMA",
          "ATTACH",
          "DETACH",
          "ALTER",
          "DROP",
          "REPLACE",
          "VACUUM",
        ].includes(t.value.toUpperCase()),
    )
  )
    fail();
  if (
    !trigger &&
    ts.slice(0, -1).some((t) => t.kind === "punct" && t.value === ";")
  )
    fail();
  if (trigger) {
    const begin = ts.findIndex((_t, i) => word(i) === "BEGIN");
    if (begin < 0) fail();
    if (ts.slice(0, begin).some((t) => t.kind === "punct" && t.value === ";"))
      fail();
    let cases = 0,
      finished = false;
    for (let i = begin + 1; i < ts.length; i++) {
      if (word(i) === "BEGIN") fail();
      if (word(i) === "CASE") cases++;
      if (word(i) !== "END") continue;
      if (cases) {
        cases--;
        continue;
      }
      if (word(i + 1) === ";") i++;
      if (i !== ts.length - 1) fail();
      finished = true;
      break;
    }
    if (!finished) fail();
  }
  const ctes = new Set<string>();
  // Only the existing top-level WITH ... SELECT projection is supported.
  // Nested names are never visible outside their lexical SQL scope, and CTEs
  // are never writable targets. Reject broader grammar instead of guessing.
  if (ts.some((_t, i) => i > 0 && word(i) === "WITH")) fail();
  if (word(0) === "WITH") {
    let i = 1;
    for (;;) {
      const t = ts[i],
        lower = t?.value.toLowerCase();
      if (
        !t ||
        t.kind !== "id" ||
        objects.has(lower) ||
        ["sqlite_master", "sqlite_sequence"].includes(lower) ||
        ctes.has(lower) ||
        word(i + 1) !== "AS" ||
        word(i + 2) !== "("
      )
        fail();
      ctes.add(lower);
      i += 3;
      let level = 1;
      while (i < ts.length && level) {
        if (word(i) === "(") level++;
        if (word(i) === ")") level--;
        i++;
      }
      if (level) fail();
      if (word(i) !== ",") {
        if (word(i) !== "SELECT") fail();
        break;
      }
      i++;
    }
  }
  if (
    ["SELECT", "WITH"].includes(word(0)) &&
    ts.some((_t, i) =>
      ["INSERT", "UPDATE", "DELETE", "CREATE"].includes(word(i)),
    )
  )
    fail();
  const rewrite = (
    i: number,
    kind = "table",
    allowCte = false,
    columnQualifier = false,
  ) => {
    const t = ts[i];
    if (!t || t.kind !== "id") return fail();
    if (!columnQualifier && word(i + 1) === ".") return fail();
    const lower = t.value.toLowerCase(),
      known = objects.get(lower);
    if (allowCte && kind === "table" && ctes.has(lower)) return;
    if (kind === "table" && ["json_each", "json_tree"].includes(lower)) {
      if (word(i + 1) !== "(") return fail();
      return;
    }
    if (
      kind === "table" &&
      ["sqlite_master", "sqlite_sequence"].includes(lower)
    )
      return;
    if (!known || (kind === "table" && !tableNames.has(lower))) return fail();
    if (
      (kind === "index" && !indexNames.has(lower)) ||
      (kind === "trigger" && !triggerNames.has(lower))
    )
      return fail();
    t.text = render(t, NAMESPACE + known);
  };
  // Metadata is deliberately narrower than ordinary SQL. Only the established
  // six-trigger prefix proof and scoped AUTOINCREMENT reads are admitted.
  for (let i = 0; i < ts.length; i++) {
    const lower = ts[i].value.toLowerCase();
    if (
      ts[i].kind !== "id" ||
      !["sqlite_master", "sqlite_sequence"].includes(lower)
    )
      continue;
    if (word(i - 1) !== "FROM") fail();
    let j = i + 1;
    if (word(j++) !== "WHERE") fail();
    if (lower === "sqlite_master") {
      if (
        word(j++) !== "TYPE" ||
        word(j++) !== "=" ||
        ts[j]?.kind !== "string" ||
        ts[j++].value !== "trigger" ||
        word(j++) !== "AND"
      )
        fail();
    }
    if (word(j++) !== "NAME") fail();
    const selected: Token[] = [];
    if (word(j) === "IN") {
      if (word(++j) !== "(") fail();
      j++;
      for (;;) {
        if (ts[j]?.kind !== "string") fail();
        selected.push(ts[j++]);
        if (word(j) === ")") {
          j++;
          break;
        }
        if (word(j++) !== ",") fail();
      }
    } else if (word(j++) === "=" && ts[j]?.kind === "string")
      selected.push(ts[j++]);
    else fail();
    if (
      lower === "sqlite_master" &&
      (selected.length !== 6 ||
        new Set(selected.map((t) => t.value)).size !== 6 ||
        selected.some((t) => !JOURNAL_GUARDS.includes(t.value)))
    )
      fail();
    if (
      lower === "sqlite_sequence" &&
      selected.some((t) => !tableNames.has(t.value.toLowerCase()))
    )
      fail();
    // No broadened predicate may let a legacy metadata row satisfy this proof.
    if (j < ts.length && ![")", ";"].includes(word(j))) fail();
    selected.forEach((t) => {
      t.text = "'" + NAMESPACE + objects.get(t.value.toLowerCase()) + "'";
    });
    if (lower === "sqlite_sequence") {
      // Projection consumers and signed plans retain logical sequence keys.
      const p = ts
        .slice(0, i)
        .findLastIndex((t) => t.value.toLowerCase() === "json_group_object");
      if (
        p >= 0 &&
        word(p + 1) === "(" &&
        word(p + 2) === "NAME" &&
        word(p + 3) === "," &&
        word(p + 4) === "SEQ" &&
        word(p + 5) === ")" &&
        word(p + 6) === "FROM"
      )
        ts[p + 2].text = `substr(name,${NAMESPACE.length + 1})`;
    }
  }
  const fromAtDepth: boolean[] = [false];
  let depth = 0;
  for (let i = 0; i < ts.length; i++) {
    const w = word(i);
    if (w === "(") {
      depth++;
      fromAtDepth[depth] = false;
    } else if (w === ")") {
      if (!depth) fail();
      fromAtDepth.pop();
      depth--;
    } else if (
      [
        "WHERE",
        "GROUP",
        "ORDER",
        "LIMIT",
        "HAVING",
        "UNION",
        "SET",
        "VALUES",
        ";",
      ].includes(w)
    )
      fromAtDepth[depth] = false;
    const relation =
      ["FROM", "JOIN", "INTO", "REFERENCES"].includes(w) ||
      (w === "UPDATE" &&
        word(i + 1) !== "ON" &&
        !(word(i - 1) === "DO" && word(i + 1) === "SET")) ||
      (w === "," && fromAtDepth[depth]);
    if (relation) {
      if (w === "FROM") fromAtDepth[depth] = true;
      if (word(i + 1) === "(") {
        if (!["SELECT", "WITH"].includes(word(i + 2))) fail();
      } else
        rewrite(
          i + 1,
          "table",
          ["FROM", "JOIN", ","].includes(w) && word(i - 1) !== "DELETE",
        );
    }
    if (w === "INDEXED" && word(i + 1) === "BY") rewrite(i + 2, "index");
    if (word(0) === "CREATE" && i === 1) {
      let n = i + 1;
      if (word(n) === "IF" && word(n + 1) === "NOT" && word(n + 2) === "EXISTS")
        n += 3;
      rewrite(n, w.toLowerCase());
    }
    if (
      word(0) === "CREATE" &&
      ["INDEX", "TRIGGER"].includes(word(1)) &&
      w === "ON"
    )
      rewrite(i + 1);
    if (
      ts[i].kind === "id" &&
      word(i + 1) === "." &&
      objects.has(ts[i].value.toLowerCase())
    )
      rewrite(i, "table", false, true);
  }
  if (depth) fail();
  return all.map((t) => t.text).join("");
}

const bindings = new WeakMap<object, any>(),
  statements = new WeakMap<object, { raw: any; owner: object }>();
export function namespaceBinding(raw: any): any {
  if (!raw || typeof raw.prepare !== "function") return fail();
  if (bindings.has(raw)) return bindings.get(raw);
  const statement = (item: any): any => {
    const wrapped: any = {
      bind: (...args: any[]) => {
        if (args.length > 100) return fail();
        return statement(item.bind(...args));
      },
    };
    for (const method of ["first", "all", "run", "raw"])
      wrapped[method] = (...args: any[]) => item[method](...args);
    statements.set(wrapped, { raw: item, owner: raw });
    return wrapped;
  };
  const wrapped: any = {
    prepare: (sql: string) => statement(raw.prepare(namespaceSql(sql))),
    batch: (items: any[]) =>
      raw.batch(
        items.map((item) => {
          const found = statements.get(item);
          if (!found || found.owner !== raw) return fail();
          return found.raw;
        }),
      ),
    ...(raw.withSession
      ? {
          withSession: (...args: any[]) =>
            namespaceBinding(raw.withSession(...args)),
        }
      : {}),
    ...(raw.getBookmark
      ? { getBookmark: (...args: any[]) => raw.getBookmark(...args) }
      : {}),
  };
  bindings.set(raw, wrapped);
  bindings.set(wrapped, wrapped);
  return wrapped;
}
export function namespaceEnvironment(env: any) {
  return {
    ...env,
    ...(env.DB ? { DB: namespaceBinding(env.DB) } : {}),
    ...(env.RECOVERY_LOG
      ? { RECOVERY_LOG: namespaceBinding(env.RECOVERY_LOG) }
      : {}),
  };
}
