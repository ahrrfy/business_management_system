import {spawn,execFileSync} from 'node:child_process';
import {loadAuditTarget} from './audit-local-target.mjs';
const operations=new Set(['check','check:guards','test','test:unit','test:integration','test:producer','build','check:test-types']);
const operation=process.argv[2];
if(!operations.has(operation))throw new Error('Expected a supported validation operation');
if(operation==='test'||operation==='test:integration'){
 const container=JSON.parse(execFileSync('docker',['inspect','erp-all-modules-test-1028-ram'],{encoding:'utf8'}))[0];
 if(container.Config.Labels?.['codex.audit']!=='all-modules-fixes-20261028'||container.State.Status!=='running')throw new Error('Wrong isolated test container');
 const bindings=container.HostConfig.PortBindings?.['3306/tcp'];
 if(bindings?.length!==1||bindings[0].HostIp!=='127.0.0.1'||bindings[0].HostPort!=='33320')throw new Error('Unexpected test binding');
}
const auditTarget=loadAuditTarget('allModules',{verifyContainer:operation==='test'||operation==='test:integration'});
const env={...process.env,NODE_ENV:operation==='build'?'production':'test',NODE_OPTIONS:'--max-old-space-size=8192',TZ:'UTC',
 TEST_DATABASE_URL:auditTarget.databaseUrl('erp_audit_all_modules_1028_test'),
 DATABASE_URL:auditTarget.databaseUrl('erp_audit_all_modules_1028_test'),
 TEST_CONTROL_DATABASE_URL:auditTarget.databaseUrl('erp_audit_all_control_1028_test'),
 CONTROL_DATABASE_URL:'',JWT_SECRET:'test_secret',BARCODE_SECRET:'test_barcode_secret',
 TWO_FACTOR_ENFORCEMENT:'off',
 INTEGRATIONS_ENCRYPTION_KEY:'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};
delete env.DB_TARGET_EXPECTED_UUID;
delete env.BACKUP_TARGET_URL;
const command=operation==='test:integration'
 ? 'pnpm exec cross-env TZ=UTC VITEST_EXCLUDE_UNIT=1 vitest run'
 : operation==='test:producer'
 ? 'pnpm exec cross-env TZ=UTC vitest run --config vitest.unit.config.ts server/services/__tests__/postingProducerCoverage.test.ts'
 : 'pnpm '+operation;
console.log('Isolated validation: '+operation+'; localhost:33320; synthetic application/control DBs; TZ=UTC; Node='+process.version);
const child=process.platform==='win32'
 ? spawn(process.env.ComSpec??'cmd.exe',['/d','/s','/c',command],{env,stdio:'inherit'})
 : spawn(command.split(' ')[0],command.split(' ').slice(1),{env,stdio:'inherit'});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
