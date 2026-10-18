import { tableNames, quote } from './schema';
import { fixtureActor } from './fixture';
import { CASH_SCHEMA_VERSION, readCashCommand } from './actual';
import { cashHttpInput } from './http-input';
import { assertIdentity, committedRecords, committedRecordsPage, createWithRecovery, failure, LAB_ID, primary, restoreRecords } from './journal';
import { cashProfiler } from './profile';
import { boundedRows, pageInteger, snapshotManifest, snapshotPage } from './pages';
import { migrateCashScope } from './scope-migration';

const page=`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>مختبر البيع النقدي</title><style>body{font:17px Tahoma,Arial;max-width:760px;margin:32px auto;padding:16px;background:#f5f5f5;color:#202020}main{background:white;border:1px solid #bbb;padding:24px}h1{font-size:24px}label{display:block;margin:14px 0}input,button{font:inherit;padding:10px;border:1px solid #888}input{width:90%;direction:ltr}button{cursor:pointer;background:#155b49;color:white}pre{white-space:pre-wrap;overflow-wrap:anywhere;direction:ltr;text-align:left;border:1px solid #bbb;padding:12px}.note{background:#fff4ce;border:1px solid #b58900;padding:12px}</style><main><h1>مختبر البيع النقدي على Workers وD1</h1><p class="note">بيانات اصطناعية منفصلة عن الإنتاج. النطاق: بيع نقدي كامل لصنف مخزني عادي. الآجل والمرتجعات والبطاقات الرقمية وباقي وظائف الكاشير غير مشمولة بهذه المرحلة.</p><p>الصنف التجريبي: قطعتان × 100.00، التكلفة 50.00 للقطعة، المقبوض 200.00. التنفيذ يستدعي خدمة البيع الأصلية، ويؤكد حفظ سجل التعافي قبل إعلان النجاح.</p><label>مفتاح المختبر الخاص<input id="key" type="password" autocomplete="off"></label><label>معرّف الطلب الثابت<input id="id"></label><button id="sale">تنفيذ البيع التجريبي</button> <button id="lookup">التحقق من الطلب نفسه</button><pre id="result" aria-live="polite">لم تُنفّذ عملية بعد.</pre></main><script>const q=id=>document.getElementById(id);q('id').value='cash-ui-'+crypto.randomUUID();let pending=false;async function run(lookup){if(pending)return;pending=true;q('sale').disabled=true;try{const id=q('id').value;const body={branchId:1,shiftId:1,sourceType:'POS',clientRequestId:id,lines:[{variantId:1,productUnitId:1,quantity:'2'}],payment:{amount:'200',method:'CASH'}};const r=await fetch(lookup?'/operation/'+encodeURIComponent(id):'/sale',{method:lookup?'GET':'POST',headers:{Authorization:'Bearer '+q('key').value,'content-type':'application/json'},...(lookup?{}:{body:JSON.stringify(body)})});q('result').textContent=JSON.stringify(await r.json(),null,2); }catch(e){q('result').textContent='انقطع الرد. احتفظ بمعرّف الطلب نفسه وتحقق من نتيجته قبل أي إعادة.'}finally{pending=false;q('sale').disabled=false}}q('sale').onclick=()=>run(false);q('lookup').onclick=()=>run(true);</script></html>`;

async function snapshot(env:any){
  const db=primary(env.DB),marker=await db.prepare('SELECT role FROM cashSandboxIdentity WHERE id=?').bind(LAB_ID).first();
  if(!marker||!['primary','restore'].includes(marker.role))throw failure('SANDBOX_IDENTITY_MISMATCH');
  const names=[...tableNames,'cashEpoch','cashCommands','cashOutbox'];
  const rows=await db.batch(names.map(name=>db.prepare('SELECT * FROM '+quote(name))));
  return {role:marker.role,tables:Object.fromEntries(names.map((name,i)=>[name,rows[i].results])),journalBindingPresent:!!env.RECOVERY_LOG};
}

export default {async fetch(request:Request,env:any){
  const url=new URL(request.url);
  if(request.method==='GET'&&url.pathname==='/')return new Response(page,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  if(!env.LAB_TOKEN||request.headers.get('authorization')!=='Bearer '+env.LAB_TOKEN)return Response.json({code:'UNAUTHORIZED'},{status:401,headers:{'cache-control':'no-store'}});
  const profile=request.headers.get('x-cash-profile')==='1'?cashProfiler(env):null;
  if(profile)env=profile.env;
  const json=(body:any,status=200)=>{
    const headers:any={'cache-control':'no-store'};
    if(profile)headers['x-cash-profile']=JSON.stringify(profile.result());
    return Response.json(body,{status,headers});
  };
  try{
    let result:any;
    if(request.method==='GET'&&url.pathname==='/status'){
      const db=primary(env.DB),marker=await db.prepare('SELECT role FROM cashSandboxIdentity WHERE id=?').bind(LAB_ID).first();
      if(!marker)throw failure('SANDBOX_IDENTITY_MISMATCH');
      result={labId:LAB_ID,schemaVersion:CASH_SCHEMA_VERSION,role:marker.role,scope:'ORIGINAL_FULL_CASH_STOCKED_POS',productionAuthentication:false,journalBindingPresent:!!env.RECOVERY_LOG};
    } else if(request.method==='POST'&&url.pathname==='/migrate-scope'){
      const body=await request.json();if(body.confirm!=='ISOLATED_CASH_SCOPE_UPGRADE')throw failure('EXPLICIT_SCOPE_UPGRADE_REQUIRED',400);result=await migrateCashScope(env);
    } else if(request.method==='POST'&&url.pathname==='/sale'){
      const raw=await request.text();if(raw.length>20000)throw failure('REQUEST_TOO_LARGE',400);
      const parsed=cashHttpInput.safeParse(JSON.parse(raw));if(!parsed.success)throw failure('INVALID_CASH_INPUT',400);
      result=await createWithRecovery(env,parsed.data,fixtureActor,request.headers.get('x-cash-fault')??'');
    } else if(request.method==='GET'&&url.pathname.startsWith('/operation/')){
      const db=primary(env.DB);await assertIdentity(db,'primary');
      const id=decodeURIComponent(url.pathname.slice('/operation/'.length)),row=await readCashCommand(db,id);
      let recoveryAcknowledged=false;
      if(env.RECOVERY_LOG){const log=primary(env.RECOVERY_LOG);await assertIdentity(log,'journal');const r=await log.prepare('SELECT requestId FROM cashJournalCommitted WHERE requestId=?').bind(id).first();recoveryAcknowledged=!!r;}
      result={clientRequestId:id,state:row?(recoveryAcknowledged?'CONFIRMED':'PRIMARY_COMMITTED_RECOVERY_PENDING'):'UNCONFIRMED_RETRY_ORIGINAL_REQUEST',result:row?.result??null,recoveryAcknowledged};
    } else if(request.method==='GET'&&url.pathname==='/snapshot')result=url.searchParams.has('table')?await snapshotPage(env,url):url.searchParams.has('manifest')?await snapshotManifest(env):await snapshot(env);
    else if(request.method==='GET'&&url.pathname==='/recovery-log'){
      await assertIdentity(primary(env.DB),'primary');
      result=url.searchParams.has('afterEpoch')?await committedRecordsPage(env.RECOVERY_LOG,pageInteger(url.searchParams.get('afterEpoch')),url.searchParams.has('throughEpoch')?pageInteger(url.searchParams.get('throughEpoch')):undefined,pageInteger(url.searchParams.get('limit'),8),boundedRows):{labId:LAB_ID,schemaVersion:CASH_SCHEMA_VERSION,records:await committedRecords(env.RECOVERY_LOG)};
    } else if(request.method==='POST'&&url.pathname==='/restore'){
      const raw=await request.text();if(raw.length>1000000)throw failure('REQUEST_TOO_LARGE',400);
      result=await restoreRecords(env,JSON.parse(raw).records);
    } else throw failure('UNSUPPORTED_TEST_ROUTE',404);
    return json(result);
  }catch(error:any){
    const messages=[];for(let current:any=error;current;current=current.cause)messages.push(current.message);
    const status=error.status??(error.code==='CONFLICT'||error.message==='REQUEST_CONFLICT'?409:/(?:UNSUPPORTED|INVALID|FULL_CASH_REQUIRED)/.test(error.message)?400:error.code==='BAD_REQUEST'?400:error.code==='FORBIDDEN'?403:503);
    return json({code:error.code??error.message,message:messages.join(' | '),retryWithOriginalRequest:true},status);
  }
}};
