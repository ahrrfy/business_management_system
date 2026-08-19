import { describe, expect, it } from "vitest";
import { createLatestBarcodeResolutionGate } from "./barcodeResolution";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("createLatestBarcodeResolutionGate", () => {
  it("allows only the newest asynchronous barcode response to select a product", async () => {
    const gate = createLatestBarcodeResolutionGate();
    const first = deferred<number>();
    const second = deferred<number>();
    const selected: number[] = [];
    const resolveAndSelect = async (request: Promise<number>) => {
      const token = gate.next();
      const productId = await request;
      if (gate.isCurrent(token)) selected.push(productId);
    };

    const firstRequest = resolveAndSelect(first.promise);
    const secondRequest = resolveAndSelect(second.promise);
    second.resolve(2);
    await secondRequest;
    first.resolve(1);
    await firstRequest;

    expect(selected).toEqual([2]);
  });
});
