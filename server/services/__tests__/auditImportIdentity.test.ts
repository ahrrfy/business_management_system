import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountingEntries,
  branches,
  customers,
  doubleEntrySettings,
  suppliers,
  users,
} from "../../../drizzle/schema";
import { getDb, type Tx } from "../../db";
import * as transaction from "../tx";
import { importCustomers } from "../import/customers";
import { importSuppliers } from "../import/suppliers";
import type { ImportOptions } from "../import/types";

const actor = { userId: 1, branchId: 1 };
const db = () => getDb()!;
type Row = {
  rowNumber: number;
  name: string;
  phone?: string;
  legacyCode?: string;
  address?: string;
  openingBalance?: string;
  currency?: "IQD";
};
type Seed = {
  name: string;
  phone?: string;
  legacyCode?: string;
  address?: string;
  currentBalance?: string;
};
const cases = [
  {
    kind: "customer",
    run: (rows: Row[], options: ImportOptions) =>
      importCustomers(rows, options, actor),
    seed: async (values: Seed[]) => {
      await db().insert(customers).values(values);
    },
    read: () => db().select().from(customers),
    changeAlias: () =>
      db()
        .update(customers)
        .set({ legacyCode: "claimed-elsewhere" })
        .where(eq(customers.name, "Alpha")),
    byName: (name: string) =>
      db().select().from(customers).where(eq(customers.name, name)),
  },
  {
    kind: "supplier",
    run: (rows: Row[], options: ImportOptions) =>
      importSuppliers(rows, options, actor),
    seed: async (values: Seed[]) => {
      await db().insert(suppliers).values(values);
    },
    read: () => db().select().from(suppliers),
    changeAlias: () =>
      db()
        .update(suppliers)
        .set({ legacyCode: "claimed-elsewhere" })
        .where(eq(suppliers.name, "Alpha")),
    byName: (name: string) =>
      db().select().from(suppliers).where(eq(suppliers.name, name)),
  },
];

beforeEach(async () => {
  await db()
    .insert(branches)
    .values({ id: 1, name: "Import identity", code: "MAIN", type: "MAIN" });
  await db().insert(users).values({
    id: 1,
    name: "Import identity",
    openId: "audit-import-identity",
    role: "admin",
  });
});
afterEach(() => vi.restoreAllMocks());

for (const c of cases)
  describe(`${c.kind} import identity`, () => {
    it("updates the matching name and phone among legitimate shared-phone parties", async () => {
      await c.seed([
        { name: "Alpha", phone: "0770001" },
        { name: "Beta", phone: "0770001" },
      ]);
      const result = await c.run(
        [
          {
            rowNumber: 1,
            name: "Alpha",
            phone: "0770001",
            address: "Alpha address",
          },
        ],
        { onExisting: "update" },
      );
      expect(result).toMatchObject({ updated: 1, failed: 0, committed: true });
      expect((await c.byName("Alpha"))[0].address).toBe("Alpha address");
      expect((await c.byName("Beta"))[0].address).toBeNull();
    });

    for (const onExisting of ["skip", "update", "error"] as const)
      it(`creates a new name sharing an existing phone in ${onExisting} mode`, async () => {
        await c.seed([{ name: "Alpha", phone: "0770001" }]);
        const result = await c.run(
          [{ rowNumber: 1, name: "Beta", phone: "0770001" }],
          { onExisting },
        );
        expect(result).toMatchObject({
          created: 1,
          failed: 0,
          committed: true,
        });
        expect(await c.read()).toHaveLength(2);
      });

    it("rejects ambiguous canonical identities instead of selecting the last database row", async () => {
      await c.seed([
        { name: "Alpha", phone: "0770001" },
        { name: "Alpha", phone: "0770001" },
      ]);
      const result = await c.run(
        [{ rowNumber: 1, name: "Alpha", phone: "0770001", address: "wrong" }],
        { onExisting: "update" },
      );
      expect(result).toMatchObject({ failed: 1, committed: false });
      expect(result.rows[0].message).toMatch(/AMBIGUOUS/);
      expect((await c.read()).every((party) => party.address === null)).toBe(
        true,
      );
    });

    it("rejects a legacy alias that conflicts with a different canonical party", async () => {
      await c.seed([
        { name: "Alpha", phone: "0770001", legacyCode: "old-alpha" },
        { name: "Beta", phone: "0770002" },
      ]);
      const result = await c.run(
        [
          {
            rowNumber: 1,
            name: "Beta",
            phone: "0770002",
            legacyCode: "old-alpha",
            address: "wrong",
          },
        ],
        { onExisting: "update" },
      );
      expect(result).toMatchObject({ failed: 1, committed: false });
      expect(result.rows[0].message).toMatch(/IDENTITY_MISMATCH/);
      expect((await c.read()).every((party) => party.address === null)).toBe(
        true,
      );
    });

    it("does not replace a canonical party's different existing legacy alias", async () => {
      await c.seed([
        { name: "Alpha", phone: "0770001", legacyCode: "old-alpha" },
      ]);
      const result = await c.run(
        [
          {
            rowNumber: 1,
            name: "Alpha",
            phone: "0770001",
            legacyCode: "unrelated-source",
          },
        ],
        { onExisting: "update" },
      );
      expect(result).toMatchObject({ failed: 1, committed: false });
      expect(result.rows[0].message).toMatch(/IDENTITY_MISMATCH/);
      expect((await c.read())[0].legacyCode).toBe("old-alpha");
    });

    it("matches a known legacy alias despite changed source name and phone", async () => {
      await c.seed([
        {
          name: "Alpha",
          phone: "0770001",
          legacyCode: "OLD-A",
          currentBalance: "17.00",
        },
      ]);
      const result = await c.run(
        [
          {
            rowNumber: 1,
            name: "Source old name",
            phone: "0770099",
            legacyCode: "old-a",
            address: "updated",
            openingBalance: "99",
            currency: "IQD",
          },
        ],
        { onExisting: "update" },
      );
      expect(result).toMatchObject({ updated: 1, failed: 0, committed: true });
      const party = (await c.read())[0];
      expect(party).toMatchObject({
        name: "Alpha",
        phone: "0770099",
        address: "updated",
        currentBalance: "17.00",
      });
      expect(result.rows[0].message).toContain("الرصيد الافتتاحي لا");
    });

    it("makes the same decision in preview and repeated execution without duplicating opening balances", async () => {
      await c.seed([
        { name: "Alpha", phone: "0770001" },
        { name: "Beta", phone: "0770001" },
      ]);
      const rows: Row[] = [
        {
          rowNumber: 1,
          name: "  ALPHA  ",
          phone: "0770001",
          legacyCode: "NEW-A",
          address: "updated",
        },
      ];
      expect(
        await c.run(rows, { onExisting: "update", dryRun: true }),
      ).toMatchObject({ updated: 1, committed: false });
      expect((await c.read()).every((party) => party.address === null)).toBe(
        true,
      );
      expect(await c.run(rows, { onExisting: "update" })).toMatchObject({
        updated: 1,
        committed: true,
      });
      expect(await c.run(rows, { onExisting: "skip" })).toMatchObject({
        skipped: 1,
        created: 0,
      });
      expect((await c.byName("Alpha"))[0].legacyCode).toBe("NEW-A");
      expect(await c.read()).toHaveLength(2);
    });

    it("rejects multiple source aliases targeting the same party within one batch", async () => {
      await c.seed([{ name: "Alpha", phone: "0770001" }]);
      const result = await c.run(
        [
          { rowNumber: 1, name: "Alpha", phone: "0770001", legacyCode: "A" },
          { rowNumber: 2, name: "Alpha", phone: "0770001", legacyCode: "B" },
        ],
        { onExisting: "update" },
      );
      expect(result).toMatchObject({ failed: 1, committed: false });
      expect(
        result.rows.find((row) => row.status === "failed")?.message,
      ).toMatch(/IDENTITY_MISMATCH/);
      expect((await c.read())[0].legacyCode).toBeNull();
    });

    it("revalidates an alias changed after planning while holding the target row lock", async () => {
      await c.seed([{ name: "Alpha", phone: "0770001" }]);
      const realWithTx = transaction.withTx;
      vi.spyOn(transaction, "withTx").mockImplementationOnce(
        async <T>(
          fn: (tx: Tx) => Promise<T>,
          options?: Parameters<typeof transaction.withTx>[1],
        ) => {
          await c.changeAlias();
          return realWithTx(fn, options);
        },
      );
      const result = await c.run(
        [
          {
            rowNumber: 1,
            name: "Alpha",
            phone: "0770001",
            legacyCode: "source-a",
            address: "wrong",
          },
        ],
        { onExisting: "update" },
      );
      expect(result).toMatchObject({ failed: 1, committed: false });
      expect(result.rows[0].message).toMatch(/IDENTITY_MISMATCH/);
      expect((await c.read())[0]).toMatchObject({
        legacyCode: "claimed-elsewhere",
        address: null,
      });
    });

    it("refuses conflicting aliases for the same planned new canonical identity without guessing", async () => {
      const rows: Row[] = [
        { rowNumber: 1, name: "Alpha", phone: "0770001", legacyCode: "A" },
        { rowNumber: 2, name: "Alpha", phone: "0770001", legacyCode: "B" },
      ];
      const result = await c.run(rows, { onExisting: "update" });
      expect(result).toMatchObject({ failed: 1, committed: false });
      expect(
        result.rows.find((row) => row.status === "failed")?.message,
      ).toMatch(/IDENTITY_MISMATCH.*راجع/);
      expect(await c.read()).toHaveLength(0);
      expect(
        await c.run(rows, { onExisting: "update", dryRun: true }),
      ).toMatchObject({ failed: 1, committed: false });
    });

    it("preserves distinct existing same-canonical parties identified by their own legacy code", async () => {
      await c.seed([
        {
          name: "Alpha",
          phone: "0770001",
          legacyCode: "A",
          currentBalance: "17.00",
        },
        {
          name: "Alpha",
          phone: "0770001",
          legacyCode: "B",
          currentBalance: "23.00",
        },
      ]);
      const result = await c.run(
        [
          {
            rowNumber: 1,
            name: "Alpha",
            phone: "0770001",
            legacyCode: "A",
            address: "only A",
            openingBalance: "999",
            currency: "IQD",
          },
          {
            rowNumber: 2,
            name: "Alpha",
            phone: "0770001",
            legacyCode: "B",
            address: "only B",
          },
        ],
        { onExisting: "update" },
      );
      expect(result).toMatchObject({ updated: 2, failed: 0, committed: true });
      const parties = await c.read();
      expect(parties.find((party) => party.legacyCode === "A")).toMatchObject({
        address: "only A",
        currentBalance: "17.00",
      });
      expect(parties.find((party) => party.legacyCode === "B")).toMatchObject({
        address: "only B",
        currentBalance: "23.00",
      });
    });

    for (const explicitAliases of [false, true])
      it(`concurrent empty-target ${explicitAliases ? "distinct-alias" : "no-alias"} imports create one party and one opening effect`, async () => {
        // Pre-existing runtime settings prevent its unrelated bootstrap gap-lock
        // deadlock from making a duplicate-identity regression appear to pass.
        await db().insert(doubleEntrySettings).values({ id: 1, mode: "OFF" });
        const realWithTx = transaction.withTx;
        // Make both real service calls finish their empty-target planning before
        // either transaction starts; only the boundary is paused, not DB effects.
        await realWithTx(async () => {});
        let arrived = 0;
        let release!: () => void;
        const bothPlanned = new Promise<void>((resolve) => {
          release = resolve;
        });
        vi.spyOn(transaction, "withTx").mockImplementation(
          async <T>(
            fn: (tx: Tx) => Promise<T>,
            options?: Parameters<typeof transaction.withTx>[1],
          ) => {
            if (++arrived === 2) release();
            await bothPlanned;
            return realWithTx(fn, options);
          },
        );
        const row: Row = {
          rowNumber: 1,
          name: "Concurrent",
          phone: "0770099",
          openingBalance: "100",
          currency: "IQD",
        };
        const results = await Promise.all([
          c.run(
            [{ ...row, ...(explicitAliases ? { legacyCode: "A" } : {}) }],
            {},
          ),
          c.run(
            [{ ...row, ...(explicitAliases ? { legacyCode: "B" } : {}) }],
            {},
          ),
        ]);
        expect(results.reduce((sum, result) => sum + result.created, 0)).toBe(
          1,
        );
        expect(results.filter((result) => result.committed)).toHaveLength(1);
        expect(await c.read()).toHaveLength(1);
        expect((await c.read())[0].currentBalance).toBe("100.00");
        expect(
          await db()
            .select()
            .from(accountingEntries)
            .where(eq(accountingEntries.entryType, "OPENING")),
        ).toHaveLength(1);
      });
  });
