# Verified client model-selection API (0.2.2-rc.1)

These facts were read from the installed public client bundles. Do not use guessed call signatures.

- uiSession.adapter.current is a binding SOURCE, not a function. It has getSnapshot() and subscribe(listener). The snapshot is {key:sessionId|undefined,ctx,hooks,keyedHooks,props}. The source selects the mainView-retained session; it may be absent on a settings-only screen. Check key and sessions.subagentAddress(key) before selecting.
- To read this in React: useSyncExternalStore(source.subscribe,source.getSnapshot,source.getSnapshot). Resolve modelDirectories.directoryFor(binding.key) only when key is present. Never call adapter.current(binding.key).
- In conversation.input.right slot inject(sessionId), sessionId is supplied directly by the host. Supply directory.store and callbacks bound to that exact session. No need to consult the global current source for a slot already tied to a session.
- directory.load() -> Promise<snapshot>. Snapshot: {current:null|{provider,model,reasoningEffort?},routable,groups:[{id,name,models:[{id,name,reasoning?:{efforts:[{id,name?}],defaultEffort?}}]}],failures,status,pending,error}.
- directory.select({provider,model,reasoningEffort?}) -> Promise<{ok:true,value?:void}|{ok:false,error:{code,message,...}}>. It calls public remote.session.selectModel({sessionId,...selection}). Do not assume Promise resolution means success; inspect result.ok. Do not display raw remote messages blindly.
- Preserving effort across providers requires validating it against target model.reasoning.efforts[].id; otherwise omit and use that target model's declared default, rather than retaining an unsupported effort.
- If the loaded target provider has no current model id, do not silently choose an arbitrary paid model. Explain that a model must be selected in the standard selector (or present an explicit selection UI).
- The settings page can register through ctx.inject(['modelDirectories','sessions','uiSession'],scope=>...). A settings view itself is not a session binding. When no main session is retained, allow account activation/preferences but do not attempt a model RPC or fabricate a session id.

Source evidence: host @deepseek-ai/dsh-client-ui-session/lib/client.js:797-806,929-940,1028-1046,1066+; @deepseek-ai/dsh-client-ui-model-selection/lib/client.js:804-821,856-885,890-896,1028-1043,2043-2055,2072-2083. Toolbar CSS is height28px/font13px/weight400/line-height20px as previously measured.

## Integration decisions

- account-select and account-remove POST return a full settings DTO.
- history(accountId) may directly return {images:[{id,createdAt,width,height,url}]}; router validates identity before serving each PNG.
- stop generation is captured on HTTP entry before req.json(); a stale earlier run/configure body cannot restart after stop.
- Official settings mutate is async and has revision CAS but no caller callback inside its document lock. savePlan checks isCurrent before/after awaits; the scheduler must retain its own stop epoch and not treat an in-flight stale config ref/ACK as a new external plan.
- Telemetry probe context uses AsyncLocalStorage, not model/signal correlation. It tags the same SDK invocation across option/signal clones and must not deduplicate unrelated calls.
