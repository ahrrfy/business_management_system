// Synthetic external boundary only; no ERP, posting, reservation or retry logic.
import assert from "node:assert/strict";
import { open, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
export class SyntheticProvider {
  constructor(file) {
    this.file = file;
    this.pending = Promise.resolve();
  }
  async rows() {
    try {
      return (await readFile(this.file, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }
  issue(input, options = {}) {
    const result = this.pending.then(() => this.record(input, options));
    this.pending = result.catch(() => {});
    return result;
  }
  async record(input, { loseResponse = false, outcome = "SUCCESS" } = {}) {
    assert.equal(input.synthetic, true);
    assert.match(input.providerIdempotencyKey, /^digital-issue:\d+:\d+$/);
    const rows = await this.rows(),
      requestHash = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
    const prior = rows.find(
      (r) =>
        r.namespace === input.namespace &&
        r.key === input.providerIdempotencyKey &&
        r.event === "ISSUED",
    );
    if (prior)
      assert.equal(
        prior.requestHash,
        requestHash,
        "Synthetic provider idempotency payload conflict",
      );
    const result = prior?.result ?? {
      status: outcome,
      providerReference: input.providerReference,
    };
    const row = {
      sequence: rows.length + 1,
      namespace: input.namespace,
      key: input.providerIdempotencyKey,
      requestHash,
      event: prior ? "REPLAY" : "ISSUED",
      result,
      loseResponse,
    };
    const file = await open(this.file, "a");
    try {
      await file.write(JSON.stringify(row) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    if (loseResponse)
      throw Object.assign(Error("SYNTHETIC_PROVIDER_RESPONSE_LOST"), {
        code: "SYNTHETIC_RESPONSE_LOST",
      });
    return { ...result, replay: !!prior };
  }
}
