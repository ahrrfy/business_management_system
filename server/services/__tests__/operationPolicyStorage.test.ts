import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPERATION_PERMISSIONS,
  type OperationPolicy,
} from "@shared/operationPermissions";
import * as s from "../../../drizzle/schema";
import {
  resolveCustomRole,
  normalizeOwnerAuthority,
  type AuthUser,
} from "../../context";
import { getDb } from "../../db";
import * as audit from "../auditService";
import * as passwords from "../../auth/password";
import { createRole, getRole, updateRole } from "../roleService";
import { createUser, getUser, updateUser } from "../userService";

const actor = { userId: 1, branchId: 1, role: "admin", isOwner: true };
const sale = "operation.sales.create";
const returned = "operation.returns.create";
const policy = (
  grants: Record<string, boolean>,
  visible = false,
): OperationPolicy => ({
  version: 1,
  grants,
  dataVisibility: { purchaseCost: visible, profitMargin: visible },
});

function db() {
  const database = getDb();
  if (!database) throw new Error("Test database is required");
  return database;
}

async function resolve(userId: number) {
  const [row] = await db().select().from(s.users).where(eq(s.users.id, userId));
  const user = { ...row } as AuthUser;
  await resolveCustomRole(user);
  return user;
}

async function makeRole(
  grants: Record<string, boolean>,
  baseRole: "cashier" | "courier" | "user" | "manager" = "user",
) {
  return createRole(
    {
      label: "دور مرن",
      baseRole,
      permissions: {},
      operationPolicy: policy(grants),
    },
    actor,
  );
}

async function makeUser(
  customRoleId?: number,
  operationPolicy?: OperationPolicy | null,
) {
  return createUser(
    {
      name: "موظف",
      username: "employee",
      password: "Strong12345!",
      role: "cashier",
      customRoleId,
      operationPolicy,
    },
    actor,
  );
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of ["auditLogs", "users", "roles", "branches"])
    await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({
    id: 1,
    openId: "admin",
    username: "admin",
    name: "المالك",
    role: "admin",
    isOwner: true,
    branchId: 1,
  });
});

describe("canonical operation policy persistence and resolution", () => {
  it("rechecks expiry immediately before insert after asynchronous password hashing", async () => {
    const expiry = new Date(Date.now() + 60_000);
    await db()
      .update(s.users)
      .set({ accessExpiresAt: expiry })
      .where(eq(s.users.id, 1));
    vi.spyOn(passwords, "hashPassword").mockImplementationOnce(async () => {
      vi.spyOn(Date, "now").mockReturnValue(expiry.getTime() + 1_000);
      return "hashed-before-account-expired";
    });
    await expect(
      createUser(
        {
          name: "متأخر",
          username: "late",
          password: "Strong12345!",
          operationPolicy: policy({ [sale]: true }),
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db().select().from(s.users)).toHaveLength(1);
    expect(await db().select().from(s.auditLogs)).toHaveLength(0);
  });
  it.each([
    "revoked",
    "inactive",
    "expired",
    "inactive custom role",
    "custom role downgraded",
  ] as const)(
    "rejects all four identity writes after persisted actor authority becomes %s",
    async (revocation) => {
      const role = await makeRole({ [sale]: true });
      const { userId } = await makeUser(role.id);
      const previousRole = await getRole(role.id);
      const previousUser = await getUser(userId);
      const previousAudits = await db().select().from(s.auditLogs);
      if (
        revocation === "inactive custom role" ||
        revocation === "custom role downgraded"
      ) {
        await db()
          .insert(s.roles)
          .values({
            id: 70,
            key: "actor_authority",
            label: "دور المنفذ",
            baseRole:
              revocation === "inactive custom role" ? "admin" : "manager",
            isActive: revocation !== "inactive custom role",
            permissions: {},
          });
        await db()
          .update(s.users)
          .set({ isOwner: false, customRoleId: 70 })
          .where(eq(s.users.id, actor.userId));
      } else {
        await db()
          .update(s.users)
          .set(
            revocation === "inactive"
              ? { isActive: false }
              : revocation === "expired"
                ? { accessExpiresAt: new Date(Date.now() - 60_000) }
                : { role: "manager", isOwner: false },
          )
          .where(eq(s.users.id, actor.userId));
      }
      // This is the still-paused request's old ctx snapshot, including isOwner=true.
      const staleActor = { ...actor };
      const writes = [
        () =>
          createRole(
            {
              label: "تصعيد",
              baseRole: "user",
              permissions: {},
              operationPolicy: policy({ [sale]: true }),
            },
            staleActor,
          ),
        () =>
          updateRole(
            {
              id: role.id,
              operationPolicy: policy({ [returned]: true }),
              expectedOperationPolicyRevision: 1,
            },
            staleActor,
          ),
        () =>
          createUser(
            {
              name: "تصعيد",
              username: "escalation",
              password: "Strong12345!",
              operationPolicy: policy({ [sale]: true }),
            },
            staleActor,
          ),
        () =>
          updateUser(
            {
              userId,
              operationPolicy: policy({ [returned]: true }),
              expectedOperationPolicyRevision: 0,
            },
            staleActor,
          ),
      ];
      for (const write of writes)
        await expect(write()).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await getRole(role.id)).toEqual(previousRole);
      expect(await getUser(userId)).toEqual(previousUser);
      expect(await db().select().from(s.roles)).toHaveLength(
        revocation.includes("custom role") ? 2 : 1,
      );
      expect(await db().select().from(s.users)).toHaveLength(2);
      expect(await db().select().from(s.auditLogs)).toEqual(previousAudits);
    },
  );

  it("an administrator whose owner flag was revoked cannot restore ownership from a paused self-update", async () => {
    await db().update(s.users).set({ isOwner: false }).where(eq(s.users.id, 1));
    const [before] = await db().select().from(s.users).where(eq(s.users.id, 1));
    await expect(
      updateUser({ userId: 1, isOwner: true }, actor),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      (await db().select().from(s.users).where(eq(s.users.id, 1)))[0],
    ).toEqual(before);
    expect(await db().select().from(s.auditLogs)).toHaveLength(0);
  });

  it("normalizes a persisted owner with manager role and ignores missing or forged request authority", async () => {
    await db()
      .update(s.users)
      .set({ role: "manager" })
      .where(eq(s.users.id, 1));
    const untrustedSnapshot = {
      userId: 1,
      branchId: 99,
      role: "cashier",
      isOwner: false,
    };
    const role = await createRole(
      {
        label: "مالك",
        baseRole: "user",
        permissions: {},
        operationPolicy: policy({ [sale]: true }),
      },
      untrustedSnapshot,
    );
    const { userId } = await createUser(
      {
        name: "موظف",
        username: "ownercreated",
        password: "Strong12345!",
        customRoleId: role.id,
      },
      untrustedSnapshot,
    );
    expect((await getUser(userId))?.branchId).toBe(1);
    await updateRole(
      {
        id: role.id,
        operationPolicy: policy({ [returned]: true }),
        expectedOperationPolicyRevision: 1,
      },
      untrustedSnapshot,
    );
    await updateUser({ userId, isOwner: true }, untrustedSnapshot);
    expect((await getRole(role.id))?.operationPolicyRevision).toBe(2);
    expect((await getUser(userId))?.isOwner).toBe(true);
  });

  it("accepts an actor without a role snapshot only when the persisted account is an administrator", async () => {
    await db().update(s.users).set({ isOwner: false }).where(eq(s.users.id, 1));
    const role = await createRole(
      { label: "قديم", baseRole: "user", permissions: {} },
      { userId: 1, branchId: 1 },
    );
    await updateRole(
      { id: role.id, label: "محدث" },
      { userId: 1, branchId: 1 },
    );
    await expect(
      createRole(
        { label: "مزيف", baseRole: "user", permissions: {} },
        { userId: 999, branchId: 1, role: "admin", isOwner: true },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await getRole(role.id))?.label).toBe("محدث");
  });

  it("self-editing an assigned legacy administrator does not upgrade shared role or user locks", async () => {
    await db().insert(s.roles).values({
      id: 70,
      key: "legacy_actor_admin",
      label: "إدارة",
      baseRole: "admin",
      permissions: {},
    });
    await db()
      .update(s.users)
      .set({ isOwner: false, customRoleId: 70 })
      .where(eq(s.users.id, 1));
    await updateUser(
      {
        userId: 1,
        name: "تعديل ذاتي",
        operationPolicy: policy({ [sale]: false }),
        expectedOperationPolicyRevision: 0,
      },
      actor,
    );
    expect((await getUser(1))?.operationPolicyRevision).toBe(1);
    expect((await getUser(1))?.name).toBe("تعديل ذاتي");
  });

  it("opposing role edits take role and affected user locks in a common order", async () => {
    await db()
      .insert(s.roles)
      .values([
        {
          id: 70,
          key: "admin_left",
          label: "إدارة يسار",
          baseRole: "admin",
          permissions: {},
        },
        {
          id: 80,
          key: "admin_right",
          label: "إدارة يمين",
          baseRole: "admin",
          permissions: {},
        },
      ]);
    await db()
      .update(s.users)
      .set({ isOwner: false, customRoleId: 70 })
      .where(eq(s.users.id, 1));
    await db().insert(s.users).values({
      id: 2,
      openId: "other_admin",
      name: "مدير آخر",
      role: "admin",
      customRoleId: 80,
      branchId: 1,
    });
    const results = await Promise.all([
      updateRole({ id: 70, label: "يسار محدث" }, { userId: 2, branchId: 1 }),
      updateRole({ id: 80, label: "يمين محدث" }, { userId: 1, branchId: 1 }),
    ]);
    expect(results.every((result) => result.changed)).toBe(true);
    expect((await getRole(70))?.label).toBe("يسار محدث");
    expect((await getRole(80))?.label).toBe("يمين محدث");
  });

  it("rejects admin as the base for a blank configurable role", async () => {
    await expect(
      createRole(
        {
          label: "دور فارغ",
          baseRole: "admin",
          permissions: {},
          operationPolicy: policy({}),
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects canonical conversion of a persisted legacy admin custom role", async () => {
    await db().insert(s.roles).values({
      id: 50,
      key: "legacy_admin",
      label: "مدير قديم",
      baseRole: "admin",
      permissions: {},
    });
    await expect(
      updateRole(
        {
          id: 50,
          operationPolicy: policy({}),
          expectedOperationPolicyRevision: 0,
        },
        actor,
      ),
    ).rejects.toThrow(/إدارة الهويات/);
    expect((await getRole(50))?.operationPolicy).toBeNull();
  });

  it("persists role policy and starts its revision; missing grants deny regardless of base role", async () => {
    const role = await makeRole({ [sale]: true }, "manager");
    expect(role.operationPolicyRevision).toBe(1);
    const { userId } = await makeUser(role.id);
    const user = await resolve(userId);
    expect(user.operationPolicyEnabled).toBe(true);
    expect(user.resolvedOperationPolicy?.grants[sale]).toBe(true);
    expect(user.resolvedOperationPolicy?.grants[returned]).toBe(false);
    expect(user.resolvedOperationPolicy?.dataVisibility?.purchaseCost).toBe(
      false,
    );
  });

  it("empty saved role fails closed instead of activating legacy base-role grants", async () => {
    const role = await makeRole({}, "cashier");
    const { userId } = await makeUser(role.id);
    const user = await resolve(userId);
    expect(user.operationPolicyEnabled).toBe(true);
    expect(user.resolvedOperationPolicy?.grants[sale]).toBe(false);
  });

  it("rejects clearing a canonical role without changing its permissions, revision, or audit", async () => {
    const role = await makeRole({ [sale]: true }, "manager");
    const { userId } = await makeUser(role.id);
    const before = await getRole(role.id);
    const [userBefore] = await db()
      .select()
      .from(s.users)
      .where(eq(s.users.id, userId));
    const auditBefore = await db().select().from(s.auditLogs);
    await expect(
      updateRole(
        {
          id: role.id,
          operationPolicy: null,
          expectedOperationPolicyRevision: 1,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const after = await getRole(role.id);
    expect(after?.operationPolicy).toEqual(before?.operationPolicy);
    expect(after?.permissions).toEqual(before?.permissions);
    expect(after?.operationPolicyRevision).toBe(
      before?.operationPolicyRevision,
    );
    expect((await resolve(userId)).sessionsValidFrom).toEqual(
      userBefore.sessionsValidFrom,
    );
    expect(await db().select().from(s.auditLogs)).toEqual(auditBefore);
  });

  it("allows revoking all canonical role grants while preserving its independent policy", async () => {
    const role = await makeRole({ [sale]: true }, "manager");
    const { userId } = await makeUser(role.id);
    await updateRole(
      {
        id: role.id,
        operationPolicy: { version: 1, grants: {} },
        expectedOperationPolicyRevision: 1,
      },
      actor,
    );
    const user = await resolve(userId);
    expect(user.operationPolicyEnabled).toBe(true);
    expect(user.resolvedOperationPolicy?.grants[sale]).toBe(false);
    expect((await getRole(role.id))?.operationPolicyRevision).toBe(2);
  });

  it("keeps an untouched legacy role nullable without changing its revision", async () => {
    const role = await createRole(
      {
        label: "دور قديم",
        baseRole: "cashier",
        permissions: { sales: "READ" },
      },
      actor,
    );
    const before = await getRole(role.id);
    await updateRole({ id: role.id, operationPolicy: null }, actor);
    expect(await getRole(role.id)).toEqual(before);
  });

  it("sparse user allow and deny override separate role grants", async () => {
    const role = await makeRole({ [sale]: true, [returned]: false });
    const { userId } = await makeUser(role.id, {
      version: 1,
      grants: { [sale]: false, [returned]: true },
    });
    const user = await resolve(userId);
    expect(user.resolvedOperationPolicy?.grants[sale]).toBe(false);
    expect(user.resolvedOperationPolicy?.grants[returned]).toBe(true);
    const editor = await getUser(userId);
    expect(editor?.inheritedOperationPolicy?.grants[sale]).toBe(true);
    expect(editor?.operationPolicyRevision).toBe(1);
  });

  it("role edits propagate fresh to assignees while preserving only explicit user differences", async () => {
    const role = await makeRole({ [sale]: true, [returned]: true });
    const { userId } = await makeUser(role.id, {
      version: 1,
      grants: { [returned]: false },
    });
    const [before] = await db()
      .select()
      .from(s.users)
      .where(eq(s.users.id, userId));
    await updateRole(
      {
        id: role.id,
        operationPolicy: policy({ [sale]: false, [returned]: true }),
        expectedOperationPolicyRevision: 1,
      },
      actor,
    );
    const user = await resolve(userId);
    expect(user.resolvedOperationPolicy?.grants[sale]).toBe(false);
    expect(user.resolvedOperationPolicy?.grants[returned]).toBe(false);
    expect(user.inheritedOperationPolicyRevision).toBe(2);
    expect(user.sessionsValidFrom.getTime()).toBeGreaterThan(
      before.sessionsValidFrom.getTime(),
    );
  });

  it("rejects stale role writes under the lock and retains the winner", async () => {
    const role = await makeRole({ [sale]: true });
    await updateRole(
      {
        id: role.id,
        operationPolicy: policy({ [sale]: false }),
        expectedOperationPolicyRevision: 1,
      },
      actor,
    );
    await expect(
      updateRole(
        {
          id: role.id,
          operationPolicy: policy({ [returned]: true }),
          expectedOperationPolicyRevision: 1,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await getRole(role.id))?.operationPolicy).toEqual(
      policy({ [sale]: false }),
    );
  });

  it("serializes competing policy writes so only one expected revision wins", async () => {
    const role = await makeRole({ [sale]: true });
    const attempts = await Promise.allSettled([
      updateRole(
        {
          id: role.id,
          operationPolicy: policy({ [sale]: false }),
          expectedOperationPolicyRevision: 1,
        },
        actor,
      ),
      updateRole(
        {
          id: role.id,
          operationPolicy: policy({ [returned]: true }),
          expectedOperationPolicyRevision: 1,
        },
        actor,
      ),
    ]);
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect((await getRole(role.id))?.operationPolicyRevision).toBe(2);
  });

  it("requires a revision for a changing user policy and rejects stale replacement", async () => {
    const { userId } = await makeUser(undefined, {
      version: 1,
      grants: { [sale]: false },
    });
    await expect(
      updateUser(
        { userId, operationPolicy: { version: 1, grants: { [sale]: true } } },
        actor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await updateUser(
      {
        userId,
        operationPolicy: { version: 1, grants: { [sale]: true } },
        expectedOperationPolicyRevision: 1,
      },
      actor,
    );
    await expect(
      updateUser(
        {
          userId,
          operationPolicy: { version: 1, grants: { [returned]: true } },
          expectedOperationPolicyRevision: 1,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("treats key reordering as a no-op without incrementing policy revision", async () => {
    const role = await makeRole({ [sale]: true, [returned]: false });
    const result = await updateRole(
      {
        id: role.id,
        operationPolicy: policy({ [returned]: false, [sale]: true }),
        expectedOperationPolicyRevision: 1,
      },
      actor,
    );
    expect(result.operationPolicyRevision).toBe(1);
  });

  it("null user policy restores role inheritance and clears dormant legacy overrides", async () => {
    const role = await makeRole({ [sale]: true });
    const { userId } = await makeUser(role.id, {
      version: 1,
      grants: { [sale]: false },
    });
    await db()
      .update(s.users)
      .set({
        permissionsOverride: { sales: "NONE" },
        atomicPermissions: { "pos.invoice.create": false },
      })
      .where(eq(s.users.id, userId));
    await updateUser(
      { userId, operationPolicy: null, expectedOperationPolicyRevision: 1, permissionsOverride: { sales: "NONE" }, atomicPermissions: { "pos.invoice.create": false } },
      actor,
    );
    const user = await resolve(userId);
    expect(user.operationPolicy).toBeNull();
    expect(user.atomicPermissions).toBeNull();
    expect(user.resolvedOperationPolicy?.grants[sale]).toBe(true);
  });

  it("preserves old individual denials when a role converts, with context and fresh-service parity", async () => {
    const role = await createRole({ label: "قديم", baseRole: "cashier", permissions: {} }, actor);
    const { userId } = await makeUser(role.id);
    await db().update(s.users).set({ permissionsOverride: { sales: "NONE" }, atomicPermissions: { "pos.return.create": false } }).where(eq(s.users.id, userId));
    await updateRole({ id: role.id, operationPolicy: policy({ [sale]: true, [returned]: true }), expectedOperationPolicyRevision: 0 }, actor);
    const resolved = await resolve(userId);
    expect(resolved.resolvedOperationPolicy?.grants[sale]).toBe(false);
    expect(resolved.resolvedOperationPolicy?.grants[returned]).toBe(false);
    expect((await getUser(userId)).resolvedOperationPolicy?.grants[returned]).toBe(false);
    const [stored] = await db().select().from(s.users).where(eq(s.users.id, userId));
    const [storedRole] = await db().select().from(s.roles).where(eq(s.roles.id, role.id));
    const { storedOperationUser } = await import("../authorization/operationAuthority");
    expect(storedOperationUser(stored!, storedRole!).resolvedOperationPolicy?.grants[returned]).toBe(false);
    await updateUser({ userId, operationPolicy: policy({}), expectedOperationPolicyRevision: 0 }, actor);
    const converted = await resolve(userId);
    expect(converted.atomicPermissions).toBeNull();
    expect(converted.resolvedOperationPolicy?.grants[sale]).toBe(true);
    expect(converted.resolvedOperationPolicy?.grants[returned]).toBe(true);
  });

  it("untouched cashier receives the daily-task preset without storing an individual policy", async () => {
    const { userId } = await makeUser();
    const user = await resolve(userId);
    expect(user.operationPolicyEnabled).toBe(true);
    expect(user.operationPolicy).toBeNull();
    expect(user.roleOperationPolicy).not.toBeNull();
    expect(user.resolvedOperationPolicy?.grants[sale]).toBe(true);
  });

  it("keeps an untouched courier in the one-screen shell despite the default operation preset", async () => {
    await db().insert(s.users).values({
      openId: "courier-default",
      username: "courier-default",
      name: "مندوب افتراضي",
      role: "courier",
      branchId: 1,
    });
    const [row] = await db().select({ id: s.users.id }).from(s.users).where(eq(s.users.username, "courier-default"));
    const user = await resolve(Number(row.id));
    expect(user.operationPolicyEnabled).toBe(true);
    expect(user.courierShellOnly).toBe(true);
    expect(user.operationPolicy).toBeNull();
  });

  it("lets an explicitly configured courier role leave the one-screen default shell", async () => {
    const role = await makeRole(
      { "operation.courier.myDeliveries": true },
      "courier",
    );
    const { userId } = await makeUser(role.id);
    const user = await resolve(userId);
    expect(user.role).toBe("courier");
    expect(user.courierShellOnly).toBe(false);
  });

  it("validates keys at the service boundary as well as router input", async () => {
    await expect(
      makeRole({ "operation.nonexistent.execute": true }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await db().select().from(s.roles)).toHaveLength(0);
  });

  it("rejects malformed persisted policy instead of interpreting it as inherited authority", async () => {
    const role = await makeRole({ [sale]: true });
    const { userId } = await makeUser(role.id);
    await db()
      .update(s.roles)
      .set({ operationPolicy: { version: 1, grants: { [sale]: "true" } } })
      .where(eq(s.roles.id, role.id));
    await expect(resolve(userId)).rejects.toThrow();
  });

  it("records exact policy changes and revisions in the transaction", async () => {
    const role = await makeRole({ [sale]: true });
    await updateRole(
      {
        id: role.id,
        operationPolicy: policy({ [sale]: false, [returned]: true }),
        expectedOperationPolicyRevision: 1,
      },
      actor,
    );
    const rows = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.action, "role.operationPolicy"));
    const event = rows.find(
      (row) =>
        (row.newValue as { operationPolicyRevision?: number })
          ?.operationPolicyRevision === 2,
    );
    expect(event?.newValue).toMatchObject({
      operationPolicyRevision: 2,
      changes: expect.arrayContaining([
        { field: `grants.${sale}`, before: true, after: false },
        { field: `grants.${returned}`, before: null, after: true },
      ]),
    });
  });

  it("retains every grant delta when a full catalogue exceeds a single audit value", async () => {
    const grants = Object.fromEntries(
      OPERATION_PERMISSIONS.filter((operation) => operation.delegable).map(
        (operation) => [operation.key, true],
      ),
    );
    const role = await makeRole(grants);
    const rows = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.entityId, String(role.id)));
    expect(rows.length).toBeGreaterThan(1);
    const events = rows.map(
      (row) =>
        row.newValue as {
          _truncated?: boolean;
          changes: Array<{ field: string }>;
        },
    );
    expect(events.every((event) => !event._truncated)).toBe(true);
    const grantFields = events
      .flatMap((event) => event.changes)
      .filter((change) => change.field.startsWith("grants."));
    expect(new Set(grantFields.map((change) => change.field)).size).toBe(
      Object.keys(grants).length,
    );
  });

  it("audit failure rolls back policy, revision, and session invalidation", async () => {
    const role = await makeRole({ [sale]: true });
    const { userId } = await makeUser(role.id);
    const [before] = await db()
      .select()
      .from(s.users)
      .where(eq(s.users.id, userId));
    vi.spyOn(audit, "logAuditTx").mockRejectedValueOnce(
      new Error("audit insert unavailable"),
    );
    await expect(
      updateRole(
        {
          id: role.id,
          operationPolicy: policy({ [sale]: false }),
          expectedOperationPolicyRevision: 1,
        },
        actor,
      ),
    ).rejects.toThrow("audit insert unavailable");
    expect((await getRole(role.id))?.operationPolicyRevision).toBe(1);
    expect((await resolve(userId)).sessionsValidFrom).toEqual(
      before.sessionsValidFrom,
    );
  });

  it("owner authority remains normalized and cannot acquire an ineffective custom policy", async () => {
    await expect(
      updateUser(
        {
          userId: 1,
          operationPolicy: policy({ [sale]: false }),
          expectedOperationPolicyRevision: 0,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const [row] = await db().select().from(s.users).where(eq(s.users.id, 1));
    const user = normalizeOwnerAuthority({
      ...row,
      role: "cashier",
      operationPolicy: policy({}),
    } as AuthUser);
    expect(user.role).toBe("admin");
    expect(user.operationPolicyEnabled).toBe(false);
    expect(user.operationPolicy).toBeNull();
  });
});
