import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import {
  checkSchemaMoneyTypes,
  checkEmptyCatchBlocks,
  checkHardcodedSecrets,
  checkTransactionBoundaries,
  checkNoParseFloatOnMoney,
  checkAuditLogRecording,
  checkRouterProcedureGating,
  checkSqlParameterization,
  checkDoubleSubmitProtection,
  classifyDomain,
  VERDICTS,
} from "../erpm-forensic-inspect.mjs";

describe("ERPM-Forensic Protocol Inspection Engine", () => {
  it("flags float or double on financial column as CRITICAL", () => {
    const badSchema = `
      export const testInvoices = mysqlTable("test_invoices", {
        id: serial("id").primaryKey(),
        totalAmount: float("total_amount").notNull(),
      });
    `;
    const res = checkSchemaMoneyTypes(badSchema);
    assert.equal(res.verdict, VERDICTS.CRITICAL);
    assert.match(res.details, /totalAmount: float/);
  });

  it("passes compliant decimal definitions", () => {
    const goodSchema = `
      export const testInvoices = mysqlTable("test_invoices", {
        id: serial("id").primaryKey(),
        totalAmount: decimal("total_amount", { precision: 15, scale: 2 }).notNull(),
      });
    `;
    const res = checkSchemaMoneyTypes(goodSchema);
    assert.equal(res.verdict, VERDICTS.PASS);
  });

  it("flags empty catch blocks as WARNING", () => {
    const code = `
      try {
        doSomething();
      } catch (e) {}
    `;
    const res = checkEmptyCatchBlocks(code, "test.ts");
    assert.equal(res.verdict, VERDICTS.WARNING);
  });

  it("passes handled catch blocks", () => {
    const code = `
      try {
        doSomething();
      } catch (e) {
        logger.error(e);
        throw e;
      }
    `;
    const res = checkEmptyCatchBlocks(code, "test.ts");
    assert.equal(res.verdict, VERDICTS.PASS);
  });

  it("flags hardcoded secrets as CRITICAL", () => {
    const code = `const apiKey = "ak_live_1234567890abcdef12345678";`;
    const res = checkHardcodedSecrets(code, "api.ts");
    assert.equal(res.verdict, VERDICTS.CRITICAL);
  });

  it("passes env references or safe tokens", () => {
    const code = `const apiKey = process.env.API_KEY;`;
    const res = checkHardcodedSecrets(code, "api.ts");
    assert.equal(res.verdict, VERDICTS.PASS);
  });

  it("flags unprotected mutating queries on financial tables as CRITICAL", () => {
    const code = `
      export async function mutateDirectly() {
        await db.update(invoices).set({ status: 'PAID' });
      }
    `;
    const res = checkTransactionBoundaries(code, "service.ts");
    assert.equal(res.verdict, VERDICTS.CRITICAL);
  });

  it("passes queries wrapped inside withTx", () => {
    const code = `
      export async function mutateSafely() {
        return withTx(async (tx) => {
          await tx.update(invoices).set({ status: 'PAID' });
        });
      }
    `;
    const res = checkTransactionBoundaries(code, "service.ts");
    assert.equal(res.verdict, VERDICTS.PASS);
  });

  it("passes queries accepting a Tx parameter", () => {
    const code = `
      export async function mutateWithParam(tx: Tx) {
        await tx.update(invoices).set({ status: 'PAID' });
      }
    `;
    const res = checkTransactionBoundaries(code, "service.ts");
    assert.equal(res.verdict, VERDICTS.PASS);
  });

  it("flags parseFloat on money fields as CRITICAL", () => {
    const code = `const total = parseFloat(order.amount) + 50;`;
    const res = checkNoParseFloatOnMoney(code, "calc.ts");
    assert.equal(res.verdict, VERDICTS.CRITICAL);
  });

  it("passes decimal calculations", () => {
    const code = `const total = new Decimal(order.amount).plus(50);`;
    const res = checkNoParseFloatOnMoney(code, "calc.ts");
    assert.equal(res.verdict, VERDICTS.PASS);
  });

  it("flags publicProcedure mutations as CRITICAL", () => {
    const router = `
      export const badRouter = createTRPCRouter({
        deleteInvoice: publicProcedure.mutation(async () => {})
      });
    `;
    const res = checkRouterProcedureGating(router, "badRouter.ts");
    assert.equal(res.verdict, VERDICTS.CRITICAL);
  });

  it("passes protected / module procedures", () => {
    const router = `
      export const goodRouter = createTRPCRouter({
        deleteInvoice: salesManagerProcedure.mutation(async () => {})
      });
    `;
    const res = checkRouterProcedureGating(router, "goodRouter.ts");
    assert.equal(res.verdict, VERDICTS.PASS);
  });

  it("flags raw string interpolation inside sql.raw as CRITICAL", () => {
    const code = "const res = await db.execute(sql.raw(`SELECT * FROM users WHERE email = '${email}'`));";
    const res = checkSqlParameterization(code, "repo.ts");
    assert.equal(res.verdict, VERDICTS.CRITICAL);
  });

  it("passes safe sql template queries", () => {
    const code = "const res = await db.execute(sql`SELECT * FROM users WHERE email = ${email}`);";
    const res = checkSqlParameterization(code, "repo.ts");
    assert.equal(res.verdict, VERDICTS.PASS);
  });

  it("flags unprotected button on pages with mutations as WARNING", () => {
    const page = `
      export function Page() {
        const mut = trpc.useMutation();
        return <button onClick={() => mut.mutate()}>حفظ</button>;
      }
    `;
    const res = checkDoubleSubmitProtection(page, "Page.tsx");
    assert.equal(res.verdict, VERDICTS.WARNING);
  });

  it("passes pages with isPending or SubmitButton", () => {
    const page = `
      export function Page() {
        const mut = trpc.useMutation();
        return <button disabled={mut.isPending}>حفظ</button>;
      }
    `;
    const res = checkDoubleSubmitProtection(page, "Page.tsx");
    assert.equal(res.verdict, VERDICTS.PASS);
  });

  it("classifies file domains correctly", () => {
    assert.match(classifyDomain("server/routers/saleRouter.ts"), /Sales/);
    assert.match(classifyDomain("server/services/returnService.ts"), /Returns/);
    assert.match(classifyDomain("server/services/inventoryService.ts"), /Inventory/);
    assert.match(classifyDomain("server/services/treasuryService.ts"), /Treasury/);
    assert.match(classifyDomain("server/services/payrollService.ts"), /HR/);
  });
});
