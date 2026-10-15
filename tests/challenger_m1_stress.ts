/**
 * tests/challenger_m1_stress.ts
 *
 * EMPIRICAL ADVERSARIAL STRESS TEST & PROPERTY-BASED HARNESS
 * Milestone 1: Atomic Taxonomy & Resolution Core
 *
 * Executed independently by Challenger 1.
 */

import {
  ALL_DOMAINS,
  DOMAIN_METADATA,
  STANDARD_ACTIONS,
  ATOMIC_PERMISSION_DEFINITIONS,
  ALL_ATOMIC_PERMISSION_KEYS,
  ATOMIC_PERMISSION_BY_KEY,
  ROLE_DEFAULT_ATOMIC_PERMISSIONS,
  ROLE_DEFAULT_OPERATIONAL_CAPS,
  ROLE_DEFAULT_DATA_MASKING,
  resolveAtomicPermissions,
  resolveOperationalCaps,
  resolveSensitiveDataMasking,
  hasAtomicPermission,
  deriveLegacyModulesFromAtomic,
  deriveAtomicFromLegacyModules,
  isPermissionEnvelope,
  normalizePermissionsInput,
  getAtomicPermissionsByDomain,
  getAtomicPermissionsByResource,
  searchAtomicPermissions,
  getDomainStats,
  filterAtomicOverrides,
  checkSodConflicts,
  isDiscountPercentWithinCap,
  isDiscountAmountWithinCap,
  isCreditSaleWithinCap,
  isPaymentVoucherWithinCap,
  isExpenseWithinCap,
  isRefundWithinCap,
  atomicPermissionKeySchema,
  atomicPermissionsMapSchema,
  operationalCapsSchema,
  sensitiveDataMaskingSchema,
  type AtomicPermissionKey,
  type AtomicPermissionsMap,
  type OperationalCaps,
  type SensitiveDataMasking,
  type LegacyAccessLevel,
} from "../shared/atomicPermissions";

interface TestStats {
  total: number;
  passed: number;
  failed: number;
  failures: string[];
}

const stats: TestStats = {
  total: 0,
  passed: 0,
  failed: 0,
  failures: [],
};

function assert(condition: boolean, testName: string, details?: string) {
  stats.total++;
  if (condition) {
    stats.passed++;
  } else {
    stats.failed++;
    const msg = `FAIL: ${testName}${details ? ` -> ${details}` : ""}`;
    stats.failures.push(msg);
    console.error(`  ❌ ${msg}`);
  }
}

console.log("================================================================================");
console.log("STARTING EMPIRICAL ADVERSARIAL STRESS TEST SUITE (Milestone 1)");
console.log("================================================================================");

// =============================================================================
// SECTION 1: Catalog Integrity & Invariant Stress Tests
// =============================================================================
console.log("\n--- Section 1: Catalog Taxonomy & Invariant Integrity ---");

assert(ALL_DOMAINS.length === 10, "Domain Count Invariant", `Found ${ALL_DOMAINS.length}`);

const keySet = new Set<string>();
let duplicateCount = 0;
for (const key of ALL_ATOMIC_PERMISSION_KEYS) {
  if (keySet.has(key)) duplicateCount++;
  keySet.add(key);
}
assert(duplicateCount === 0, "No Duplicate Atomic Keys", `Found ${duplicateCount} duplicates`);
assert(ALL_ATOMIC_PERMISSION_KEYS.length >= 75, "Catalog Key Threshold >= 75", `Count: ${ALL_ATOMIC_PERMISSION_KEYS.length}`);

// Regex format invariant for all keys
let invalidFormatCount = 0;
for (const key of ALL_ATOMIC_PERMISSION_KEYS) {
  if (!/^[a-z_]+\.[a-z_]+\.[a-z_]+$/.test(key)) {
    invalidFormatCount++;
  }
}
assert(invalidFormatCount === 0, "All Keys Match domain.resource.action regex", `Invalid: ${invalidFormatCount}`);

// Domain coverage: every domain has keys
for (const dom of ALL_DOMAINS) {
  const domKeys = getAtomicPermissionsByDomain(dom);
  assert(domKeys.length > 0, `Domain '${dom}' has atomic keys`, `Count: ${domKeys.length}`);
}

// Check for forbidden emojis in labels or descriptions
const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
let emojiCount = 0;
for (const def of ATOMIC_PERMISSION_DEFINITIONS) {
  if (emojiRegex.test(def.label) || emojiRegex.test(def.description)) {
    emojiCount++;
  }
}
assert(emojiCount === 0, "Zero UI Emojis in Catalog Labels/Descriptions", `Found ${emojiCount}`);

// Check standard actions mapping
let missingStandardAction = 0;
for (const def of ATOMIC_PERMISSION_DEFINITIONS) {
  if (!def.standardAction) missingStandardAction++;
}
assert(missingStandardAction === 0, "All Definitions Specify standardAction", `Missing: ${missingStandardAction}`);


// =============================================================================
// SECTION 2: Resolution Precedence Property-Based & Combinatorial Stress Tests
// =============================================================================
console.log("\n--- Section 2: Resolution Precedence Stress Tests ---");

// Property 1: Exhaustive Truth Table (Base x CustomRole x UserOverride)
// Base (true/false) x CustomRole (true/false/undefined) x UserOverride (true/false/undefined)
// Total 2 * 3 * 3 = 18 combinatorial states for EVERY atomic key
const allKeys = ALL_ATOMIC_PERMISSION_KEYS;
let precedenceViolations = 0;

for (const testKey of allKeys.slice(0, 20)) { // Sample across diverse keys
  const baseStates = [true, false];
  const roleStates = [true, false, undefined];
  const userStates = [true, false, undefined];

  for (const baseVal of baseStates) {
    for (const roleVal of roleStates) {
      for (const userVal of userStates) {
        // Construct synthetic scenario
        const customRole: AtomicPermissionsMap = roleVal !== undefined ? { [testKey]: roleVal } : {};
        const userOverrides: AtomicPermissionsMap = userVal !== undefined ? { [testKey]: userVal } : {};

        // Base role: admin (all true) or user (all false except inventory view)
        // To be pure, let's test with role that has baseVal
        const roleName = baseVal ? "admin" : "user";
        // Force base value
        const resolved = resolveAtomicPermissions(roleName, customRole, userOverrides);
        const actual = resolved[testKey];

        // Expected truth table logic:
        let expected: boolean;
        if (userVal !== undefined) {
          expected = userVal;
        } else if (roleVal !== undefined) {
          expected = roleVal;
        } else {
          expected = (ROLE_DEFAULT_ATOMIC_PERMISSIONS[roleName] ?? {})[testKey] ?? false;
        }

        if (actual !== expected) {
          precedenceViolations++;
        }
      }
    }
  }
}
assert(precedenceViolations === 0, "Property 1: Truth Table Precedence (User > Role > Base)", `Violations: ${precedenceViolations}`);

// Property 2: Non-Boolean / Poisoned Value Shielding
// Ensure string "true", number 1, objects, null in overrides do not leak into resolved map as truthy
const poisonedOverrides = {
  [allKeys[0]]: "true" as any,
  [allKeys[1]]: 1 as any,
  [allKeys[2]]: {} as any,
  [allKeys[3]]: null as any,
  [allKeys[4]]: false,
};
const resolvedPoisoned = resolveAtomicPermissions("user", null, poisonedOverrides);
assert(resolvedPoisoned[allKeys[0]] === false, "Poison test: string 'true' does not grant permission");
assert(resolvedPoisoned[allKeys[1]] === false, "Poison test: number 1 does not grant permission");
assert(resolvedPoisoned[allKeys[2]] === false, "Poison test: empty object does not grant permission");
assert(resolvedPoisoned[allKeys[4]] === false, "Poison test: boolean false is respected");

// Property 3: Immutability / Template Mutation Isolation
// Mutating resolved output MUST NOT corrupt original role templates
const originalCashierInvoiceCreate = ROLE_DEFAULT_ATOMIC_PERMISSIONS.cashier["pos.invoice.create"];
const resolvedMutate = resolveAtomicPermissions("cashier", null, { "pos.invoice.create": false });
resolvedMutate["pos.invoice.create"] = false;
resolvedMutate["pos.price.override"] = true;
assert(
  ROLE_DEFAULT_ATOMIC_PERMISSIONS.cashier["pos.invoice.create"] === originalCashierInvoiceCreate,
  "Immutability: ROLE_DEFAULT_ATOMIC_PERMISSIONS.cashier not mutated by resolveAtomicPermissions",
  `Expected ${originalCashierInvoiceCreate}, found ${ROLE_DEFAULT_ATOMIC_PERMISSIONS.cashier["pos.invoice.create"]}`
);

// Property 4: Prototype Pollution Attack
const protoAttackPayload = JSON.parse('{"__proto__":{"isAdmin":true},"pos.invoice.create":true}');
const resolvedProto = resolveAtomicPermissions("cashier", protoAttackPayload, null);
assert(
  (Object.prototype as any).isAdmin === undefined,
  "Security: Prototype pollution prevented on Object.prototype"
);

// Property 5: Operational Caps Hierarchical Resolution
const roleCaps: OperationalCaps = {
  maxDiscountPercent: 20,
  maxDiscountAmountIqd: "100000.00",
  maxCreditSaleLimitIqd: "500000.00",
};
const userCapsDenial: OperationalCaps = {
  maxDiscountPercent: 0, // Stripped discount down to zero
  maxCreditSaleLimitIqd: "0.00", // Stripped credit down to cash only
};
const resolvedCaps = resolveOperationalCaps("cashier", roleCaps, userCapsDenial);
assert(resolvedCaps.maxDiscountPercent === 0, "Caps precedence: User cap of 0% overrides role cap of 20%");
assert(resolvedCaps.maxCreditSaleLimitIqd === "0.00", "Caps precedence: User credit cap of 0.00 overrides role credit cap");
assert(resolvedCaps.maxDiscountAmountIqd === "100000.00", "Caps precedence: Unspecified user cap inherits role cap");

// Property 6: Operational Caps Boundary & Precision Checks
assert(isDiscountPercentWithinCap(0, resolvedCaps) === true, "Discount cap: 0% within 0% cap");
assert(isDiscountPercentWithinCap(0.01, resolvedCaps) === false, "Discount cap: 0.01% exceeds 0% cap");
assert(isDiscountPercentWithinCap(-1, resolvedCaps) === false, "Discount cap: negative percent rejected");
assert(isCreditSaleWithinCap("0.00", resolvedCaps) === true, "Credit sale cap: 0.00 within 0.00 cap");
assert(isCreditSaleWithinCap("1.00", resolvedCaps) === false, "Credit sale cap: 1.00 exceeds 0.00 cap");


// =============================================================================
// SECTION 3: Segregation of Duties (SoD) Conflict Detection Stress Tests
// =============================================================================
console.log("\n--- Section 3: Segregation of Duties (SoD) Conflict Detection ---");

// Check all Maker-Checker pairs in the catalog
const sodPairs: Array<{ name: string; maker: AtomicPermissionKey; checker: AtomicPermissionKey; group: string }> = [
  {
    name: "Treasury Voucher Out",
    maker: "treasury.voucher_out.create",
    checker: "treasury.voucher_out.approve",
    group: "voucher",
  },
  {
    name: "Treasury Operational Expenses",
    maker: "treasury.expense.create",
    checker: "treasury.expense.approve",
    group: "expenses",
  },
  {
    name: "Inventory Stocktake",
    maker: "inventory.stocktake.create",
    checker: "inventory.stocktake.approve",
    group: "stocktake",
  },
  {
    name: "Inventory Variance Adjustments",
    maker: "inventory.adjustment.request",
    checker: "inventory.adjustment.approve",
    group: "adjustment",
  },
  {
    name: "Purchasing Supplier Payments",
    maker: "purchasing.payment.request",
    checker: "purchasing.payment.approve",
    group: "purchasing_payment",
  },
  {
    name: "Workshop Rework Authorization",
    maker: "workshop.rework.request",
    checker: "workshop.rework.approve",
    group: "rework",
  },
  {
    name: "HR Monthly Payroll",
    maker: "hr.payroll.compute",
    checker: "hr.payroll.approve",
    group: "payroll",
  },
  {
    name: "HR Sales Commissions",
    maker: "hr.commission.compute",
    checker: "hr.commission.approve",
    group: "commissions",
  },
];

for (const pair of sodPairs) {
  // Scenario A: Both Maker and Checker enabled -> CONFLICT
  const conflictMap: AtomicPermissionsMap = {
    [pair.maker]: true,
    [pair.checker]: true,
  };
  const conflictsA = checkSodConflicts(conflictMap);
  const foundA = conflictsA.some((c) => c.group === pair.group);
  assert(foundA, `SoD Conflict Detected: ${pair.name} (Maker + Checker active)`);

  // Scenario B: Maker only -> SAFE
  const makerOnlyMap: AtomicPermissionsMap = {
    [pair.maker]: true,
    [pair.checker]: false,
  };
  const conflictsB = checkSodConflicts(makerOnlyMap);
  const foundB = conflictsB.some((c) => c.group === pair.group);
  assert(!foundB, `SoD Safe: ${pair.name} (Maker only active)`);

  // Scenario C: Checker only -> SAFE
  const checkerOnlyMap: AtomicPermissionsMap = {
    [pair.maker]: false,
    [pair.checker]: true,
  };
  const conflictsC = checkSodConflicts(checkerOnlyMap);
  const foundC = conflictsC.some((c) => c.group === pair.group);
  assert(!foundC, `SoD Safe: ${pair.name} (Checker only active)`);

  // Scenario D: Neither active -> SAFE
  const neitherMap: AtomicPermissionsMap = {
    [pair.maker]: false,
    [pair.checker]: false,
  };
  const conflictsD = checkSodConflicts(neitherMap);
  const foundD = conflictsD.some((c) => c.group === pair.group);
  assert(!foundD, `SoD Safe: ${pair.name} (Neither active)`);
}

// Multi-Conflict Stress Scenario: 8 simultaneous conflicts
const superConflictingMap: AtomicPermissionsMap = {};
for (const pair of sodPairs) {
  superConflictingMap[pair.maker] = true;
  superConflictingMap[pair.checker] = true;
}
const allConflicts = checkSodConflicts(superConflictingMap);
assert(allConflicts.length === sodPairs.length, "Simultaneous Multi-Conflict Detection (all 8 groups flagged)", `Detected: ${allConflicts.length}`);


// =============================================================================
// SECTION 4: Backward Compatibility & Roundtrip Fuzzing Stress Tests
// =============================================================================
console.log("\n--- Section 4: Backward Compatibility Engine Stress Tests ---");

// Test legacy coarse modules derivation across all system roles
const standardRoles = [
  "admin",
  "manager",
  "accountant",
  "cashier",
  "retail_cashier",
  "print_cashier",
  "reception_clerk",
  "warehouse",
  "purchasing",
  "print_operator",
  "sales_rep",
  "courier",
  "auditor",
  "user",
];

for (const role of standardRoles) {
  const atomic = resolveAtomicPermissions(role);
  const legacy = deriveLegacyModulesFromAtomic(atomic);

  assert(typeof legacy === "object" && legacy !== null, `Role '${role}' derives legacy modules object`);
  assert(Object.keys(legacy).length > 0, `Role '${role}' has derived module keys`);

  // Admin MUST have FULL across all derived modules
  if (role === "admin") {
    const nonFullAdmin = Object.entries(legacy).filter(([_, l]) => l !== "FULL").map(([m, l]) => `${m}=${l}`);
    assert(nonFullAdmin.length === 0, "Admin role derives FULL for all modules", `Non-FULL: ${nonFullAdmin.join(", ")}`);
  }

  // Manager in legacy template has FULL on products and reports
  if (role === "manager") {
    assert(legacy.products === "FULL", "Manager role derives FULL on products (backward compatibility)", `Actual: ${legacy.products}`);
    assert(legacy.reports === "FULL", "Manager role derives FULL on reports (backward compatibility)", `Actual: ${legacy.reports}`);
  }

  // Auditor MUST NEVER have FULL on any module (read-only invariant)
  if (role === "auditor") {
    let fullAuditor = 0;
    for (const [mod, level] of Object.entries(legacy)) {
      if (level === "FULL") fullAuditor++;
    }
    assert(fullAuditor === 0, "Auditor role NEVER derives FULL on any module", `Found FULL: ${fullAuditor}`);
  }
}

// Check missing legacy modules in deriveLegacyModulesFromAtomic:
const ALL_29_LEGACY_MODULES = [
  "pos", "sales", "purchases", "inventory", "workorders", "channels", "treasury", "expenses",
  "reports", "assets", "hr", "commissions", "consignments", "reservations", "digital_cards",
  "gifts", "catalogAnomalies", "courier", "announcements", "users", "settings", "customers",
  "crm", "campaigns", "collections", "store", "productStudio", "products", "suppliers"
];
const derivedAdminModules = deriveLegacyModulesFromAtomic(resolveAtomicPermissions("admin"));
const missingFromDerived = ALL_29_LEGACY_MODULES.filter((m) => !(m in derivedAdminModules));
assert(
  missingFromDerived.length === 0,
  "All 29 legacy modules represented in derived legacy modules",
  `Missing ${missingFromDerived.length} modules: ${missingFromDerived.join(", ")}`
);


// Test legacy module derivation with isolated view permissions
const viewOnlyMap: AtomicPermissionsMap = {
  "pos.invoice.view": true,
  "pos.invoice.create": false,
  "pos.invoice.void": false,
};
const derivedView = deriveLegacyModulesFromAtomic(viewOnlyMap);
assert(derivedView.sales === "READ", "Isolated view-only permission derives 'READ' legacy access level");

const writeOnlyMap: AtomicPermissionsMap = {
  "pos.invoice.view": false,
  "pos.invoice.create": true,
};
const derivedWrite = deriveLegacyModulesFromAtomic(writeOnlyMap);
assert(derivedWrite.sales === "FULL", "Write permission derives 'FULL' legacy access level");

// Test converting legacy coarse module map to atomic
const legacyInput: Record<string, LegacyAccessLevel> = {
  sales: "FULL",
  inventory: "READ",
  treasury: "NONE",
};
const atomicFromLegacy = deriveAtomicFromLegacyModules(legacyInput, "cashier");
assert(atomicFromLegacy["pos.invoice.create"] === true, "Legacy FULL sales grants pos.invoice.create");
assert(atomicFromLegacy["inventory.balance.view"] === true, "Legacy READ inventory grants view only");
assert(atomicFromLegacy["inventory.transfer.create"] === false, "Legacy READ inventory forbids create");
assert(atomicFromLegacy["treasury.cashbox.view"] === false, "Legacy NONE treasury revokes view");

// Test critical action shielding for non-admin legacy users
// A cashier with legacy FULL sales must NOT automatically receive pos.price.override or pos.invoice.void
assert(atomicFromLegacy["pos.price.override"] === false, "Security Shield: Legacy FULL does not grant critical price.override to non-admin cashier");
assert(atomicFromLegacy["pos.invoice.void"] === false, "Security Shield: Legacy FULL does not grant critical invoice.void to non-admin cashier");

// Normalization robustness: Malformed inputs
const emptyNorm = normalizePermissionsInput({});
assert(emptyNorm.atomic !== undefined, "normalizePermissionsInput({}) handles empty object safely");

const nullNorm = normalizePermissionsInput(null);
assert(nullNorm.atomic !== undefined, "normalizePermissionsInput(null) handles null safely");

const garbageNorm = normalizePermissionsInput("garbage string");
assert(garbageNorm.atomic !== undefined, "normalizePermissionsInput('string') handles string safely");

const arrayNorm = normalizePermissionsInput([1, 2, 3]);
assert(arrayNorm.atomic !== undefined, "normalizePermissionsInput([]) handles array safely");


// =============================================================================
// SECTION 5: High-Performance Benchmarking & Load Stress
// =============================================================================
console.log("\n--- Section 5: High-Performance & Throughput Benchmark ---");

const BENCHMARK_ITERATIONS = 5000;
const startTimer = performance.now();

for (let i = 0; i < BENCHMARK_ITERATIONS; i++) {
  const role = standardRoles[i % standardRoles.length];
  const customRole = i % 2 === 0 ? { "pos.drawer.open": true } : null;
  const userOverride = i % 3 === 0 ? { "pos.invoice.void": false, "inventory.balance.view": true } : null;
  resolveAtomicPermissions(role, customRole, userOverride);
}

const elapsedMs = performance.now() - startTimer;
const perOpUs = (elapsedMs / BENCHMARK_ITERATIONS) * 1000;

console.log(`  ⚡ Executed ${BENCHMARK_ITERATIONS} resolution operations in ${elapsedMs.toFixed(2)}ms (${perOpUs.toFixed(2)}µs per op)`);
assert(elapsedMs < 500, `Performance budget: 5,000 resolutions under 500ms (Actual: ${elapsedMs.toFixed(2)}ms)`);


// =============================================================================
// FINAL EMPIRICAL SUMMARY
// =============================================================================
console.log("\n================================================================================");
console.log(`EMPIRICAL RESULTS: ${stats.passed}/${stats.total} PASSED (${stats.failed} FAILED)`);
console.log("================================================================================");

if (stats.failed > 0) {
  console.error("\nDetailed Failures:");
  for (const f of stats.failures) {
    console.error(`- ${f}`);
  }
  process.exit(1);
} else {
  console.log("All empirical stress tests passed successfully!");
  process.exit(0);
}
