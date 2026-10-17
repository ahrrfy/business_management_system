import {execute} from './commands.mjs';
export default {async fetch(request,env) {
  if(env.LAB_ONLY!=='synthetic-isolated-v1') return Response.json({error:'LAB_BINDING_REQUIRED'},{status:403});
  if(new URL(request.url).pathname!='/command'||request.method!=='POST') return Response.json({error:'NOT_FOUND'},{status:404});
  try {
    if(request.headers.get('x-lab-network-probe')) {
      const hostinger=await env.HOSTINGER.fetch('http://hostinger.invalid/');
      const internet=await fetch('https://egress-blocked.invalid/');
      return Response.json({hostinger:hostinger.status,internet:internet.status});
    }
    const result=await execute(env.DB,await request.json(),{admissionDelay:request.headers.has('x-lab-admission-delay'),finalFailure:request.headers.has('x-lab-final-failure'),zeroGuard:request.headers.has('x-lab-zero-guard')});
    if(request.headers.has('x-lab-drop-response')) return Response.json({error:'RESPONSE_DROPPED_AFTER_COMMIT'},{status:503});
    return Response.json(result);
  } catch(error) {return Response.json({error:error.code??error.message},{status:error.status??409});}
}};
