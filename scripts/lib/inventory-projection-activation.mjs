// Raw dedicated connection B only. The deployment fence owns and continuously verifies connection A.
export const INVENTORY_PROJECTION_VERSION = 1;
function integer(value, positive = false) {
  if (!/^(0|[1-9]\d*)$/.test(String(value)))
    throw new Error("Invalid inventory projection integer");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < (positive ? 1 : 0))
    throw new Error("Inventory projection integer overflow");
  return n;
}
function add(map, variant, branch, quantity) {
  const id = integer(variant, true),
    source = integer(branch, true),
    q = integer(quantity);
  const result = map.get(id);
  if (!result) throw new Error(`Projection references missing variant ${id}`);
  const total = integer(Number(result[source] ?? 0) + q);
  if (total) result[source] = String(total);
}
const stable = (value) =>
  JSON.stringify(
    Object.entries(value).sort(([a], [b]) => Number(a) - Number(b)),
  );

/** Independent saved document / dispatch evidence derivation; performs no mutation. */
export async function deriveInventoryTransitProjection(conn) {
  const [variants] = await conn.query(
    "SELECT v.id, p.isBundle, p.isService FROM productVariants v JOIN products p ON p.id=v.productId ORDER BY v.id",
  );
  const [count] = await conn.query("SELECT COUNT(*) AS n FROM productVariants");
  if (Number(count[0].n) !== variants.length)
    throw new Error("Missing projection product identity");
  const metadata = new Map(variants.map((v) => [Number(v.id), v]));
  const projection = new Map(variants.map((v) => [Number(v.id), {}]));
  const [docs] = await conn.query(
    "SELECT id, fromBranchId, toBranchId, totalSentBase FROM stockTransfers WHERE transferStatus='IN_TRANSIT' ORDER BY id",
  );
  const [branches] = await conn.query("SELECT id FROM branches");
  const branchIds = new Set(branches.map((b) => Number(b.id)));
  for (const doc of docs) {
    if (
      !branchIds.has(Number(doc.fromBranchId)) ||
      !branchIds.has(Number(doc.toBranchId)) ||
      doc.fromBranchId === doc.toBranchId
    )
      throw new Error("Invalid transfer branch evidence");
    const [lines] = await conn.query(
      "SELECT id, variantId, quantitySent, quantityReceived FROM stockTransferLines WHERE transferId=? ORDER BY id",
      [doc.id],
    );
    if (!lines.length) throw new Error(`Transfer ${doc.id} has no lines`);
    let sentTotal = 0;
    const expected = new Map();
    const increase = (map, id, q) =>
      map.set(
        integer(id, true),
        integer((map.get(Number(id)) ?? 0) + integer(q)),
      );
    for (const line of lines) {
      const meta = metadata.get(Number(line.variantId));
      if (!meta || meta.isService || line.quantityReceived !== null)
        throw new Error(
          `Transfer ${doc.id} has unresolved historical line evidence`,
        );
      const sent = integer(line.quantitySent, true);
      sentTotal = integer(sentTotal + sent);
      const [components] = await conn.query(
        "SELECT componentVariantId, componentBaseQuantity FROM stockTransferLineBundleComponents WHERE transferLineId=? ORDER BY componentVariantId",
        [line.id],
      );
      if (meta.isBundle && !components.length)
        throw new Error(`Transfer ${doc.id} missing saved bundle components`);
      const seen = new Set();
      for (const c of components.length
        ? components
        : [{ componentVariantId: line.variantId, componentBaseQuantity: 1 }]) {
        const id = integer(c.componentVariantId, true),
          component = metadata.get(id);
        if (
          seen.has(id) ||
          !component ||
          component.isBundle ||
          component.isService
        )
          throw new Error(
            `Transfer ${doc.id} invalid physical component evidence`,
          );
        seen.add(id);
        increase(
          expected,
          id,
          integer(sent * integer(c.componentBaseQuantity, true)),
        );
      }
    }
    if (sentTotal !== integer(doc.totalSentBase, true))
      throw new Error(`Transfer ${doc.id} total mismatch`);
    const [moves] = await conn.query(
      "SELECT variantId, branchId, relatedBranchId, quantity, signedDelta FROM inventoryMovements WHERE referenceType='TRANSFER' AND referenceId=? AND movementType='TRANSFER_OUT'",
      [doc.id],
    );
    const actual = new Map();
    for (const move of moves) {
      if (
        move.branchId !== doc.fromBranchId ||
        move.relatedBranchId !== doc.toBranchId ||
        (move.signedDelta !== null && Number(move.signedDelta) !== -Number(move.quantity))
      )
        throw new Error(`Transfer ${doc.id} dispatch branch mismatch`);
      increase(actual, move.variantId, integer(move.quantity, true));
    }
    const entries = (map) =>
      JSON.stringify(Array.from(map).sort(([a], [b]) => a - b));
    if (entries(expected) !== entries(actual))
      throw new Error(
        `Transfer ${doc.id} saved expansion disagrees with actual dispatch`,
      );
    for (const [id, quantity] of expected)
      add(projection, id, doc.fromBranchId, quantity);
  }
  return { projection, variants: variants.length, openTransfers: docs.length };
}

/** Separate SQL grouping independently verifies every projected branch and every zero/closed-only variant. */
export async function assertInventoryTransitParity(conn) {
  const [expectedRows] = await conn.query(
    "SELECT COALESCE(c.componentVariantId,l.variantId) AS variantId,t.fromBranchId AS branchId,CAST(SUM((l.quantitySent-COALESCE(l.quantityReceived,0))*COALESCE(c.componentBaseQuantity,1)) AS CHAR) AS quantity FROM stockTransfers t JOIN stockTransferLines l ON l.transferId=t.id LEFT JOIN stockTransferLineBundleComponents c ON c.transferLineId=l.id WHERE t.transferStatus='IN_TRANSIT' GROUP BY COALESCE(c.componentVariantId,l.variantId),t.fromBranchId",
  );
  const [variants] = await conn.query(
    "SELECT id,transitBaseBySourceBranch FROM productVariants ORDER BY id",
  );
  const expected = new Map(variants.map((v) => [Number(v.id), {}]));
  for (const row of expectedRows)
    add(expected, row.variantId, row.branchId, row.quantity);
  for (const row of variants) {
    const value =
      typeof row.transitBaseBySourceBranch === "string"
        ? JSON.parse(row.transitBaseBySourceBranch)
        : row.transitBaseBySourceBranch;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Projection NULL/malformed at variant ${row.id}`);
    for (const [branch, quantity] of Object.entries(value)) {
      if (
        String(integer(branch, true)) !== branch ||
        typeof quantity !== "string" ||
        String(integer(quantity, true)) !== quantity
      )
        throw new Error(`Projection noncanonical at variant ${row.id}`);
    }
    if (stable(value) !== stable(expected.get(Number(row.id))))
      throw new Error(
        `Inventory projection parity mismatch at variant ${row.id}`,
      );
  }
  return { variants: variants.length, sourcePositions: expectedRows.length };
}

async function assertIdentity(conn, options) {
  if (!options || typeof options.fence?.assertQuiescentAndLocked !== "function")
    throw new Error("Verified operational inventory activation fence required");
  await options.fence.assertQuiescentAndLocked();
  const [[identity]] = await conn.query(
    "SELECT DATABASE() AS db, @@server_uuid AS serverUuid",
  );
  if (
    !options.expectedDatabase ||
    !options.expectedServerUuid ||
    identity.db !== options.expectedDatabase ||
    identity.serverUuid !== options.expectedServerUuid
  )
    throw new Error("Inventory activation DB identity mismatch");
}

export async function activateInventoryProjection(conn, options) {
  if (!/^[a-f0-9]{40}$/.test(options?.commit ?? ""))
    throw new Error("Exact immutable activation commit required");
  await assertIdentity(conn, options);
  await conn.beginTransaction();
  let committing = false;
  try {
    const [[state]] = await conn.query(
      "SELECT id,readyVersion FROM inventoryProjectionState WHERE id=1 FOR UPDATE",
    );
    if (!state || Number(state.readyVersion) !== 0)
      throw new Error(
        "Inventory projection must be explicitly UNREADY before activation",
      );
    const derived = await deriveInventoryTransitProjection(conn);
    for (const [id, value] of derived.projection)
      await conn.query(
        "UPDATE productVariants SET transitBaseBySourceBranch=? WHERE id=?",
        [JSON.stringify(value), id],
      );
    const parity = await assertInventoryTransitParity(conn);
    await conn.query(
      "UPDATE inventoryProjectionState SET readyVersion=1,activatedCommit=?,activatedAt=CURRENT_TIMESTAMP WHERE id=1",
      [options.commit],
    );
    await assertIdentity(conn, options);
    committing = true;
    await conn.commit();
    return { ...parity, openTransfers: derived.openTransfers, readyVersion: 1 };
  } catch (error) {
    await conn.rollback().catch(() => {});
    if (committing)
      throw new Error("INVENTORY_ACTIVATION_COMMIT_UNCERTAIN", {
        cause: error,
      });
    throw error;
  }
}

export async function invalidateInventoryProjection(conn, options) {
  await assertIdentity(conn, options);
  await conn.beginTransaction();
  let committing = false;
  try {
    const [[state]] = await conn.query(
      "SELECT id FROM inventoryProjectionState WHERE id=1 FOR UPDATE",
    );
    if (!state) throw new Error("Inventory projection marker missing");
    await conn.query(
      "UPDATE inventoryProjectionState SET readyVersion=0,activatedCommit=NULL,activatedAt=NULL WHERE id=1",
    );
    await assertIdentity(conn, options);
    committing = true;
    await conn.commit();
  } catch (error) {
    await conn.rollback().catch(() => {});
    if (committing)
      throw new Error("INVENTORY_INVALIDATION_COMMIT_UNCERTAIN", {
        cause: error,
      });
    throw error;
  }
}
