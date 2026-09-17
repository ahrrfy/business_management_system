import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../drizzle/migrations/0359_recipe_inventory_integrity.sql",
    import.meta.url,
  ),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(
    new URL(
      "../../../drizzle/migrations/meta/_journal.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  entries?: Array<{
    idx: number;
    tag: string;
    version: string;
    when: number;
    breakpoints: boolean;
  }>;
};
const extraMigrationRunner = readFileSync(
  new URL("../../../scripts/ci-apply-extra-migrations.mjs", import.meta.url),
  "utf8",
);

describe("0359 recipe active-output migration contract", () => {
  it("is registered once in the journal and the db:push repair runner", () => {
    expect(
      journal.entries?.filter(
        (entry) => entry.tag === "0359_recipe_inventory_integrity",
      ),
    ).toEqual([
      {
        idx: 359,
        version: "5",
        when: 1788148817000,
        tag: "0359_recipe_inventory_integrity",
        breakpoints: true,
      },
    ]);
    expect(
      extraMigrationRunner.match(
        /"drizzle\/migrations\/0359_recipe_inventory_integrity\.sql"/g,
      ),
    ).toHaveLength(1);
  });

  it("installs both old-writer guards before cleanup and keeps them through UNIQUE creation", () => {
    const createPreInsert = migration.indexOf(
      "CREATE TRIGGER `trg_0359_recipe_active_pre_bi`",
    );
    const createPreUpdate = migration.indexOf(
      "CREATE TRIGGER `trg_0359_recipe_active_pre_bu`",
    );
    const createFinalInsert = migration.indexOf(
      "CREATE TRIGGER `trg_0359_recipe_active_bi`",
    );
    const createFinalUpdate = migration.indexOf(
      "CREATE TRIGGER `trg_0359_recipe_active_bu`",
    );
    const cleanup = migration.indexOf("UPDATE `productionRecipes` AS older");
    const addUnique = migration.indexOf(
      "ADD UNIQUE KEY `uq_recipe_active_output`",
    );
    const postcondition = migration.indexOf(
      "__0359_RECIPE_ACTIVE_CONTRACT_FAILED__",
    );
    const finalInsertDrop = migration.lastIndexOf(
      "DROP TRIGGER IF EXISTS `trg_0359_recipe_active_bi`",
    );
    const finalUpdateDrop = migration.lastIndexOf(
      "DROP TRIGGER IF EXISTS `trg_0359_recipe_active_bu`",
    );

    for (const position of [
      createPreInsert,
      createPreUpdate,
      createFinalInsert,
      createFinalUpdate,
      cleanup,
      addUnique,
      postcondition,
      finalInsertDrop,
      finalUpdateDrop,
    ]) {
      expect(position).toBeGreaterThanOrEqual(0);
    }
    expect(Math.max(createPreInsert, createPreUpdate)).toBeLessThan(cleanup);
    expect(Math.max(createFinalInsert, createFinalUpdate)).toBeLessThan(cleanup);
    expect(cleanup).toBeLessThan(addUnique);
    expect(addUnique).toBeLessThan(postcondition);
    expect(postcondition).toBeLessThan(finalInsertDrop);
    expect(postcondition).toBeLessThan(finalUpdateDrop);
  });

  it("blocks only active inserts and inactive-to-active or output-retargeting updates", () => {
    expect(migration).toContain("IF NEW.`isActive` = 1 THEN");
    expect(migration).toContain("NOT (OLD.`isActive` <=> 1)");
    expect(migration).toContain(
      "NOT (NEW.`outputVariantId` <=> OLD.`outputVariantId`)",
    );
    expect(migration.match(/SIGNAL SQLSTATE '45000'/g)).toHaveLength(4);
  });

  it("repairs semantic drift and asserts the complete generated-column/index shape", () => {
    expect(migration).toContain("REGEXP_REPLACE(");
    expect(migration).toContain("casewhenisactive=1then1elsenullend");
    expect(migration).toContain("@recipe_active_dependent_index_drops");
    expect(migration).toContain("DROP COLUMN `activeSlot`");
    expect(migration).toContain(
      "1:outputVariantId,2:activeSlot",
    );
    expect(migration).toContain("SUM(NON_UNIQUE = 0) = 2");
    expect(migration).toContain("SUM(UPPER(IS_VISIBLE) = 'YES') = 2");
    expect(migration).toContain("SUM(UPPER(COLLATION) = 'A') = 2");
    expect(migration).toContain("ALGORITHM=INPLACE, LOCK=NONE");
    expect(migration).toContain("@recipe_active_duplicate_groups = 0");
  });

  it("keeps every trigger body in its own runner breakpoint chunk", () => {
    const chunks = migration
      .split(/-->\s*statement-breakpoint/g)
      .map((chunk) => chunk.trim());
    const triggerChunks = chunks.filter((chunk) =>
      chunk.includes("CREATE TRIGGER `trg_0359_recipe_active_"),
    );

    expect(triggerChunks).toHaveLength(4);
    for (const chunk of triggerChunks) {
      expect(chunk).toContain("FOR EACH ROW");
      expect(chunk).toContain("SIGNAL SQLSTATE '45000'");
      expect(chunk.trimEnd().endsWith("END;")).toBe(true);
    }
  });
});
