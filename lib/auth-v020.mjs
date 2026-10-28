export function createDirectLogin(authorization) {
  let attempt = null;
  const status = () => attempt ? {state:attempt.state, url:attempt.url, error:attempt.error} : {state:'idle'};
  function cancelPrompt(p, controller) {
    return new Promise((resolve,reject)=>{
      const fail=()=>reject(Object.assign(new Error('cancelled'),{name:'AbortError'}));
      if (controller.signal.aborted || p.signal?.aborted) return fail();
      controller.signal.addEventListener('abort',fail,{once:true});p.signal?.addEventListener('abort',fail,{once:true});
      attempt.answer=answer=>{controller.signal.removeEventListener('abort',fail);p.signal?.removeEventListener('abort',fail);resolve(answer)};
    });
  }
  async function begin() {
    if (attempt?.state === 'waiting') throw Error('already-running');
    const controller=new AbortController();let readyResolve,readyReject;
    const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject});
    attempt={state:'waiting',url:null,error:null,controller,answer:null};
    const current=attempt;
    const interaction={
      notify(n){if(!n.url)return;try{const u=new URL(n.url);if(u.protocol!=='https:'||u.hostname!=='auth.openai.com')throw Error('invalid-auth-url');if(attempt===current){current.url=u.href;readyResolve(u.href)}}catch{readyReject(Error('invalid-auth-url'));controller.abort()}},
      prompt(p){if(p.kind==='select'){if(p.options?.some(x=>x.id==='browser'))return Promise.resolve('browser');return Promise.reject(Error('unsupported-login-method'))}return cancelPrompt(p,controller)}
    };
    authorization.begin({key:'llm-pi-ai/openai-codex',method:'oauth',interaction,signal:controller.signal}).then(r=>{if(attempt===current){current.state=r.status==='authorized'?'authorized':'cancelled';readyReject(Error('login-ended'))}},e=>{if(attempt===current){current.state='error';current.error=e.code??'authorization-failed';readyReject(Error(current.error))}});
    const timeout=setTimeout(()=>{readyReject(Error('authorization-start-timeout'));controller.abort()},15000);
    try{return await ready}finally{clearTimeout(timeout)}
  }
  function answer(url){if(!attempt?.answer)throw Error('no-prompt');const u=new URL(url),expected=new URL(attempt.url).searchParams.get('state');if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||!u.searchParams.has('code')||!expected||u.searchParams.get('state')!==expected)throw Error('invalid-callback');const answer=attempt.answer;attempt.answer=null;answer(u.href)}
  function cancel(){attempt?.controller.abort();attempt=null}
  return {begin,status,answer,cancel};
}
