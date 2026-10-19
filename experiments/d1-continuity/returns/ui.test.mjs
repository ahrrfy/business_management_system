import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
test("return retry hints retain the saved body and terminal after uncertainty and reload", async () => {
  const script = (
    await readFile(new URL("./ui.ts", import.meta.url), "utf8")
  ).match(/<script>([\s\S]*?)<\/script>/)[1];
  const storage = new Map(),
    requests = [];
  const fields = Object.fromEntries(
    [
      ...new Set(
        [...script.matchAll(/q\('([^']+)'\)/g)]
          .map((m) => m[1])
          .concat([
            "sale",
            "payment",
            "return",
            "newSale",
            "newPayment",
            "newReturn",
            "saleId",
            "paymentId",
            "returnId",
            "saleLookup",
            "paymentLookup",
            "returnLookup",
          ]),
      ),
    ].map((id) => [id, { value: "", disabled: false, textContent: "" }]),
  );
  Object.assign(fields.key, { value: "synthetic-ui-test" });
  Object.assign(fields.terminal, { value: "11" });
  for (const [id, value] of Object.entries({
    invoice: "1",
    returnItem: "1",
    returnQty: "1",
    returnReason: "isolated test",
    disposition: "RESTOCK",
    returnCustomer: "REGISTERED",
    refundAmount: "100",
  }))
    fields[id].value = value;
  let connected = false;
  const fetch = async (route, options) => {
    if (route === "/ready") {
      connected = true;
      return { ok: true, status: 200, json: async () => ({ ready: true }) };
    }
    requests.push({ body: options.body, headers: options.headers });
    throw Error("SIMULATED_LOST_RESPONSE");
  };
  const load = () =>
    runInNewContext(script, {
      document: {
        getElementById: (id) => fields[id],
        querySelectorAll: () => Object.values(fields),
      },
      localStorage: {
        getItem: (key) => storage.get(key),
        setItem: (key, v) => storage.set(key, v),
      },
      crypto: webcrypto,
      fetch,
    });
  const click = async (id) => {
    fields[id].onclick();
    await new Promise((resolve) => setImmediate(resolve));
  };
  load();
  await click("connect");
  assert.equal(connected, true);
  await click("newReturn");
  await click("return");
  assert.equal(requests[0].headers["x-cash-retry"], undefined);
  fields.refundAmount.value = "999";
  fields.terminal.value = "12";
  load();
  await click("return");
  assert.equal(
    requests.length,
    1,
    "a different terminal cannot retry the saved request",
  );
  fields.terminal.value = "11";
  await click("return");
  assert.equal(requests[1].headers["x-cash-retry"], "1");
  assert.equal(requests[1].headers["x-credit-lab-terminal"], "11");
  assert.equal(requests[1].body, requests[0].body);
  assert.equal(JSON.parse(requests[1].body).refund.amount, "100");
  assert.equal(fields.newReturn.disabled, true);
});
