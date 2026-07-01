// بحث كيانات الموارد البشرية/الإدارة: الموظفون والمستخدمون.
import { fullEmployeeName } from "@shared/hr";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { branches, employees, users } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { escLike } from "../../lib/sqlLike";
import type { SearchKind, SearchResult } from "./types";

// ────────────────────────────── الموظفون (HR) ──────────────────────────────

async function searchEmployees(
  db: NonNullable<ReturnType<typeof getDb>>,
  kind: SearchKind,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  // كود بطاقة الموظف: EMP-<id> ⇒ تطابق دقيق (أعلى رتبة).
  const code = query.match(/^EMP-?(\d+)$/i);
  const conds: any[] = [eq(employees.isActive, true)];
  if (code) {
    conds.push(eq(employees.id, Number(code[1])));
  } else {
    if (kind === "DOC_NUMBER" && /[A-Za-z]/.test(query)) return []; // مُعرّف وثيقة ≠ موظف
    const like_ = `%${escLike(query)}%`;
    conds.push(
      or(
        sql`${employees.firstName} LIKE ${like_} ESCAPE '!'`,
        sql`${employees.fatherName} LIKE ${like_} ESCAPE '!'`,
        sql`${employees.lastName} LIKE ${like_} ESCAPE '!'`,
        sql`${employees.phone} LIKE ${like_} ESCAPE '!'`,
        sql`${employees.nationalId} LIKE ${like_} ESCAPE '!'`,
        sql`${employees.position} LIKE ${like_} ESCAPE '!'`,
      ),
    );
  }
  const rows = await db
    .select({
      id: employees.id,
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
      position: employees.position,
      department: employees.department,
      phone: employees.phone,
      branchName: branches.name,
    })
    .from(employees)
    .leftJoin(branches, eq(branches.id, employees.branchId))
    .where(and(...conds))
    .orderBy(asc(employees.firstName), desc(employees.id))
    .limit(limit);

  return rows.map((r) => {
    const name = fullEmployeeName(r);
    return {
      type: "EMPLOYEE" as const,
      id: r.id,
      title: name,
      subtitle: [r.position, r.department].filter(Boolean).join(" · ") || r.phone || null,
      meta: [`EMP-${r.id}`, r.branchName].filter(Boolean).join(" · "),
      route: `/hr/employees/${r.id}`,
      rank: code ? 0 : name.toLowerCase().startsWith(query.toLowerCase()) ? 1 : 2,
    };
  });
}

// ────────────────────────────── المستخدمون (إدارة) ──────────────────────────────

async function searchUsers(
  db: NonNullable<ReturnType<typeof getDb>>,
  kind: SearchKind,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  // كود بطاقة المستخدم: USER-<id> ⇒ تطابق دقيق.
  const code = query.match(/^USER-?(\d+)$/i);
  const conds: any[] = [];
  if (code) {
    conds.push(eq(users.id, Number(code[1])));
  } else {
    if (kind === "DOC_NUMBER" && /[A-Za-z]/.test(query)) return [];
    const like_ = `%${escLike(query)}%`;
    conds.push(
      or(
        sql`${users.name} LIKE ${like_} ESCAPE '!'`,
        sql`${users.username} LIKE ${like_} ESCAPE '!'`,
        sql`${users.email} LIKE ${like_} ESCAPE '!'`,
        sql`${users.phone} LIKE ${like_} ESCAPE '!'`,
      ),
    );
  }
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      username: users.username,
      email: users.email,
      role: users.role,
      isActive: users.isActive,
    })
    .from(users)
    .where(and(...conds))
    .orderBy(asc(users.name), desc(users.id))
    .limit(limit);

  return rows.map((r) => {
    const title = r.name || r.username || r.email || `مستخدم #${r.id}`;
    return {
      type: "USER" as const,
      id: r.id,
      title,
      subtitle: r.username ? `@${r.username}` : r.email,
      meta: [`USER-${r.id}`, r.role, r.isActive ? null : "معطّل"].filter(Boolean).join(" · "),
      route: `/users/${r.id}/edit`,
      rank: code ? 0 : title.toLowerCase().startsWith(query.toLowerCase()) ? 1 : 2,
    };
  });
}


export { searchEmployees, searchUsers };
