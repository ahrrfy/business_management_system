import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const directory=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(directory,'../../..');
const integratedBase='057027c6579f2230e14f3b0fca12f850ada1c5c2';
const auditPath='D:/business_management_system-worktrees/audit-all-modules-20261028/docs/audits/2026-10-28-all-modules/index/findings-register.json';
const original=JSON.parse(fs.readFileSync(auditPath,'utf8'));
const bundles={
 purchase:{ids:['11-F01','11-F02','12-F03'],test:'auditPurchaseFinancialContracts',reviewer:'financial_hr_review'},
 assets:{ids:['16-F01','17-F01','17-F02','18-F01','18-F02'],test:'auditAssetJournalConsignment',reviewer:'independent_contract_review'},
 hr:{ids:['26-F1','26-F2','26-F3'],test:'auditHrContracts',reviewer:'financial_hr_review'},
 digital:{ids:['COM20-01','COM20-02','29-F1'],test:'auditDigitalAndCommissionContracts',reviewer:'independent_contract_review'},
 commerce:{ids:['COM09-02','COM19-01','COM19-02','COM21-01','30-P2-PROMOTION-UPDATE'],test:'auditCommerceControls',reviewer:'independent_contract_review'},
 outbox:{ids:['33-F2','31-P2-WA-STALE-SENDING','31-P2-BROADCAST-ELIGIBILITY'],test:'auditOutboxRecovery',reviewer:'independent_contract_review'},
 platform:{ids:['34-F1','34-F2'],test:'auditDbTarget / auditImportIdentity',reviewer:'independent_contract_review'},
 branch:{ids:['ROOT-BRANCH-01'],test:'branchAuditRemediation',reviewer:'independent_contract_review'},
};
const families=original.families.map(family=>{
 const entry=Object.entries(bundles).find(([,bundle])=>bundle.ids.includes(family.id));
 const finding=family.finding??{};
 return {id:family.id,priority:family.priority,title:family.title,
  status:entry?'IMPLEMENTED_REVIEWED_ACCEPTANCE_PENDING':'OPEN_EXTERNAL_OWNER',
  owner:entry?'session/audit-fixes-20261028':'session/procedures-remediation-20261028',
  bundle:entry?.[0]??null,focusedTests:entry?.[1].test??null,independentReviewer:entry?.[1].reviewer??null,
  originalAudit:{confirmation:family.occurrences?.map(o=>({unit:o.unit,confirmation:o.confirmation})),trigger:finding.trigger??null,impact:finding.impact??null,proposedRemedy:finding.root_remedy??null,evidence:finding.evidence??[]},
 };
});
if(families.length!==37||families.filter(f=>f.bundle).length!==25)throw new Error('Unexpected audit closure accounting');
fs.writeFileSync(path.join(directory,'closure-register.json'),JSON.stringify({
 sourceRevision:original.sourceRevision,integratedBase,
 limits:'Original static evidence does not prove production incidents. Implemented is not released. Full suite, exact-head CI and deployment remain separate acceptance gates. No historical business-data repair is included.',
 originalRegisterSha256:createHash('sha256').update(fs.readFileSync(auditPath)).digest('hex'),
 total:37,implemented:25,externalOwner:12,families,
},null,2)+'\n');

const changed=[...execFileSync('git',['diff','--name-only',integratedBase],{cwd:root,encoding:'utf8'}).split(/\r?\n/),
 ...execFileSync('git',['ls-files','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).split(/\r?\n/)];
const sourceFiles=[...new Set(changed)].filter(file=>/^(client\/|server\/|shared\/|scripts\/|drizzle\/|vitest\.unit\.config\.ts$|CLAUDE\.md$)/.test(file)).sort();
const sourceHashes=Object.fromEntries(sourceFiles.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
const logs=['typecheck.log','guards-final.log','build.log','branch-red.log','branch-green.log','migration-dry-run.log','full-test-docker-failure.log','full-test-final.log','producer-isolated-retry.log','integration-local-budget-interrupted.log','b2b-isolated-retry.log','ci-fixtures-green.log','local-target-guards.log','backup80-node-green.log','backup80-deploy-green.log'];
const logHashes=Object.fromEntries(logs.filter(file=>fs.existsSync(path.join(directory,file))).map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(directory,file))).digest('hex')]));
fs.writeFileSync(path.join(directory,'evidence-manifest.json'),JSON.stringify({
 generatedAt:new Date().toISOString(),base:integratedBase,headAtCapture:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
 sourceHashFormat:'SHA-256 of working-tree bytes, including their local line endings; these are capture evidence, not portable Git blob hashes.',
 sourceHashes,localLogHashes:logHashes,logLimit:'Logs are local ignored evidence; a hash of an in-progress log is provisional. See progress.md for completed gates and exact observed outcomes.',
},null,2)+'\n');
console.log(`Recorded ${families.length} families, ${sourceFiles.length} source hashes, ${logs.length} candidate logs.`);
