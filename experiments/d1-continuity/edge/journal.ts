const canonical = (value: unknown): string => Array.isArray(value) ? '['+value.map(canonical).join(',')+']'
  : value && typeof value === 'object' ? '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as any)[key])).join(',')+'}'
  : JSON.stringify(value);
export async function digest(value: unknown) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export function failure(code: string, status=503) { return Object.assign(new Error(code),{code,status}); }
const signedFields=(record:any)=>({id:record.id,hash:record.hash,plan:record.plan,result:record.result,snapshot:record.snapshot});
async function signingKey(secret:string) { return crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']); }
export async function signRecord(secret:string,record:any) {
  return [...new Uint8Array(await crypto.subtle.sign('HMAC',await signingKey(secret),new TextEncoder().encode(canonical(signedFields(record)))))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function verifyRecord(secret:string,record:any) {
  if(record?.state!=='COMMITTED'||!/^\w[\w-]{7,99}$/.test(record.id)||!/^[0-9a-f]{64}$/.test(record.hash)||!/^[0-9a-f]{64}$/.test(record.signature)||typeof record.snapshot!=='string')throw failure('INVALID_RECOVERY_RECORD',400);
  const bytes=new Uint8Array(record.signature.match(/../g).map((hex:string)=>parseInt(hex,16)));
  if(!await crypto.subtle.verify('HMAC',await signingKey(secret),bytes,new TextEncoder().encode(canonical(signedFields(record)))))throw failure('RECOVERY_SIGNATURE_MISMATCH',400);
}
export async function identity(db: any, roles: string[]) {
  const row=await db.prepare('SELECT role FROM edge_marker WHERE id=?').bind('edge-actual-20261017').first();
  if(!row||!roles.includes(row.role))throw failure('SANDBOX_IDENTITY_MISMATCH');
}
export function planStatements(db: any, record: any) {
  const plan=JSON.parse(record.plan), result=record.result;
  if(typeof plan.token!=='string'||!/^[-_a-zA-Z0-9]{24}$/.test(plan.token)||typeof plan.linesJson!=='string'||typeof plan.expiresAt!=='string')throw failure('INVALID_RECOVERY_PLAN');
  // The sole source service write is cart-sharing, not a financial transaction.
  // Same-id competitors must use the immutable journal winner before this batch.
  let insert=db.prepare('INSERT INTO storefrontCartShares(token,lines,expiresAt) VALUES (?,?,?) ON CONFLICT(token) DO NOTHING').bind(plan.token,plan.linesJson,plan.expiresAt);
  let assertRow=db.prepare('INSERT INTO edge_assert SELECT CASE WHEN EXISTS(SELECT 1 FROM storefrontCartShares WHERE token=? AND lines=? AND expiresAt=?) THEN 1 ELSE 0 END').bind(plan.token,plan.linesJson,plan.expiresAt);
  if(record.snapshot){
    const row=JSON.parse(record.snapshot);
    if(!Number.isSafeInteger(row.id)||row.id<1||row.token!==plan.token||row.lines!==plan.linesJson||row.expiresAt!==plan.expiresAt||typeof row.createdAt!=='string')throw failure('INVALID_RECOVERY_SNAPSHOT');
    insert=db.prepare('INSERT INTO storefrontCartShares(id,token,lines,expiresAt,createdAt) VALUES (?,?,?,?,?) ON CONFLICT(token) DO NOTHING').bind(row.id,row.token,row.lines,row.expiresAt,row.createdAt);
    assertRow=db.prepare('INSERT INTO edge_assert SELECT CASE WHEN EXISTS(SELECT 1 FROM storefrontCartShares WHERE id=? AND token=? AND lines=? AND expiresAt=? AND createdAt=?) THEN 1 ELSE 0 END').bind(row.id,row.token,row.lines,row.expiresAt,row.createdAt);
  }
  return [
    insert,
    assertRow,
    db.prepare('DELETE FROM edge_assert'),
    db.prepare('INSERT INTO edge_operations VALUES (?,?,?) ON CONFLICT(id) DO NOTHING').bind(record.id,record.hash,result),
    db.prepare('INSERT INTO edge_assert SELECT CASE WHEN EXISTS(SELECT 1 FROM edge_operations WHERE id=? AND hash=? AND result=?) THEN 1 ELSE 0 END').bind(record.id,record.hash,result),
    db.prepare('DELETE FROM edge_assert')
  ];
}
export async function commitPlan(db: any, record: any) {
  return db.batch(planStatements(db,record));
}
export async function createWithJournal(env: any,id: string,input: unknown,prepare:()=>Promise<any>,fault='') {
  await identity(env.DB,['primary','restore']);
  await identity(env.RECOVERY_LOG,['journal']);
  if(fault==='log-unavailable')throw failure('RECOVERY_LOG_UNAVAILABLE');
  const hash=await digest({kind:'ACTUAL_CART_SHARE',input});
  let record=await env.RECOVERY_LOG.prepare('SELECT * FROM edge_journal WHERE id=?').bind(id).first();
  if(!record){
    const prepared=await prepare();
    await env.RECOVERY_LOG.prepare("INSERT INTO edge_journal(id,hash,plan,result,state) VALUES (?,?,?,?,'PREPARED') ON CONFLICT(id) DO NOTHING")
      .bind(id,hash,JSON.stringify(prepared.plan),JSON.stringify(prepared.result)).run();
    record=await env.RECOVERY_LOG.prepare('SELECT * FROM edge_journal WHERE id=?').bind(id).first();
  }
  if(!record||record.hash!==hash)throw failure('IDEMPOTENCY_PAYLOAD_MISMATCH',409);
  if(fault==='after-prepare')throw failure('INJECTED_AFTER_PREPARE');
  await commitPlan(env.DB,record);
  if(fault==='after-primary')throw failure('PRIMARY_COMMITTED_COPY_PENDING');
  const snapshot=await env.DB.prepare('SELECT * FROM storefrontCartShares WHERE token=?').bind(JSON.parse(record.plan).token).first();
  if(!snapshot)throw failure('PRIMARY_RESULT_MISSING');
  const snapshotJson=JSON.stringify(snapshot);
  const signature=await signRecord(env.LAB_TOKEN,{...record,snapshot:snapshotJson});
  await env.RECOVERY_LOG.prepare("UPDATE edge_journal SET state='COMMITTED',snapshot=COALESCE(snapshot,?),signature=?,committedAt=COALESCE(committedAt,CURRENT_TIMESTAMP) WHERE id=? AND hash=? AND (snapshot IS NULL OR snapshot=?)")
    .bind(snapshotJson,signature,id,hash,snapshotJson).run();
  const confirmed=await env.RECOVERY_LOG.prepare("SELECT state,snapshot FROM edge_journal WHERE id=? AND hash=?").bind(id,hash).first();
  if(confirmed?.state!=='COMMITTED'||confirmed.snapshot!==snapshotJson)throw failure('RECOVERY_ACK_MISSING');
  if(fault==='drop-response')throw failure('RESPONSE_DROPPED_AFTER_BOTH_COMMITS');
  return JSON.parse(record.result);
}
