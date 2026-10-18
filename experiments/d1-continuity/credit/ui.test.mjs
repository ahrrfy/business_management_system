import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";

const source = await readFile(new URL("./ui.ts", import.meta.url), "utf8");
const script = source.match(/<script>([\s\S]*?)<\/script>/)[1];
const buttons = [
  "connect",
  "newSale",
  "sale",
  "saleLookup",
  "newPayment",
  "payment",
  "paymentLookup",
  "evidence",
];
const settle = () => new Promise((resolve) => setImmediate(resolve));
function page(storage, fetch) {
  const fields = Object.fromEntries(
    [
      ...buttons,
      "key",
      "terminal",
      "customer",
      "quantity",
      "initial",
      "invoice",
      "amount",
      "saleId",
      "paymentId",
      "status",
      "result",
    ].map((id) => [id, { value: "", disabled: false, textContent: "" }]),
  );
  Object.assign(fields.terminal, { value: "11" });
  Object.assign(fields.quantity, { value: "1" });
  Object.assign(fields.initial, { value: "0" });
  Object.assign(fields.customer, { value: "5" });
  Object.assign(fields.amount, { value: "20" });
  runInNewContext(script, {
    document: {
      getElementById: (id) => fields[id],
      querySelectorAll: () => buttons.map((id) => fields[id]),
    },
    localStorage: {
      getItem: (key) => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
    },
    fetch,
    crypto: webcrypto,
  });
  fields.key.value = "synthetic-ui-test";
  const click = async (id) => {
    fields[id].onclick();
    await settle();
  };
  return {
    fields,
    click,
    saved: () => JSON.parse(storage.get("credit-lab-actual-v1")),
  };
}
const reply = (status, body) => ({
  ok: status === 200,
  status,
  json: async () => body,
});

test("first invalid-input400 permits correction without unlocking a previously uncertain request", async () => {
  const storage = new Map();
  let status = 400;
  const fetch = async (route) =>
    route === "/ready"
      ? reply(200, { ready: true })
      : reply(status, {
          code:
            status === 400
              ? "INVALID_CREDIT_INPUT"
              : "PRIMARY_COMMITTED_RECOVERY_PENDING",
          retryWithOriginalRequest: status !== 400,
        });
  let p = page(storage, fetch);
  await p.click("connect");
  p.fields.quantity.value = "invalid";
  await p.click("newSale");
  await p.click("sale");
  assert.equal(p.fields.newSale.disabled, false);
  assert.equal(p.saved().rejected[0].input.lines[0].quantity, "invalid");
  p.fields.quantity.value = "1";
  await p.click("newSale");
  await p.click("connect");
  status = 503;
  await p.click("sale");
  const unknown = p.saved().sale;
  p = page(storage, fetch);
  status = 400;
  await p.click("sale");
  assert.equal(p.fields.newSale.disabled, true);
  await p.click("newSale");
  assert.deepEqual(p.saved().sale, unknown);
});

test("pending primary ACK survives prepare-new and reload; original retry needs no new readiness", async () => {
  const storage = new Map();
  let recovered = false;
  const posted = [];
  const fetch = async (route, init) => {
    if (route === "/ready")
      return reply(
        recovered ? 503 : 200,
        recovered ? { code: "RECOVERY_PREFIX_PENDING" } : { ready: true },
      );
    posted.push(JSON.parse(init.body));
    return reply(
      recovered ? 200 : 503,
      recovered
        ? { recoveryAcknowledged: true, invoiceId: 7 }
        : { code: "PRIMARY_COMMITTED_RECOVERY_PENDING" },
    );
  };
  let p = page(storage, fetch);
  await p.click("connect");
  await p.click("newSale");
  await p.click("sale");
  const original = p.saved().sale;
  assert.equal(p.fields.newSale.disabled, true);
  await p.click("newSale");
  assert.deepEqual(p.saved().sale, original);
  p = page(storage, fetch);
  assert.equal(p.fields.sale.disabled, false);
  assert.equal(p.saved().saleTerminal, "11");
  recovered = true;
  await p.click("connect");
  assert.equal(p.fields.sale.disabled, false);
  await p.click("sale");
  assert.deepEqual(posted, [original, original]);
  assert.equal(p.fields.newSale.disabled, false);
});

test("lost collection reply stays immutable through reload until CONFIRMED lookup", async () => {
  const storage = new Map();
  const fetch = async (route) => {
    if (route === "/ready") return reply(200, { ready: true });
    if (route === "/payment")
      throw Error("connection lost after server commit");
    return reply(200, {
      state: "CONFIRMED",
      clientRequestId: JSON.parse(storage.get("credit-lab-actual-v1")).payment
        .clientRequestId,
      recoveryAcknowledged: true,
    });
  };
  let p = page(storage, fetch);
  await p.click("connect");
  p.fields.invoice.value = "7";
  await p.click("newPayment");
  await p.click("payment");
  const original = p.saved().payment;
  await p.click("newPayment");
  assert.deepEqual(p.saved().payment, original);
  p = page(storage, fetch);
  assert.equal(p.fields.newPayment.disabled, true);
  await p.click("paymentLookup");
  assert.equal(p.fields.newPayment.disabled, false);
  assert.deepEqual(p.saved().payment, original);
});

test("definitive first rejection keeps rejected history and permits correction; later unknown key stays locked", async () => {
  const storage = new Map();
  let rejected = true;
  const fetch = async (route) =>
    route === "/ready"
      ? reply(200, { ready: true })
      : rejected
        ? reply(403, { code: "FORBIDDEN", retryWithOriginalRequest: false })
        : reply(503, { code: "PRIMARY_COMMITTED_RECOVERY_PENDING" });
  const p = page(storage, fetch);
  await p.click("connect");
  p.fields.customer.value = "4";
  await p.click("newSale");
  await p.click("sale");
  assert.equal(p.fields.newSale.disabled, false);
  assert.equal(p.saved().rejected[0].input.customerId, 4);
  p.fields.customer.value = "5";
  await p.click("newSale");
  rejected = false;
  await p.click("connect");
  await p.click("sale");
  const original = p.saved().sale;
  assert.equal(p.fields.newSale.disabled, true);
  await p.click("newSale");
  assert.deepEqual(p.saved().sale, original);
});
