import { createActualDb, quoteActual, prepareActualCartShare } from './actual';
import { createWithJournal, planStatements, identity, failure, verifyRecord } from './journal';
import { consoleHtml } from './console';
const denied=['/sale','/checkout','/credit','/return','/digital','/dispatch'];
export default {
  async fetch(request:Request,env:any) {
    const started=performance.now(),url=new URL(request.url);
    const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-robots-tag':'noindex, nofollow'};
    const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...headers,'x-lab-wall-ms':String(performance.now()-started)}});
    if(request.method==='GET'&&url.pathname==='/')return new Response(consoleHtml,{headers:{'content-type':'text/html; charset=utf-8','x-robots-tag':'noindex, nofollow','cache-control':'no-store','content-security-policy':"default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"}});
    if(!env.LAB_TOKEN||request.headers.get('authorization')!==`Bearer ${env.LAB_TOKEN}`)return reply({error:'UNAUTHORIZED'},401);
    try {
      if(denied.includes(url.pathname))return reply({error:'ACTUAL_FINANCIAL_TRANSACTION_NOT_PORTED'},501);
      if(url.pathname==='/status')return reply({lab:env.LAB_ID,actualFunctions:['getUnitPrice','computeLineTotal','computeInvoiceTotals','createStorefrontCartShare'],financialWritesEnabled:false,hostingerRequests:0});
      if(url.pathname==='/snapshot'&&request.method==='GET'){
        await identity(env.DB,['primary','restore']);
        const tables:any={};
        for(const name of ['productPrices','storefrontCartShares','edge_operations'])tables[name]=(await env.DB.prepare(`SELECT * FROM ${name} ORDER BY id`).all()).results;
        const journal=env.RECOVERY_LOG?(await env.RECOVERY_LOG.prepare('SELECT * FROM edge_journal ORDER BY seq').all()).results:null;
        return reply({tables,journal});
      }
      if(request.method!=='POST')return reply({error:'NOT_FOUND'},404);
      if(Number(request.headers.get('content-length')??0)>16384)throw failure('PAYLOAD_TOO_LARGE',413);
      const raw=await request.text();if(raw.length>16384)throw failure('PAYLOAD_TOO_LARGE',413);
      const input=JSON.parse(raw);
      if(url.pathname==='/restore-from-log'){
        await identity(env.DB,['restore']);
        if(!Array.isArray(input.records)||input.records.length>8)throw failure('INVALID_RECOVERY_BATCH',400);
        // Validate the entire chunk before its one atomic D1 batch. At most
        // 8 * 6 statements + 1 identity read = 49 queries, below the free limit.
        for(const record of input.records)await verifyRecord(env.LAB_TOKEN,record);
        const statements=input.records.flatMap((record:any)=>planStatements(env.DB,record));
        if(statements.length)await env.DB.batch(statements);
        // Separate chunks remain resumable/idempotent, not whole-file atomic.
        return reply({restored:input.records.length,source:'external-signed-log',journalBindingRequired:false,atomicScope:'input-chunk'});
      }
      const db=createActualDb(env.DB);
      if(url.pathname==='/quote') {await identity(env.DB,['primary','restore']); return reply(await quoteActual(db,input));}
      if(url.pathname==='/cart-share'){
        const id=request.headers.get('idempotency-key');
        if(!id||!/^[a-zA-Z0-9_-]{8,100}$/.test(id))throw failure('VALID_IDEMPOTENCY_KEY_REQUIRED',400);
        if(!Array.isArray(input.lines)||input.lines.length>100)throw failure('INVALID_CART_LINES',400);
        for(const line of input.lines)if(!line||typeof line!=='object')throw failure('INVALID_CART_LINES',400);
        const fault=request.headers.get('x-lab-fault')??'';
        if(!['','log-unavailable','after-prepare','after-primary','drop-response'].includes(fault))throw failure('INVALID_FAULT',400);
        return reply(await createWithJournal(env,id,input,()=>prepareActualCartShare(db,input.lines),fault));
      }
      return reply({error:'NOT_FOUND'},404);
    } catch(error:any) {
      const codes:any={BAD_REQUEST:400,PRECONDITION_FAILED:412,NOT_FOUND:404};
      const status=error.status??codes[error.code]??503;
      // SQL, bindings, stack traces, tokens and internal configuration never enter responses.
      return reply({error:error.status||codes[error.code]?error.code:'LAB_OPERATION_FAILED'},status);
    }
  }
};
