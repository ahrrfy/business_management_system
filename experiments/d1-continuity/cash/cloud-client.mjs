import {cashRetryKind} from './retry-policy.mjs';

// Test client only. Every retry keeps the identical serialized command/key.
export function cashCloudClient(context, countRequest, options = {}) {
  const send = options.fetch ?? globalThis.fetch;
  const pause = options.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  async function attempt(target, route, payload, fault) {
    countRequest();
    const started = performance.now();
    let response, raw;
    try {
      response = await send(target + route, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: {authorization: 'Bearer ' + context.secret, 'content-type': 'application/json',
          ...(route === '/sale' ? {'x-cash-profile':'1'} : {}), ...(fault ? {'x-cash-fault':fault} : {})},
        ...(payload === undefined ? {} : {body: payload}), signal: AbortSignal.timeout(30000),
      });
      raw = await response.text();
    } catch (error) {
      if (!(error instanceof TypeError) && !['AbortError','TimeoutError'].includes(error.name)) throw error;
      return {status:503,body:{code:'HTTP_TRANSPORT_UNCERTAIN'},ms:performance.now()-started,profile:null};
    }
    let body;
    try { body = JSON.parse(raw); }
    catch {
      if (![502,503,504].includes(response.status)) throw Error('Non-JSON test response '+response.status);
      body = {code:/Worker exceeded resource limits|cf-error-code[^>]*>\s*1102/i.test(raw)
        ? 'WORKER_RESOURCE_LIMIT' : 'EDGE_TRANSPORT_UNCERTAIN',transportStatus:response.status};
    }
    return {status:response.status,body,ms:performance.now()-started,
      profile:JSON.parse(response.headers.get('x-cash-profile') ?? 'null')};
  }
  return async (target,route,input,fault='') => {
    if (![context.source,context.restore].includes(target)) throw Error('UNAPPROVED_CASH_TEST_TARGET');
    const payload=input===undefined?undefined:JSON.stringify(input), requestId=input?.clientRequestId, started=performance.now(), transportAttempts=[];
    for(let i=0;i<5;i++) {
      const result=await attempt(target,route,payload,fault);
      transportAttempts.push({status:result.status,code:result.body.code??null,ms:result.ms,profile:result.profile});
      if (cashRetryKind(result.status,result.body.code)!=='transport')
        return {...result,ms:performance.now()-started,transportAttempts};
      if (route==='/sale' && requestId) {
        const lookup=await attempt(target,'/operation/'+encodeURIComponent(requestId),undefined,'');
        transportAttempts.at(-1).reconciliation={status:lookup.status,state:lookup.body.state??null};
      }
      if(i<4) await pause(Math.min(1000,150*2**i));
    }
    throw Object.assign(Error('Transport retry budget exhausted; preserve saved request'),{transportAttempts});
  };
}
