import test from 'node:test';
import assert from 'node:assert/strict';
import { ForensicEngine, classifyEntity, MODULE_REGISTRY } from '../erpm-deep-audit.mjs';

test('ForensicEngine module registry is comprehensive', () => {
  const keys = Object.keys(MODULE_REGISTRY);
  assert.equal(keys.length, 12, 'Must define 11 ERP modules + General Core');
  assert.ok(MODULE_REGISTRY.accounting_treasury, 'Must have accounting_treasury');
  assert.ok(MODULE_REGISTRY.sales_pos, 'Must have sales_pos');
  assert.ok(MODULE_REGISTRY.inventory_warehousing, 'Must have inventory_warehousing');
  assert.ok(MODULE_REGISTRY.returns_refunds, 'Must have returns_refunds');
  assert.ok(MODULE_REGISTRY.work_orders_manufacturing, 'Must have work_orders_manufacturing');
  assert.ok(MODULE_REGISTRY.delivery_logistics, 'Must have delivery_logistics');
  assert.ok(MODULE_REGISTRY.hr_payroll, 'Must have hr_payroll');
  assert.ok(MODULE_REGISTRY.crm_customers, 'Must have crm_customers');
  assert.ok(MODULE_REGISTRY.storefront_ecommerce, 'Must have storefront_ecommerce');
  assert.ok(MODULE_REGISTRY.platform_admin_security, 'Must have platform_admin_security');
});

test('classifyEntity correctly routes entities to modules', () => {
  assert.equal(classifyEntity('accountingEntries'), 'accounting_treasury');
  assert.equal(classifyEntity('cashTransfers'), 'accounting_treasury');
  assert.equal(classifyEntity('invoices'), 'sales_pos');
  assert.equal(classifyEntity('posSessions'), 'sales_pos');
  assert.equal(classifyEntity('purchaseOrders'), 'purchases_suppliers');
  assert.equal(classifyEntity('branchStock'), 'inventory_warehousing');
  assert.equal(classifyEntity('purchaseReturns'), 'returns_refunds');
  assert.equal(classifyEntity('workOrders'), 'work_orders_manufacturing');
  assert.equal(classifyEntity('productionRecipes'), 'work_orders_manufacturing');
  assert.equal(classifyEntity('deliveryZones'), 'delivery_logistics');
  assert.equal(classifyEntity('payrollRuns'), 'hr_payroll');
  assert.equal(classifyEntity('customers'), 'crm_customers');
  assert.equal(classifyEntity('storefrontOrders'), 'storefront_ecommerce');
  assert.equal(classifyEntity('auditLogs'), 'platform_admin_security');
});

test('ForensicEngine initializes cleanly and runs scope calculation', () => {
  const engine = new ForensicEngine();
  engine.calculateScope();
  assert.ok(engine.results.scope.totalFiles > 3000, 'Must audit over 3000 files');
  assert.ok(engine.results.scope.totalLines > 800000, 'Must audit over 800,000 lines');
});

test('ForensicEngine executes full inspection without throwing', () => {
  const engine = new ForensicEngine();
  const report = engine.runFullInspection();
  assert.ok(report.summary.totalCheckpoints > 1000, 'Must evaluate over 1000 checkpoints');
  assert.ok(report.summary.pass > 1000, 'Must pass vast majority of checkpoints');
  assert.ok(report.summary.sii >= 80, 'System Integrity Index must be above 80%');
});
