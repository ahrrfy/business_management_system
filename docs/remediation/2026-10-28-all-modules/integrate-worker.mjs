import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const bundles={
 assets:{worker:'audit-fix-assets-1028',files:['client/src/pages/AssetDetail.tsx','client/src/pages/AssetEdit.tsx','client/src/pages/ConsignmentSettlements.tsx','server/routers/consignmentRouter.ts','server/services/__tests__/auditAssetJournalConsignment.test.ts','server/services/accounting/manualJournalService.ts','server/services/assets/reports.ts','server/services/assets/update.ts','server/services/consignment/noteService.ts']},
 digital:{worker:'audit-fix-digital-1028',files:['server/services/digitalCards/reversalService.ts','server/services/sale/correct.ts','server/services/commissions/attribution.ts','server/services/__tests__/auditDigitalAndCommissionContracts.test.ts']},
 purchase:{worker:'audit-fix-purchase-1028',files:['server/services/exchange/settleSupplier.ts','server/services/exchange/reverse.ts','server/services/exchange/supplierInvoiceSettlement.ts','server/services/purchase/goodsReceipts.ts','server/services/__tests__/auditPurchaseFinancialContracts.test.ts','server/services/__tests__/purchaseTenderEvidence.test.ts']},
 commerce:{worker:'audit-fix-commerce-1028',files:['client/src/pages/GiftsHub.tsx','client/src/pages/ReservationsHub.tsx','client/src/pages/__tests__/auditCommerceUi.test.tsx','server/routers/installmentRouter.ts','server/routers/promotionsV2Router.ts','server/routers/reservationsRouter.ts','server/services/installment/queries.ts','server/services/installment/types.ts','server/services/reservations/convert.ts','server/services/gifts/outbound.ts','server/services/salesPromotionService.ts','server/services/__tests__/auditCommerceControls.test.ts','server/services/__tests__/reservations.test.ts']},
 platform:{worker:'audit-fix-platform-1028',files:['scripts/backup.mjs','scripts/restore.mjs','scripts/db-migrate-apply.mjs','scripts/db-verify-schema.mjs','scripts/lib/db-target.mjs','scripts/lib/db-target.test.mjs','server/services/import/partyIdentity.ts','server/services/import/balanceSemantics.ts','server/services/import/customers.ts','server/services/import/suppliers.ts','server/services/__tests__/auditImportIdentity.test.ts','server/services/__tests__/auditDbTarget.test.ts','server/services/__tests__/importService.test.ts']},
 outbox:{worker:'audit-fix-outbox-1028',files:['client/src/lib/offline/db.ts','client/src/lib/offline/outbox.ts','client/src/lib/offline/outbox.test.ts','client/src/pages/Inbox.tsx','client/src/pages/WaBroadcasts.tsx','client/src/components/whatsapp/OutboxReconciliationDialog.tsx','server/routers/conversationRouter.ts','server/services/whatsapp/outboxService.ts','server/services/whatsapp/outboxSweeper.ts','server/services/whatsapp/broadcastDispatch.ts','server/services/whatsapp/broadcastService.ts','server/services/whatsapp/sendService.ts','server/services/whatsapp/index.ts','server/services/__tests__/auditOutboxRecovery.test.ts']},
 hr:{worker:'audit-fix-hr-1028',files:['client/src/components/hr/EmployeeContractsTab.tsx','client/src/components/hr/EmployeeEnterpriseOperationsTab.tsx','client/src/pages/EmployeeNew.tsx','client/src/pages/LeaveReport.tsx','client/src/pages/Leaves.tsx','server/routers/employeeRouter.ts','server/routers/hrEnterpriseRouter.ts','server/services/__tests__/auditHrContracts.test.ts','server/services/__tests__/challengerLeaveAccrual.test.ts','server/services/__tests__/hrEnterpriseTransactions.test.ts','server/services/attendanceService.ts','server/services/employeeContractService.ts','server/services/employeeCustodyService.ts','server/services/employeeDocumentService.ts','server/services/employeePenaltyService.ts','server/services/employeeService.ts','server/services/employeeTransferService.ts','server/services/hr/leaveAccrual.ts','server/services/hr/payrollWageBasis.ts','server/services/hr/resourceScope.ts','server/services/leaveService.ts']}
};
const key=process.argv[2],bundle=bundles[key];if(!bundle)throw new Error('Unknown reviewed bundle');
const worker=path.join(path.dirname(root),bundle.worker);
const base='fa82f0d5e5ec819b5769720f370a100d7ea81f9f';
if(execFileSync('git',['rev-parse','HEAD'],{cwd:worker,encoding:'utf8'}).trim()!==base)throw new Error('Worker revision differs');
const rootChanges=execFileSync('git',['diff','HEAD','--name-only','--',...bundle.files],{cwd:root,encoding:'utf8'}).trim();
const normalized=bytes=>bytes.toString('utf8').replaceAll('\r\n','\n');
const alreadyApplied=!!rootChanges&&bundle.files.every(file=>fs.existsSync(path.join(root,file))&&normalized(fs.readFileSync(path.join(root,file)))===normalized(fs.readFileSync(path.join(worker,file))));
if(rootChanges&&!alreadyApplied)throw new Error('Target files already changed: '+rootChanges);
const patch=execFileSync('git',['diff','--binary','HEAD','--',...bundle.files],{cwd:worker});
if(!patch.length)throw new Error('Empty worker patch');
execFileSync(process.execPath,['scripts/coord.mjs','claim','audit-fixes-'+key+'-integrated','--files',...bundle.files],{cwd:root,stdio:'inherit'});
if(!alreadyApplied){execFileSync('git',['apply','--check','-'],{cwd:root,input:patch});execFileSync('git',['apply','-'],{cwd:root,input:patch});}
for(const file of bundle.files){
 const original=fs.readFileSync(path.join(worker,file)),integrated=fs.readFileSync(path.join(root,file));
 if(!integrated.equals(original)){
  if(normalized(integrated)!==normalized(original))throw new Error('Integrated source differs: '+file);
  fs.writeFileSync(path.join(root,file),original);
 }
}
const record={bundle:key,worker,baseline:base,integratedAtUtc:new Date().toISOString(),patchSha256:createHash('sha256').update(patch).digest('hex'),files:bundle.files.map(file=>({path:file,sha256:createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')}))};
fs.writeFileSync(path.join(root,'docs/remediation/2026-10-28-all-modules/integrated-'+key+'.json'),JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify({bundle:key,files:bundle.files.length,byteIdentityVerified:true,patchSha256:record.patchSha256}));
