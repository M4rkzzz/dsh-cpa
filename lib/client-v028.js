if(typeof window !== 'undefined' && window.__ModuleLoader__) window.__ModuleLoader__.load({id:'dsh-cpa',factory:require=>{
 const React=require('react'), h=React.createElement, {Button,Tag}=require('@deepseek-ai/dsh-client-ui-primitives');
 const pillStyleId='dsh-cpa-usage-pill'; if(!document.querySelector('style[data-plugin-css="'+pillStyleId+'"]')){const style=document.createElement('style');style.dataset.pluginCss=pillStyleId;style.textContent=".cpaPill_root{min-width:0;display:inline-flex;position:relative}.cpaPill_trigger{color:inherit;opacity:.75;font:inherit;cursor:pointer;white-space:nowrap;background:0 0;border:0;border-radius:6px;padding:4px 6px;font-size:12px}.cpaPill_trigger:hover,.cpaPill_trigger:focus-visible{opacity:1;background:color-mix(in srgb, currentColor 8%, transparent)}.cpaPill_account{text-overflow:ellipsis;vertical-align:bottom;max-width:12ch;display:inline-block;overflow:hidden}@container (width<=460px){.cpaPill_brand,.cpaPill_stale,.cpaPill_account,.cpaPill_fallback{display:none}.cpaPill_reading[data-stale]:after{content:\"*\"}.cpaPill_trigger[data-fallback]:after{content:\" \\u21B3\"}}@container (width<=360px){.cpaPill_unit{display:none}}.cpaPill_panel{z-index:100;box-sizing:border-box;border-radius:var(--dsw-radius-lg,16px);width:320px;max-width:calc(100vw - 32px);max-height:70vh;color:var(--dsw-alias-label-primary,CanvasText);isolation:isolate;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1,color-mix(in srgb, currentColor 10%, transparent));box-shadow:var(--dsw-elevation-prominent,0 8px 30px #0003);border:0;flex-direction:column;font-size:12px;display:flex;position:absolute;bottom:calc(100% + 12px);right:0}.cpaPill_material{z-index:-1;border-radius:inherit;pointer-events:none;background:var(--dsw-menu-surface-fill,var(--dsw-specific-menu,#43454a73));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));position:absolute;inset:0}@supports not (backdrop-filter:blur(1px)){.cpaPill_material{background:var(--dsw-alias-bg-layer-2,Canvas)}}.cpaPill_body{overscroll-behavior:contain;box-sizing:border-box;flex-direction:column;flex:1;gap:6px;min-height:0;padding:10px;display:flex;overflow-y:auto}.cpaPill_panelTitle,.cpaPill_panelHead{color:var(--dsw-alias-label-tertiary,currentColor);flex:none;padding:2px 6px 0;font-size:11.5px;line-height:1.6}.cpaPill_panelHead{align-items:center;gap:6px;display:flex}.cpaPill_panelHead strong{color:var(--dsw-alias-label-primary,CanvasText);font-size:12px;font-weight:600}.cpaPill_back{width:18px;height:18px;color:inherit;cursor:pointer;background:0 0;border:0;border-radius:5px;place-items:center;padding:0;display:grid}.cpaPill_back:hover{background:color-mix(in srgb, currentColor 8%, transparent)}.cpaPill_icon{flex:none;width:14px;height:14px}.cpaPill_tick{color:#39a878;flex:none;width:14px;height:14px}.cpaPill_tile{background:color-mix(in srgb, currentColor 6%, transparent);border-radius:10px;flex:none;overflow:hidden}.cpaPill_divider{background:color-mix(in srgb, currentColor 10%, transparent);height:.5px;margin:0 12px}.cpaPill_accHead{align-items:center;gap:8px;min-height:42px;padding:0 12px;display:flex}.cpaPill_dot{background:#39a878;border-radius:50%;flex:none;width:7px;height:7px}.cpaPill_accName{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-size:13.5px;font-weight:600;overflow:hidden}.cpaPill_tag{color:#39a878;background:#39a8781f;border:.5px solid #39a87873;border-radius:999px;flex:none;padding:0 7px;font-size:10.5px;line-height:1.7}.cpaPill_switch{font:inherit;color:var(--dsw-alias-label-tertiary,currentColor);cursor:pointer;background:0 0;border:0;border-radius:6px;flex:none;align-items:center;gap:3px;padding:3px 6px;font-size:11.5px;display:inline-flex}.cpaPill_switch:hover:not(:disabled){background:color-mix(in srgb, currentColor 8%, transparent)}.cpaPill_switch:disabled{opacity:.55;cursor:default}.cpaPill_switch svg{display:block;transform:translateY(.5px)}.cpaPill_option{width:100%;min-height:38px;font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;align-items:center;gap:8px;padding:0 12px;display:flex}.cpaPill_option:hover:not(:disabled){background:color-mix(in srgb, currentColor 6%, transparent)}.cpaPill_option:disabled{opacity:.6;cursor:default}.cpaPill_optionName{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-secondary,currentColor);flex:1;font-size:13px;overflow:hidden}.cpaPill_option[data-selected] .cpaPill_optionName{color:var(--dsw-alias-label-primary,CanvasText);font-weight:600}.cpaPill_hint{opacity:.65;font-size:11px;line-height:1.6}.cpaPill_warning{background:color-mix(in srgb, currentColor 6%, transparent);overflow-wrap:anywhere;border-radius:6px;margin:10px 0;padding:10px;line-height:1.5}.cpaPill_warning p{margin:5px 0 0}.cpaPill_retry{border:1px solid color-mix(in srgb, currentColor 25%, transparent);color:inherit;font:inherit;cursor:pointer;background:0 0;border-radius:6px;padding:5px 9px}.cpaPill_retry:disabled{opacity:.6;cursor:default}.cpaPill_back:focus-visible,.cpaPill_switch:focus-visible,.cpaPill_option:focus-visible,.cpaPill_retry:focus-visible{outline-offset:2px;outline:2px solid}.cpaPill_window{padding:10px 12px}.cpaPill_windowRow{align-items:center;gap:10px;display:flex}.cpaPill_windowLabel{width:48px;color:var(--dsw-alias-label-secondary,currentColor);flex:none;font-size:12.5px}.cpaPill_windowPercent{text-align:right;font-variant-numeric:tabular-nums;flex:none;width:38px;font-size:13px;font-weight:650}.cpaPill_window progress{appearance:none;background:color-mix(in srgb, currentColor 15%, transparent);border:0;border-radius:99px;flex:1;min-width:60px;height:10px;display:block}.cpaPill_window progress::-webkit-progress-bar{background:0 0;border-radius:99px}.cpaPill_window progress::-webkit-progress-value{background:#39a878;border-radius:99px}.cpaPill_window progress::-moz-progress-bar{background:#39a878;border-radius:99px}.cpaPill_windowReset{color:var(--dsw-alias-label-tertiary,currentColor);margin-top:6px;font-size:11px;line-height:1.6}.cpaPill_foot{color:var(--dsw-alias-label-tertiary,currentColor);justify-content:space-between;align-items:center;gap:8px;padding:3px 6px 1px;font-size:11px;display:flex}.cpaPill_window progress.cpaPill_high::-webkit-progress-value{background:#e0a100}.cpaPill_window progress.cpaPill_high::-moz-progress-bar{background:#e0a100}.cpaPill_window progress.cpaPill_limited::-webkit-progress-value{background:#e5484d}.cpaPill_window progress.cpaPill_limited::-moz-progress-bar{background:#e5484d}.cpaPill_limitedText{color:#e5484d;margin-top:2px;font-weight:600}";document.head.appendChild(style)}
 // Styling adapted from dsh-opencode-go 0.1.24 (MIT); see THIRD_PARTY_NOTICES.md.
 const styleId='dsh-cpa-opencode-layout'; if(!document.querySelector('style[data-plugin-css="'+styleId+'"]')){const style=document.createElement('style');style.dataset.pluginCss=styleId;style.textContent=".cpaGo_accounts{gap:10px;margin:6px 0;padding:6px 0;display:grid}.cpaGo_accountRow{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;position:relative}.cpaGo_accountRow[data-dragging=true]{opacity:.55}.cpaGo_accountMain{grid-template-columns:16px 112px 92px minmax(0,1fr) 38px 106px 14px;align-items:center;gap:9px;padding:9px 11px;display:grid}.cpaGo_accountHandle{width:16px;height:16px;color:var(--dsw-alias-label-tertiary);cursor:grab;-webkit-user-drag:element;background:0 0;border:0;place-items:center;padding:0;display:grid}.cpaGo_accountHandle:disabled{cursor:default;opacity:.5}.cpaGo_accountHandle:focus-visible,.cpaGo_accountToggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}.cpaGo_accountName{white-space:nowrap;text-overflow:ellipsis;min-width:0;color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:600;overflow:hidden}.cpaGo_accountState{min-width:0;color:var(--dsw-alias-label-tertiary);align-items:center;gap:5px;font-size:11.5px;display:inline-flex;overflow:hidden}.cpaGo_accountDot{background:#39a878;border-radius:50%;flex:none;width:6px;height:6px}.cpaGo_accountDot[data-off=true]{background:#d9a441}.cpaGo_accountPercent{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:650}.cpaGo_accountBar{background:#ffffff1a;border-radius:99px;height:12px;position:relative;overflow:hidden}.cpaGo_accountBarFill{background:#39a878;border-radius:99px;position:absolute;inset:0 auto 0 0}.cpaGo_accountBar[data-level=high] .cpaGo_accountBarFill{background:#e0a100}.cpaGo_accountBar[data-level=limited] .cpaGo_accountBarFill{background:#e5484d}.cpaGo_accountBarTick{background:#fff3;width:1px;position:absolute;top:0;bottom:0}.cpaGo_accountReset{text-align:right;color:var(--dsw-alias-label-tertiary);font-size:11.5px}.cpaGo_accountIdle{text-align:right;color:var(--dsw-alias-label-tertiary);grid-column:4/7;font-size:11.5px;line-height:1.5}.cpaGo_accountToggle{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;place-items:center;padding:0;display:grid}.cpaGo_accountProblems{align-items:baseline;gap:8px;padding:0 11px 9px 36px;display:flex}.cpaGo_accountRetry{font:inherit;color:var(--dsw-alias-brand-primary);cursor:pointer;background:0 0;border:none;flex:none;padding:0;font-size:11.5px;line-height:1.5}.cpaGo_accountRetry:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}.cpaGo_accountHandle:active{cursor:grabbing}.cpaGo_accountDetail{border-top:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:8px;padding:9px 11px 10px 36px;display:flex}.cpaGo_accountRow:after{content:\"\";background:var(--dsw-alias-brand-primary);opacity:0;pointer-events:none;border-radius:2px;height:2px;position:absolute;left:0;right:0}.cpaGo_accountRow[data-drop=before]:after{opacity:1;top:-6px}.cpaGo_accountRow[data-drop=after]:after{opacity:1;bottom:-6px}.cpaGo_accountUsage{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;font-size:12px;display:grid}.cpaGo_accountUsage progress{accent-color:#39a878;width:100%;height:8px;margin:6px 0;display:block}.cpaGo_accountUsage progress[data-level=high]{accent-color:#e0a100}.cpaGo_accountUsage progress[data-level=limited]{accent-color:#e5484d}.cpaGo_accountUsage .cpaGo_hint{overflow-wrap:anywhere;display:block}.cpaGo_accountActions{flex-wrap:wrap;gap:8px;margin-top:10px;display:flex}.cpaGo_accountEditor{border:.5px solid var(--dsw-alias-border-l2);background:color-mix(in srgb, var(--dsw-alias-bg-layer-3) 25%, transparent);border-radius:10px;flex-direction:column;gap:8px;margin:0 11px 10px 36px;padding:10px 12px;display:flex}.cpaGo_accountEditorHead{align-items:baseline;gap:6px;min-width:0;display:flex}.cpaGo_accountEditorTitle{color:var(--dsw-alias-label-primary);flex:none;font-size:12.5px;font-weight:600;line-height:1.5}.cpaGo_accountEditorFor{min-width:0;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;font-size:11.5px;line-height:1.5}.cpaGo_accountField{color:var(--dsw-alias-label-tertiary);flex-direction:column;gap:5px;font-size:11.5px;line-height:1.5;display:flex}.cpaGo_accountEditorActions{align-items:center;gap:8px;margin-top:2px;display:flex}@media (width<=480px){.cpaGo_accountUsage{grid-template-columns:1fr}}.cpaGo_page{flex-direction:column;min-width:0;height:100%;min-height:0;display:flex;container-type:size}.cpaGo_pageBody{scrollbar-gutter:stable;flex-direction:column;flex:1;min-height:0;padding:0 4px 16px 0;display:flex;overflow-y:auto}.cpaGo_pageBody,.cpaGo_modelList,.cpaGo_modelDetails{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l3) transparent}.cpaGo_pageBody::-webkit-scrollbar,.cpaGo_modelList::-webkit-scrollbar,.cpaGo_modelDetails::-webkit-scrollbar{width:8px;height:8px}.cpaGo_pageBody::-webkit-scrollbar-track,.cpaGo_modelList::-webkit-scrollbar-track,.cpaGo_modelDetails::-webkit-scrollbar-track{background:0 0}.cpaGo_pageBody::-webkit-scrollbar-thumb,.cpaGo_modelList::-webkit-scrollbar-thumb,.cpaGo_modelDetails::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3);background-clip:content-box;border:2px solid #0000;border-radius:999px}.cpaGo_pageBody:hover::-webkit-scrollbar-thumb,.cpaGo_modelList:hover::-webkit-scrollbar-thumb,.cpaGo_modelDetails:hover::-webkit-scrollbar-thumb{background:var(--dsw-alias-label-tertiary);background-clip:content-box}.cpaGo_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}.cpaGo_field+.cpaGo_field{border-top:.5px solid var(--dsw-alias-border-l2)}.cpaGo_head{align-items:center;gap:8px;display:flex}.cpaGo_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}.cpaGo_trailing{flex:none;align-items:center;gap:8px;display:inline-flex}.cpaGo_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}.cpaGo_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}.cpaGo_reset:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}.cpaGo_reset:focus-visible,.cpaGo_cardTrigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.cpaGo_input{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}.cpaGo_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.cpaGo_inputInvalid:focus-visible{border-color:var(--dsw-alias-label-error);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-label-error) 28%, transparent)}.cpaGo_input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}.cpaGo_inputInvalid{border-color:var(--dsw-alias-label-error);}.cpaGo_invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}.cpaGo_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}.cpaGo_rows{flex-direction:column;display:flex}.cpaGo_row{grid-template-columns:minmax(0,1fr) 300px;align-items:center;gap:6px 14px;padding:10px 0;display:grid}.cpaGo_rowLabel{align-items:center;gap:7px;min-width:0;display:flex}.cpaGo_rowTitle{overflow-wrap:anywhere;-webkit-line-clamp:2;min-width:0;color:var(--dsw-alias-label-primary);-webkit-box-orient:vertical;font-size:13px;line-height:1.5;display:-webkit-box;overflow:hidden}.cpaGo_rowControl{align-items:center;min-width:0;display:flex}.cpaGo_rowControl>.cpaGo_input{box-sizing:border-box;width:100%}.cpaGo_advancedHead{flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:6px 12px;display:flex}.cpaGo_advancedHead .cpaGo_hint{flex:auto;min-width:0}.cpaGo_advancedHead .cpaGo_reset{flex:none}.cpaGo_rowHint,.cpaGo_rowInvalid{grid-column:1/-1;margin:0;font-size:12px;line-height:1.5}.cpaGo_rowHint{color:var(--dsw-alias-label-tertiary)}.cpaGo_rowInvalid{color:var(--dsw-alias-label-error)}.cpaGo_groupHead{letter-spacing:.04em;color:var(--dsw-alias-label-tertiary);align-items:center;gap:8px;margin:14px 0 0;font-size:11.5px;line-height:1.5;display:flex}.cpaGo_groupHead:first-child{margin-top:4px}.cpaGo_groupHead:after{content:\"\";background:var(--dsw-alias-border-l2);flex:1;height:.5px}.cpaGo_info{width:16px;height:16px;font:inherit;color:var(--dsw-alias-label-tertiary);cursor:help;background:0 0;border:0;flex:none;justify-content:center;align-items:center;padding:0;font-size:12px;line-height:1;display:inline-flex}.cpaGo_info:hover,.cpaGo_info:focus-visible{color:var(--dsw-alias-label-primary)}.cpaGo_info:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:3px}.cpaGo_info svg{width:13px;height:13px}.cpaGo_label .cpaGo_info,.cpaGo_cardTitle .cpaGo_info{vertical-align:middle;margin-left:6px}.cpaGo_seg{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:8px;flex:1;min-width:0;padding:2px;display:flex;position:relative}.cpaGo_segThumb{background:color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent);border-radius:6px;width:calc(50% - 2px);transition:transform .16s cubic-bezier(.2,0,0,1);position:absolute;top:2px;bottom:2px;left:2px}.cpaGo_seg[data-count=\"3\"] .cpaGo_segThumb{width:calc(33.3333% - 1.33333px)}.cpaGo_seg[data-index=\"1\"] .cpaGo_segThumb{transform:translate(100%)}.cpaGo_seg[data-index=\"2\"] .cpaGo_segThumb{transform:translate(200%)}.cpaGo_segOption{min-width:0;font:inherit;color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;cursor:pointer;background:0 0;border:0;border-radius:6px;flex:1 1 0;padding:4px 8px;font-size:12.5px;line-height:1.5;transition:color .16s;position:relative;overflow:hidden}.cpaGo_segOption:hover:not(:disabled){color:var(--dsw-alias-label-primary)}.cpaGo_segOption[aria-checked=true]{color:var(--dsw-alias-label-primary);font-weight:600}.cpaGo_segOption:disabled{opacity:.55;cursor:default}.cpaGo_segOption:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.cpaGo_pageTop{flex-direction:column;gap:3px;padding:2px 0 12px;display:flex}.cpaGo_title{color:var(--dsw-alias-label-primary);margin:0;font-size:15px;font-weight:600;line-height:1.4}.cpaGo_intro{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px;line-height:1.5}.cpaGo_card,.cpaGo_cardModels{border:.5px solid var(--dsw-alias-border-l2);background:color-mix(in srgb, var(--dsw-alias-bg-layer-3) 40%, transparent);border-radius:12px;padding:8px 0 10px}.cpaGo_card{flex:none}.cpaGo_card+.cpaGo_card,.cpaGo_card+.cpaGo_cardModels,.cpaGo_cardModels+.cpaGo_card{margin-top:8px}.cpaGo_cardModels{flex-direction:column;flex:1 0 auto;display:flex}.cpaGo_cardFolded{flex:none}.cpaGo_cardHead{align-items:center;gap:8px;min-height:24px;padding:0 14px;display:flex}.cpaGo_cardTitle{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13.5px;font-weight:600;line-height:1.5}.cpaGo_cardSub{color:var(--dsw-alias-label-tertiary);flex:none;font-size:11.5px;line-height:1.5}.cpaGo_cardStamp{white-space:nowrap;color:var(--dsw-alias-label-tertiary);flex:none;font-size:11.5px;line-height:1.5}.cpaGo_cardBody{flex-direction:column;gap:8px;padding:4px 14px 0;display:flex}.cpaGo_cardBody>.cpaGo_input{box-sizing:border-box;width:100%}.cpaGo_cardModels>.cpaGo_cardBody{flex:1 0 auto}.cpaGo_cardNotes{flex-direction:column;gap:8px;padding:6px 14px 2px;display:flex}.cpaGo_cardNotes:empty{display:none}.cpaGo_cardDivider{border-top:.5px solid var(--dsw-alias-border-l2);margin:10px 14px}.cpaGo_cardTrigger{width:100%;min-height:24px;font:inherit;text-align:left;color:inherit;cursor:pointer;background:0 0;border:none;align-items:center;gap:8px;margin:0;padding:0 14px;display:flex}.cpaGo_cardTrigger:hover .cpaGo_cardTitle{color:var(--dsw-alias-brand-primary)}.cpaGo_cardHead>.cpaGo_cardTrigger{padding:0}.cpaGo_limitsEditor{flex-direction:column;flex:1 0 auto;gap:10px;padding-top:4px;display:flex}.cpaGo_limitsFoot{border-top:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;margin:2px -14px 0;padding:10px 14px 0;display:flex}.cpaGo_limitsSummary{min-width:0;color:var(--dsw-alias-label-tertiary);white-space:nowrap;flex:1;font-size:12px;line-height:1.5}.cpaGo_modelMeta{align-items:baseline;gap:10px;display:flex}.cpaGo_modelMeta .cpaGo_limitsModelId{flex:1;min-width:0}.cpaGo_releaseDate{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;font-size:11px;line-height:1.4}.cpaGo_limitsModelId{text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.4;display:block;overflow:hidden}.cpaGo_visuallyHidden{clip:rect(0, 0, 0, 0);white-space:nowrap;border:0;width:1px;height:1px;margin:-1px;padding:0;position:absolute;overflow:hidden}.cpaGo_actions{border-top:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap;flex:none;align-items:center;gap:8px;padding:12px 0;display:flex}.cpaGo_starLink{max-width:100%;color:var(--dsw-alias-label-secondary);border-radius:4px;align-items:center;gap:7px;margin-left:auto;padding:6px 0;font-size:12px;line-height:1.5;text-decoration:none;display:inline-flex}.cpaGo_starLink svg{flex:none}.cpaGo_starLink:hover{color:var(--dsw-alias-brand-primary)}.cpaGo_starLink:hover span{text-underline-offset:3px;text-decoration:underline}.cpaGo_starLink:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.cpaGo_failedNote{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}.cpaGo_slot{width:16px;height:16px;color:var(--dsw-alias-label-tertiary);flex:none;justify-content:center;align-items:center;display:inline-flex}.cpaGo_slot svg{width:15px;height:15px}.cpaGo_chevron,.cpaGo_chevronOpen{width:14px;height:14px;color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .15s}.cpaGo_chevron{transform:rotate(-90deg)}.cpaGo_filters{flex-wrap:wrap;align-items:center;gap:6px;display:flex}.cpaGo_filterAction{align-items:center;margin-left:auto;display:inline-flex}.cpaGo_filter{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;border-radius:6px;padding:6px 9px;font-size:12px}.cpaGo_filter[aria-pressed=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3)}.cpaGo_filter span{color:var(--dsw-alias-label-tertiary);margin-left:4px}.cpaGo_modelLayout{border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;flex:auto;grid-template-columns:minmax(0,45fr) minmax(0,55fr);min-height:260px;max-height:560px;display:grid;overflow:hidden}.cpaGo_modelList{border-right:.5px solid var(--dsw-alias-border-l2);min-height:0;padding:4px 6px;overflow-y:auto}.cpaGo_modelRow{align-items:center;gap:8px;padding-right:6px;display:flex}.cpaGo_modelRow+.cpaGo_modelRow{border-top:.5px solid var(--dsw-alias-border-l2)}.cpaGo_modelRowSelected{background:var(--dsw-alias-bg-layer-3);border-top-color:#0000;border-radius:6px}.cpaGo_modelRow>[role=switch]{flex-shrink:0}.cpaGo_modelChoice{text-align:left;min-width:0;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:0;border-radius:6px;flex:1;align-items:baseline;padding:9px 3px 9px 6px;display:flex}.cpaGo_modelRow:hover:not(.cpaGo_modelRowSelected){background:color-mix(in srgb, var(--dsw-alias-bg-layer-3) 92%, var(--dsw-alias-label-primary));border-top-color:#0000;border-radius:6px}.cpaGo_modelName{overflow-wrap:anywhere;flex-wrap:wrap;flex:0 auto;align-items:center;gap:5px;min-width:0;font-size:13px;display:flex}.cpaGo_overrideDot{background:var(--dsw-alias-brand-primary);border-radius:50%;flex:none;width:6px;height:6px}.cpaGo_modelDetails{flex-direction:column;gap:10px;min-height:0;padding:14px;display:flex;overflow-y:auto}.cpaGo_modelDetails h3{overflow-wrap:anywhere;margin:0;font-size:14px}.cpaGo_modelHeading{flex-wrap:wrap;align-items:center;gap:6px;display:flex}.cpaGo_stats{flex-direction:column;gap:10px;display:flex}.cpaGo_stat{flex-direction:column;gap:4px;display:flex}.cpaGo_statLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}.cpaGo_budgetEditor{margin-top:12px;font-size:12px}.cpaGo_budgetEditor summary{cursor:pointer}.cpaGo_budgetInput{align-items:center;gap:8px;margin-top:4px;display:flex}.cpaGo_budgetPresets{flex-wrap:wrap;gap:6px;margin-top:8px;display:flex}.cpaGo_modelDetails .cpaGo_input{box-sizing:border-box;width:100%;min-width:0;height:30px;padding:0 9px;font-size:12px}.cpaGo_modalities{flex-wrap:wrap;gap:4px;display:flex}.cpaGo_modality,.cpaGo_modalityOff{border-radius:6px;padding:2px 7px;font-size:11px;line-height:1.5}.cpaGo_modality{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}.cpaGo_modalityOff{border:.5px dashed var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary)}.cpaGo_modelDetails .cpaGo_reset{align-self:flex-start}.cpaGo_paneFoot{color:var(--dsw-alias-label-tertiary);margin:auto 0 0;font-size:11px;line-height:1.5}.cpaGo_newBadge{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);border-radius:4px;padding:2px 4px;font-size:9px}.cpaGo_modelChoice:focus-visible,.cpaGo_filter:focus-visible,.cpaGo_cardTrigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}@container (width<=440px){.cpaGo_row{grid-template-columns:minmax(0,1fr);gap:6px}.cpaGo_modelLayout{flex:none;grid-template-columns:minmax(0,1fr);max-height:none}.cpaGo_modelList{border-right:0;border-bottom:.5px solid var(--dsw-alias-border-l2);max-height:240px}.cpaGo_modelDetails{max-height:460px}}@media (prefers-reduced-motion:reduce){.cpaGo_chevron,.cpaGo_chevronOpen,.cpaGo_segThumb,.cpaGo_segOption{transition:none}}";document.head.appendChild(style)}
 const messageOf=code=>({
  'account-switch-busy':'请先停止当前账号的会话请求再切换账号。',
  'account-inactive':'请先启用此账号。','pelican-account-inactive':'请先启用此账号。','CPA_ACCOUNT_INACTIVE':'请先启用此账号。',
  'account-changed':'账号已更改，请重试。','settings-save-failed':'设置未能保存，请重试。',
  'settings-superseded':'操作已被更新的设置取消。','pelican-cancelled':'测试已取消。','pelican-busy':'此账号的测试仍在运行。',
 }[code]??(typeof code==='string'?code:'request-failed'));
 async function call(body,endpoint='/api/cpa-settings'){
  const r=await fetch(endpoint,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});
  let x;try{x=await r.json()}catch{throw Error(r.ok?'api-invalid-json':'api-http-'+r.status)}
  if(!r.ok)throw Error(messageOf(x?.error??'request-failed'));return x;
 }
 const ui={page:{display:'flex',flexDirection:'column',gap:8,height:'100%',overflowY:'auto',color:'var(--dsw-alias-label-primary,inherit)'},card:{display:'grid',gap:12,padding:'14px'},muted:{fontSize:13,opacity:.72,margin:0},buttons:{display:'flex',gap:8,flexWrap:'wrap'},badge:{fontSize:12,borderRadius:99,padding:'4px 9px',background:'#24a86622',color:'#24a866'},track:{height:8,borderRadius:8,background:'#8883',overflow:'hidden'}};
 const stamp=x=>{const d=new Date(x);return Number.isFinite(d.getTime())?d.toLocaleString():'未知'};
 const period=n=>n===10080?'周':n===1440?'日':n%10080===0?`${n/10080}周`:n%1440===0?`${n/1440}天`:n%60===0?`${n/60}小时`:`${n}分钟`;
 let quotaSequence=0;
 const toolbarStyle={height:28,boxSizing:'border-box',fontSize:13,fontWeight:400,lineHeight:'20px',display:'inline-flex',alignItems:'center',padding:'0 6px'};
 // Public 0.2.2 ModelDirectory API: group.id owns models; uiSession.current is
 // a subscribable binding SOURCE, not a function. Never reroute prepared calls.
 function selectionAccess(scope,sessionIdOf){
  const unavailable=()=>Error('请先打开一个可选择模型的会话。');
  const resolve=()=>{
   const id=sessionIdOf();
   if(typeof id!=='string'||!id||scope.sessions.subagentAddress(id)!==undefined)throw unavailable();
   try{return {id,directory:scope.modelDirectories.directoryFor(id)}}catch{throw unavailable()}
  };
  const still=(id,guard)=>{if((guard&&!guard())||sessionIdOf()!==id||scope.sessions.subagentAddress(id)!==undefined)throw Error('会话已切换，未继续更改模型。')};
  const load=async directory=>{try{const state=await directory.load();if(!Array.isArray(state?.groups))throw Error();return state}catch{throw Error('模型目录暂不可用，请重试。')}};
  const same=(left,right)=>left?.provider===right?.provider&&left?.model===right?.model&&left?.reasoningEffort===right?.reasoningEffort;
  return {
   available(){try{resolve();return true}catch{return false}},
   async model(provider){const {id,directory}=resolve(),state=await load(directory);still(id);const model=state.current?.model;
    if(typeof model!=='string'||(provider&&!state.groups?.find(group=>group.id===provider)?.models?.some(item=>item.id===model)))throw Error('请在账号的测试设置中明确选择模型。');return model},
   async prepare(provider,explicit,allowed=[],authoritative=false){
    const {id,directory}=resolve(),state=await load(directory);still(id);
    if(state.status==='selecting'||state.pending)throw Error('模型选择尚未完成，请稍后重试。');
    const group=state.groups?.find(group=>group.id===provider),advertised=group?.models??[],models=authoritative?allowed.map(id=>advertised.find(item=>item.id===id)??{id}):group?.models??allowed.map(id=>({id})),model=explicit||state.current?.model;
    const previous=state.current?{...state.current}:null;
    const refresh=async (models,guard)=>{
     const check=()=>{still(id,guard);const latest=directory.store.getSnapshot();if(latest.status==='selecting'||latest.pending)throw Error('模型选择尚未完成，请稍后重试。');if(!same(latest.current,previous))throw Error('模型已由其它操作更改，未覆盖新的选择。')};
     check();const prepared=await this.prepare(provider,explicit,models,true);check();return prepared;
    };
    const target=models.find(item=>item.id===model);
    if(!target)return {unsupported:true,models:models.map(item=>item.id),refresh};
    const selection={provider,model};
    const efforts=(target.reasoning?.efforts??[]).map(item=>item.id);
    const retained=previous?.reasoningEffort;
    const effort=efforts.includes(retained)?retained:target.reasoning?.defaultEffort;
    if(typeof effort==='string'&&efforts.includes(effort))selection.reasoningEffort=effort;
    return {unsupported:false,models:models.map(item=>item.id),refresh,async select(guard){
     still(id,guard);const current=directory.store.getSnapshot();
     if(current.status==='selecting'||current.pending)throw Error('模型选择尚未完成，请稍后重试。');
     if(same(current.current,selection))return;
     if(!same(current.current,previous))throw Error('模型已由其它操作更改，未覆盖新的选择。');
     let result;try{result=await directory.select(selection)}catch{throw Error('模型选择失败，请使用右侧模型选择器重试。')}
     if(!result?.ok)throw Error(result?.error?.code==='session/writer-held'?'此会话正由其它 DSH 实例使用。':'模型选择失败，请使用右侧模型选择器重试。');
    }};
   },
  };
 }
 function UsagePill({directory,selection}){
  const state=React.useSyncExternalStore(directory.subscribe,directory.getSnapshot,directory.getSnapshot),provider=state.current?.provider,model=state.current?.model;
  const visible=provider==='openai-codex'||(typeof provider==='string'&&provider.startsWith('cpa-codex-'));
  const [data,setData]=React.useState(null),[open,setOpen]=React.useState(false),[error,setError]=React.useState(''),[actionError,setActionError]=React.useState(''),[busy,setBusy]=React.useState(false);
  const root=React.useRef(null),quotaButton=React.useRef(null),panel=React.useRef(null),panelId=React.useRef('cpa-quota-'+(++quotaSequence)),lifetime=React.useRef(null),reading=React.useRef(null),acting=React.useRef(null),revision=React.useRef(0);
  React.useEffect(()=>{
   if(!visible)return;
   const life={};lifetime.current=life;acting.current=null;setBusy(false);setOpen(false);setData(null);setError('');setActionError('');
   const refresh=()=>{
    if(lifetime.current!==life||document.visibilityState==='hidden'||acting.current)return;
    const version=revision.current,current=()=>lifetime.current===life&&revision.current===version;
    if(reading.current){const previous=reading.current;if(previous.life===life&&previous.version===version)return;previous.promise.catch(()=>{}).then(()=>{if(current())refresh()});return}
    const request={life,version};request.promise=(async()=>{
     try{const next=await call();if(current()){setData(next);setError('')}}catch(e){if(current())setError(e.message)}finally{if(reading.current===request)reading.current=null}
    })();reading.current=request;
   };
   refresh();const timer=setInterval(refresh,60000);document.addEventListener('visibilitychange',refresh);
   return()=>{if(lifetime.current===life)lifetime.current=null;clearInterval(timer);document.removeEventListener('visibilitychange',refresh)};
  },[visible,provider,model]);
  const close=()=>{setOpen(false);quotaButton.current?.focus()};
  React.useEffect(()=>{
   if(!open)return;
   panel.current?.focus();
   const click=event=>{if(!root.current?.contains(event.target))setOpen(false)},key=event=>{if(event.key==='Escape'){event.preventDefault?.();close()}};
   document.addEventListener('mousedown',click);document.addEventListener('keydown',key);
   return()=>{document.removeEventListener('mousedown',click);document.removeEventListener('keydown',key)};
  },[open]);
  if(!visible)return null;
  const references=(data?.accounts??[]).filter(account=>account.owned===false);
  const account=data?.accounts?.find(account=>account.provider===provider)??(provider==='openai-codex'&&references.length===1?references[0]:null);
  const quota=account?.modelQuotas?.find(item=>item.model===model&&item.windows?.length)??account?.quota;
  const failure=error||account?.quotaError,stale=!!failure||account?.quotaStale===true||(quota?.observedAt&&Date.now()-Date.parse(quota.observedAt)>900000);
  const weekly=(quota?.windows??[]).filter(window=>window.minutes>=10080&&window.minutes%10080===0);
  const summary=weekly.length?weekly.map(window=>period(window.minutes)+' '+window.used+'%').join(' · ')+(stale?' *':''):'周 —';
  const fast=data?.fast,ownedChannel=Array.isArray(fast?.providers)&&fast.providers.includes(provider);
  const canSwitch=provider==='openai-codex'&&Array.isArray(fast?.providers)&&fast.providers.includes(account?.provider)&&selection?.available();
  const available=fast?.available===true&&account?.enabled===true&&account?.availability==='ready'&&(ownedChannel||canSwitch);
  const effective=ownedChannel&&available&&fast.enabled===true,reason=fast?.reason?messageOf(fast.reason):(available?'':'请先选择一个可用的 CPA 账号和模型。');
  const toggle=async()=>{
   if(!available||!lifetime.current||acting.current)return;
   const token={life:lifetime.current,version:++revision.current};acting.current=token;setBusy(true);setActionError('');
   const current=()=>lifetime.current===token.life&&acting.current===token&&revision.current===token.version;
   try{
    const prepared=!ownedChannel?await selection.prepare(account.provider,model):null;if(!current())return;
    if(prepared?.unsupported)throw Error('当前模型不受此 CPA 通道支持，请先明确选择 CPA 模型。');
    const next=await call({action:'fast',enabled:!effective,accountId:account.id});if(!current())return;
    if(!next.fast||!Array.isArray(next.accounts)||!next.preferences)throw Error('api-invalid-settings');
    if(next.fast.enabled!==!effective)throw Error('Fast 设置未被服务端确认，请重试。');
    const enabled=next.accounts.filter(item=>item.enabled===true);
    if(enabled.length!==1||enabled[0].id!==account.id||next.preferences.activeAccountId!==account.id||!Array.isArray(next.fast.providers)||!next.fast.providers.includes(account.provider)){setData(next);throw Error('账号已更改，未切换当前会话模型。')}
    setData(next);setError('');
    if(prepared)await prepared.select(current);
   }catch(e){if(current())setActionError('Fast 设置失败：'+e.message)}
   finally{if(acting.current===token){acting.current=null;if(lifetime.current===token.life)setBusy(false)}}
  };
  return h('div',{ref:root,className:'cpaPill_root',style:{height:28,alignItems:'center',gap:2}},
   h('button',{type:'button',role:'switch',className:'cpaPill_trigger',style:{...toolbarStyle,color:effective?'var(--dsw-alias-brand-primary,#24a866)':undefined,opacity:effective?1:undefined},disabled:!available||busy,'aria-checked':effective,'aria-label':available?'Fast'+(effective?' 已启用':' 已关闭'):'Fast 不可用：'+reason,title:available?'Fast 请求 priority，可能更快消耗额度；开启时通过标准模型选择器使用该账号的 CPA 通道，只影响之后准备的请求。':reason,onClick:available?toggle:undefined},'Fast'),
   h('button',{ref:quotaButton,type:'button',className:'cpaPill_trigger',style:toolbarStyle,onClick:()=>setOpen(value=>!value),'aria-expanded':open,'aria-haspopup':'dialog','aria-controls':panelId.current,'aria-label':'查看周额度',title:'查看周额度'},summary),
   actionError?h('span',{role:'alert',style:{...ui.muted,position:'absolute',bottom:'calc(100% + 6px)',right:0,maxWidth:320,padding:8,borderRadius:8,background:'var(--dsw-alias-bg-layer-2,Canvas)',zIndex:101}},actionError):null,
   open?h('div',{ref:panel,id:panelId.current,className:'cpaPill_panel',role:'dialog','aria-label':'账号额度',tabIndex:-1},h('div',{className:'cpaPill_material'}),h('div',{className:'cpaPill_body'},
    h('div',{style:{...ui.buttons,alignItems:'center',justifyContent:'space-between'}},h('strong',null,'额度'),h('button',{type:'button',className:'cpaPill_back','aria-label':'关闭额度',onClick:close},'×')),
    account?h('div',{className:'cpaPill_accHead'},dot(account),h('span',{className:'cpaPill_accName'},emailOf(account))):null,
    h(Quota,{quota}),failure?h('p',{className:'cpaPill_warning',role:'status'},'额度刷新失败：'+failure+'；已有记录为旧观测，并非本次刷新结果。'):stale?h('p',{className:'cpaPill_hint'},'当前额度为旧观测。'):null,
    h('p',{className:'cpaPill_hint'},quota?.observedAt?'最近观测：'+stamp(quota.observedAt)+'；记录可能过期。':'额度来自 ChatGPT；当前账号暂无可确认记录。'))):null);
 }

 function Quota({quota}){
  if(!quota?.windows?.length)return h('div',{style:ui.muted},'暂无可用的额度记录，请稍后刷新。');
  return h('div',{style:{display:'grid',gap:12}},...quota.windows.map(w=>h('div',{key:w.name,style:{display:'grid',gap:6}},
    h('div',{style:{display:'flex',justifyContent:'space-between',gap:12}},h('strong',null,`${period(w.minutes)}额度`),h('span',null,`剩余 ${w.remaining}% · 已用 ${w.used}%`)),
    h('div',{style:ui.track},h('div',{style:{width:`${w.used}%`,height:'100%',background:w.used>=80?'#d98632':'#51a8e8'}})),
    h('div',{style:ui.muted},w.resetAt?`重置时间：${stamp(w.resetAt*1000)}`:'重置时间：未提供'))),
   h('div',{style:ui.muted},`额度观测时间：${quota.observedAt?stamp(quota.observedAt):'未知'}；数据可能有延迟。`));
 }
 function useActivity(resolveModel){
  const [data,setData]=React.useState(null),[refreshError,setRefreshError]=React.useState(''),[error,setError]=React.useState(''),[message,setMessage]=React.useState('');
  const [busy,setBusy]=React.useState({}),[errors,setErrors]=React.useState({}),[messages,setMessages]=React.useState({}),[models,setModels]=React.useState({}),[clearBusy,setClearBusy]=React.useState(false);
  const initialView={filters:{status:'',model:'',source:'',accountId:''},cursor:null,back:[]};
  const [view,setView]=React.useState(initialView),[history,setHistory]=React.useState(null);
  const lifetime=React.useRef(null),reading=React.useRef(null),revision=React.useRef(0),operations=React.useRef(new Map()),clearing=React.useRef(null),viewRef=React.useRef(initialView),modelRef=React.useRef({}),historyGeneration=React.useRef(0),historyAccount=React.useRef(null);
  const accountState=id=>data?.accounts?.find(account=>account.id===id)?.pelican;
  const mergeAccount=(next,id)=>setData(previous=>({...previous,accounts:[...(previous?.accounts??[]).filter(account=>account.id!==id),...(next.accounts??[]).filter(account=>account.id===id)]}));
  const read=()=>{
   const life=lifetime.current,version=revision.current,query=viewRef.current;
   const current=()=>life&&lifetime.current===life&&revision.current===version&&viewRef.current===query;
   if(!life)return Promise.resolve();
   if(reading.current){
    const previous=reading.current;
    if(previous.life===life&&previous.version===version&&previous.query===query)return previous.promise;
    return previous.promise.catch(()=>{}).then(()=>current()?read():undefined);
   }
   const request={life,version,query};
   request.promise=(async()=>{
    try{
     const next=await call(undefined,activityURL('/api/cpa-activity',query.filters,query.cursor));
     if(current()){
      setData(previous=>({...next,accounts:[...(next.accounts??[]).filter(account=>!operations.current.has(account.id)),...(previous?.accounts??[]).filter(account=>operations.current.has(account.id))]}));
      setRefreshError('');
     }
    }catch(e){if(current())setRefreshError(e.message);throw e}
    finally{if(reading.current===request)reading.current=null}
   })();reading.current=request;return request.promise;
  };
  React.useEffect(()=>{
   const life={};lifetime.current=life;
   const refresh=()=>{if(lifetime.current!==life||document.visibilityState==='hidden'||operations.current.size||clearing.current||viewRef.current.cursor!==null)return;read().catch(()=>{})};
   refresh();const timer=setInterval(refresh,3000);document.addEventListener('visibilitychange',refresh);
   return()=>{if(lifetime.current===life)lifetime.current=null;clearInterval(timer);document.removeEventListener('visibilitychange',refresh)};
  },[]);
  React.useEffect(()=>{if(document.visibilityState!=='hidden')read().catch(()=>{})},[view]);
  const changeView=next=>{
   if(!lifetime.current)return;
   revision.current++;viewRef.current=next;setView(next);setData(previous=>previous?{...previous,logs:null}:previous);setRefreshError('');
  };
  const act=async(account,kind,build,notice,stop=false,onSuccess)=>{
   const id=account.id,previous=operations.current.get(id);
   if(!lifetime.current||clearing.current||(previous&&(!stop||previous.stop)))return;
   const token={life:lifetime.current,kind,stop};operations.current.set(id,token);revision.current++;
   setBusy(value=>({...value,[id]:token}));setErrors(value=>({...value,[id]:''}));setMessages(value=>({...value,[id]:''}));
   const current=()=>lifetime.current===token.life&&operations.current.get(id)===token;
   try{
    const body=await build();if(!current())return;
    const next=await call(body,'/api/cpa-activity');if(!current())return;
    if(!Array.isArray(next.accounts)||!next.accounts.find(item=>item.id===id)?.pelican)throw Error('api-invalid-activity');
     mergeAccount(next,id);onSuccess?.(next);setMessages(value=>({...value,[id]:notice}));
   }catch(e){if(current())setErrors(value=>({...value,[id]:'操作失败：'+e.message}))}
   finally{if(operations.current.get(id)===token){operations.current.delete(id);if(lifetime.current===token.life)setBusy(value=>{const next={...value};delete next[id];return next})}}
  };
  const configure=(account,value)=>{
   const interval=Number(value);
   if(!['0','5','10','20','30'].includes(String(value))||!Number.isInteger(interval))return;
   return act(account,interval===0?'disable':'configure',async()=>({action:'pelican-configure',accountId:account.id,intervalMinutes:interval,...(interval?{model:await resolveModel(account,modelRef.current[account.id])}:{})}),'',interval===0,next=>{const model=next.accounts.find(item=>item.id===account.id)?.pelican?.model;if(typeof model==='string'){modelRef.current={...modelRef.current,[account.id]:model};setModels(modelRef.current)}});
  };
  const run=account=>act(account,'run',async()=>({action:'pelican-run',accountId:account.id,model:await resolveModel(account,modelRef.current[account.id])}),'');
  const cancel=account=>act(account,'cancel',()=>({action:'pelican-cancel',accountId:account.id}),'',true);
  const stop=account=>operations.current.get(account.id)?.kind==='configure'?configure(account,'0'):cancel(account);
  const clear=async()=>{
   if(!lifetime.current||clearing.current||operations.current.size)return;
   if(!window.confirm('请求文本日志无限持久保存。确定清空全部账号的日志和累计统计吗？此操作无法撤销。'))return;
   const token={life:lifetime.current};clearing.current=token;revision.current++;setClearBusy(true);setError('');setMessage('');
   const current=()=>lifetime.current===token.life&&clearing.current===token;
   try{
    const next=await call({action:'logs-clear'},'/api/cpa-activity');if(!current())return;
    const query={...viewRef.current,cursor:null,back:[]};revision.current++;viewRef.current=query;setView(query);
    setData(previous=>({...previous,logs:next.logs}));setRefreshError('');setMessage('请求日志与累计统计已清空。');
   }catch(e){if(current())setError('操作失败：'+e.message)}
   finally{if(clearing.current===token){clearing.current=null;if(lifetime.current===token.life)setClearBusy(false)}}
  };
  const closeHistory=()=>{historyGeneration.current++;historyAccount.current=null;setHistory(null)};
  const openHistory=async account=>{
   const life=lifetime.current;if(!life)return;
   const generation=++historyGeneration.current;historyAccount.current=account.id;
   setHistory({accountId:account.id,email:account.email,images:[],loading:true,error:''});
   const current=()=>lifetime.current===life&&historyGeneration.current===generation;
   try{
    const next=await call(undefined,'/api/cpa-history?accountId='+encodeURIComponent(account.id));
    if(current())setHistory({accountId:account.id,email:account.email,images:(Array.isArray(next.images)?next.images:[]).slice(0,8).flatMap(image=>{const url=pngURL(image,account.id);return url?[{...image,url}]:[]}),loading:false,error:''});
   }catch(e){if(current())setHistory({accountId:account.id,email:account.email,images:[],loading:false,error:'历史读取失败：'+e.message})}
  };
  const forget=id=>{
   revision.current++;operations.current.delete(id);
   if(historyAccount.current===id){historyGeneration.current++;historyAccount.current=null;}
   setData(previous=>previous?{...previous,accounts:(previous.accounts??[]).filter(account=>account.id!==id)}:previous);
   setBusy(previous=>{const next={...previous};delete next[id];return next});
   setHistory(previous=>previous?.accountId===id?null:previous);
    const clean=previous=>{const next={...previous};delete next[id];return next};
    modelRef.current=clean(modelRef.current);setModels(modelRef.current);setErrors(clean);setMessages(clean);
  };
  return {data,refreshError,error,message,busy,errors,messages,models,clearBusy,view,history,accountState,configure,run,cancel,stop,clear,openHistory,closeHistory,forget,
   setModel:(account,value)=>{
     if(!lifetime.current||operations.current.has(account.id)||account.enabled!==true||!(value===''||(account.models??[]).includes(value)))return;
     const interval=accountState(account.id)?.intervalMinutes??0;
     return act(account,'configure',async()=>({action:'pelican-configure',accountId:account.id,intervalMinutes:interval,model:interval?await resolveModel(account,value):value}),'',false,next=>{const model=interval?next.accounts.find(item=>item.id===account.id)?.pelican?.model:value;modelRef.current={...modelRef.current,[account.id]:model};setModels(modelRef.current)});
    },
   filter:(key,value)=>{if(!Object.hasOwn(viewRef.current.filters,key))return;changeView({filters:{...viewRef.current.filters,[key]:value},cursor:null,back:[]})},
   next:()=>{const cursor=data?.logs?.page?.nextCursor;if(typeof cursor==='string'&&cursor)changeView({...viewRef.current,cursor,back:[...viewRef.current.back,viewRef.current.cursor]})},
   previous:()=>{const back=viewRef.current.back;if(back.length)changeView({...viewRef.current,cursor:back[back.length-1],back:back.slice(0,-1)})},
   newest:()=>changeView({...viewRef.current,cursor:null,back:[]})};
 }
 const activityURL=(path,filters,cursor=null)=>{
  const query=new URLSearchParams();for(const key of ['status','model','source','accountId'])if(filters[key])query.set(key,filters[key]);if(cursor!==null)query.set('cursor',cursor);
  return path+(query.size?'?'+query.toString():'');
 };
 const pngURL=(image,accountId)=>{
  if(!image||typeof image.id!=='string'||typeof image.url!=='string'||!image.url.startsWith('/api/cpa-image?'))return null;
  try{const url=new URL(image.url,'https://cpa.invalid');return url.origin==='https://cpa.invalid'&&url.pathname==='/api/cpa-image'&&!url.hash&&url.searchParams.get('accountId')===accountId&&url.searchParams.get('imageId')===image.id&&[...url.searchParams.keys()].length===2?url.pathname+url.search:null}catch{return null}
 };
 const metric=(value,suffix='')=>typeof value==='number'&&Number.isFinite(value)?value.toLocaleString(undefined,{maximumFractionDigits:2})+suffix:'—';
 const ratio=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1?metric(value*100,'%'):'—';
 const activityStamp=value=>{if(value==null)return '—';const date=new Date(value),today=new Date();if(!Number.isFinite(date.getTime()))return '—';const part=n=>String(n).padStart(2,'0');return date.getFullYear()===today.getFullYear()&&date.getMonth()===today.getMonth()&&date.getDate()===today.getDate()?part(date.getHours())+':'+part(date.getMinutes()):part(date.getMonth()+1)+'-'+part(date.getDate())};
 const activityStatus=value=>({running:'进行中',success:'成功',error:'失败',cancelled:'已取消'})[value]??'—';
 const validUsd=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
 const usd=value=>!validUsd(value)?'—':'$'+(value>0&&value<0.000001?value.toExponential(2):value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:6}));
 const requestCost=entry=>!validUsd(entry.estimatedCostUsd)||!['estimate','upper-bound'].includes(entry.costBasis)?'—':entry.costBasis==='upper-bound'?'≤ '+usd(entry.estimatedCostUsd)+'（缓存计费上限）':'≈ '+usd(entry.estimatedCostUsd);
 const pricingLinks=sources=>Array.isArray(sources)?[...new Set(sources.flatMap(source=>{
  if(typeof source!=='string')return [];
  try{const url=new URL(source);return ['http:','https:'].includes(url.protocol)&&['openai.com','www.openai.com','platform.openai.com','developers.openai.com'].includes(url.hostname)&&!url.username&&!url.password&&!url.port?[url.href]:[]}catch{return []}
 }))]:[];
 const emailOf=account=>typeof account.email==='string'&&account.email?account.email:'邮箱未知';
 const accountAvailability=account=>({ready:'凭据就绪，可使用此通道（不表示已执行付费测试）',unavailable:'凭据不可用',unknown:'凭据状态未知'})[account.availability]??'凭据状态未知';
 const dot=account=>h('span',{role:'img','aria-label':account.enabled===false?'未启用':accountAvailability(account),title:account.enabled===false?'未启用':accountAvailability(account),style:{display:'inline-block',flexShrink:0,width:7,height:7,borderRadius:'50%',background:account.enabled!==false&&account.availability==='ready'?'#39a878':'#999'}});
 function AccountRows({data,activity,busy,onSelect,onRemove,modelChoice}){
  const accounts=data?.accounts??[];
  return h('section',{className:'cpaGo_card','aria-label':'ChatGPT 账号',style:ui.card},
   ...accounts.map(account=>{
    const id=account.id,email=emailOf(account),pelican=activity.accountState(id),operation=activity.busy[id],stopping=operation?.stop===true;
    const active=!!operation||pelican?.running===true,interval=pelican?.intervalMinutes??data?.preferences?.plans?.[id]?.intervalMinutes??0;
    const state=!pelican?'读取中…':[stopping?'停止中':operation?.kind==='run'&&!pelican.running?'准备中':operation?.kind==='configure'?'保存中':pelican.running?'运行中':null,pelican.nextRunAt?'下次 '+activityStamp(pelican.nextRunAt):null].filter(Boolean).join(' · ');
    const probeModel=activity.models[id]??pelican?.model??data?.preferences?.plans?.[id]?.model??'';
    return h('article',{key:id,'aria-label':email+' 账号',style:{display:'grid',gap:8,padding:'10px 0',borderTop:'1px solid #8883',minWidth:0}},
     h('div',{style:{...ui.buttons,alignItems:'center',justifyContent:'space-between'}},
      h('div',{style:{...ui.buttons,alignItems:'center',minWidth:0}},h('input',{type:'radio',name:'cpa-enabled-account',value:id,checked:account.enabled===true,disabled:busy||account.availability!=='ready','aria-label':'启用 '+email,title:account.availability==='ready'?'一次只启用一个账号':accountAvailability(account),onChange:()=>onSelect(account),style:{margin:0,accentColor:'#39a878'}}),h('button',{type:'button',disabled:busy||account.availability!=='ready',onClick:()=>onSelect(account),title:'启用此账号；一次只启用一个，切换会暂停旧账号的自动测试。',style:{font:'inherit',color:'inherit',background:'none',border:0,padding:0,textAlign:'left',cursor:'pointer',overflowWrap:'anywhere'}},email)),
      account.owned===true?h('button',{type:'button','aria-label':'移除 '+email,disabled:busy,onClick:()=>onRemove(account),style:{font:'inherit',color:'inherit',background:'none',border:0,cursor:'pointer'}},'移除'):null),
     h('div',{role:'group','aria-label':email+' 的测试控制',style:{...ui.buttons,alignItems:'center'}},
      h(Button,{type:'button',variant:'outline',size:'md','aria-label':email+' '+(active?'停止':'鹈鹕测试'),disabled:stopping||activity.clearBusy||busy||(!active&&(!pelican||account.canRunProbe!==true||pelican.available===false)),onClick:active?()=>activity.stop(account):()=>activity.run(account)},active?'停止':'鹈鹕测试'),
      h('select',{'aria-label':email+' 的自动执行间隔',className:'cpaGo_input',value:String(interval),disabled:stopping||activity.clearBusy||busy,onChange:e=>activity.configure(account,e.target.value)},...[0,5,10,20,30].map(value=>h('option',{key:value,value:String(value),disabled:value!==0&&(!!operation||account.enabled!==true||account.canRunProbe!==true||pelican?.available===false)},value?value+'分钟':'不自动执行'))),
      h(Button,{type:'button',variant:'outline',size:'md','aria-label':email+' 的历史',onClick:()=>activity.openHistory(account)},'历史')),
     state?h('span',{'aria-label':email+' 的测试状态',role:'status',style:ui.muted},state):null,
     modelChoice?.accountId===id?h('div',{role:'status',style:{display:'grid',gap:6}},h('p',{style:ui.muted},'当前模型不被目标 CPA 通道支持，请明确选择模型。'),h('label',null,'会话模型',h('select',{'aria-label':email+' 的会话模型',className:'cpaGo_input',value:'',disabled:busy,onChange:e=>{if(e.target.value)onSelect(account,e.target.value)}},h('option',{value:''},'请选择模型'),...modelChoice.models.map(model=>h('option',{key:model,value:model},model))))):null,
     activity.errors[id]?h('p',{role:'alert',style:ui.muted},activity.errors[id]):null,
     activity.messages[id]?h('p',{role:'status',style:ui.muted},activity.messages[id]):null,
     pelican?.lastError?h('p',{role:'status',style:ui.muted},'最近测试失败：'+pelican.lastError):null,
     h('details',{'aria-label':email+' 的额度和测试设置'},h('summary',null,'额度与测试设置'),h('div',{style:{display:'grid',gap:8,paddingTop:8}},
      account.quotaError?h('p',{role:'status',style:ui.muted},'额度刷新失败：'+account.quotaError+'；已有记录为旧观测，并非本次刷新结果。'):account.quotaStale?h('p',{role:'status',style:ui.muted},'当前额度为旧观测，并非本次刷新结果。'):null,
      h(Quota,{quota:account.quota}),h('label',null,'测试模型',h('select',{'aria-label':email+' 的测试模型',className:'cpaGo_input',value:probeModel,disabled:!!operation||pelican?.running||account.enabled!==true||activity.clearBusy||busy,onChange:e=>activity.setModel(account,e.target.value)},h('option',{value:''},'使用当前会话模型（须为支持的 Codex 模型）'),probeModel&&!(account.models??data.models??[]).includes(probeModel)?h('option',{value:probeModel,disabled:true},probeModel+'（当前不可用）'):null,...(account.models??data.models??[]).map(model=>h('option',{key:model,value:model},model)))))));
   }),
   !accounts.length?h('p',{style:ui.muted},data?'暂无已授权账号。':'等待连接。'):null,
   h('details',{'aria-label':'测试说明',style:ui.muted},h('summary',null,'测试说明 · 消耗 ChatGPT 额度'),h('div',{style:{display:'grid',gap:8,paddingTop:8}},
    h('code',{'aria-label':'固定提示词'},'生成一张鹈鹕骑自行车的SVG'),
    h('p',{style:ui.muted},'计划默认关闭。下拉框只保存自动执行计划；保存后等待完整间隔，不会立即调用模型。鹈鹕测试按钮只运行一次。停止取消当前测试；选择不自动执行也会关闭后续计划。'),
    h('p',{style:ui.muted},'测试需要明确的有效 Codex 模型，不会任意选择付费模型。历史只展示通过认证接口取得的 PNG；图片仅内存保存，重启后消失，不保存 SVG、提示词、会话或浏览器持久缓存。'))),
   activity.history?h('section',{'aria-label':(activity.history.email||'邮箱未知')+' 的 PNG 历史',style:{display:'grid',gap:8}},
    h('div',{style:{...ui.buttons,justifyContent:'space-between'}},h('strong',null,(activity.history.email||'邮箱未知')+' · 历史'),h(Button,{type:'button',variant:'outline',onClick:activity.closeHistory},'关闭历史')),
    activity.history.loading?h('p',{role:'status',style:ui.muted},'正在读取 PNG 历史…'):null,
    activity.history.error?h('p',{role:'alert',style:ui.muted},activity.history.error):null,
    ...activity.history.images.map(image=>h('figure',{key:image.id,style:{margin:0}},h('img',{src:image.url,alt:'鹈鹕测试 PNG · '+stamp(image.createdAt),loading:'lazy',style:{display:'block',maxWidth:'100%',maxHeight:512,objectFit:'contain'}}),h('figcaption',{title:stamp(image.createdAt),style:ui.muted},activityStamp(image.createdAt)))),
    !activity.history.loading&&!activity.history.error&&!activity.history.images.length?h('p',{style:ui.muted},'暂无 PNG 历史。'):null):null);
 }
 function Activity({activity,models,accounts}){
  const {data,view}=activity,logs=data?.logs,summary=logs?.summary;
  const count=value=>Number.isSafeInteger(value)&&value>=0?value:null,total=count(summary?.total);
  const priced=total===0?0:count(summary?.pricedRequests),unpriced=total===0?0:count(summary?.unpricedRequests),upper=total===0?0:count(summary?.upperBoundRequests);
  const cost=total===0?'$0.00（无请求）':priced>0&&unpriced!==null&&upper!==null&&validUsd(summary?.estimatedCostUsd)?(upper>0?'≤ ':'≈ ')+usd(summary.estimatedCostUsd)+(upper>0?'（含缓存计费上限）':''):'—';
  const sources=pricingLinks(logs?.pricing?.sources),checkedAt=typeof logs?.pricing?.checkedAt==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(logs.pricing.checkedAt)?logs.pricing.checkedAt:'—';
  const field={display:'flex',flexDirection:'column',gap:6,minWidth:0},cell={padding:'8px 10px',textAlign:'left',whiteSpace:'nowrap',borderBottom:'1px solid #8883',fontSize:12};
  const stat=(label,value,caption=label)=>h('div',{key:label,'aria-label':label,style:field},h('span',{style:ui.muted},caption),h('strong',null,value));
  const headers=['开始','账号','来源','模型','结果','HTTP','缓存读 / 写','命中率','输入 / 输出','TTFT ms','耗时 ms','TPS t/s','标准价 USD','请求 / 响应档位'];
  const filter=(key,label,options)=>h('label',{style:field},label,h('select',{'aria-label':'日志'+label,className:'cpaGo_input',value:view.filters[key],onChange:e=>activity.filter(key,e.target.value)},h('option',{value:''},'全部'),...options.map(([value,text])=>h('option',{key:value,value},text))));
  return h('section',{className:'cpaGo_card',style:{...ui.card,minWidth:0}},
   h('div',{style:{...ui.buttons,alignItems:'center',justifyContent:'space-between'}},h('strong',null,'请求记录'),h('div',{style:ui.buttons},h('a',{href:activityURL('/api/cpa-logs-export',view.filters),download:'cpa-logs.ndjson'},'导出全部匹配日志'),h(Button,{type:'button',variant:'outline',size:'md',onClick:activity.clear,disabled:activity.clearBusy||Object.keys(activity.busy).length>0||!logs},activity.clearBusy?'清空中…':'清空请求日志'))),
   h('div',{role:'group','aria-label':'日志筛选',style:ui.buttons},filter('status','状态',[['running','进行中'],['success','成功'],['error','失败'],['cancelled','已取消']]),filter('model','模型',models.map(model=>[model,model])),filter('source','来源',[['conversation','会话'],['pelican','鹈鹕测试']]),filter('accountId','账号',accounts.map(account=>[account.id,emailOf(account)]))),
   logs?.available===false?h('p',{role:'status',style:ui.muted},'宿主未提供会话请求日志能力；仍可查看已记录的测试请求。'):null,
   logs?.storage?.available===false?h('p',{role:'alert',style:ui.muted},'文本日志持久存储不可用：'+(logs.storage.error||'未知错误')+'；不能保证已持久保存。'):logs?.storage?.error?h('p',{role:'alert',style:ui.muted},'日志存储警告：'+logs.storage.error):null,
   logs?.recording?.failed>0?h('p',{role:'alert',style:ui.muted},metric(logs.recording.failed)+' 条记录未能持久保存：'+logs.recording.error):null,
   summary?h('div',{style:{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(135px,1fr))',gap:12}},
    stat('累计 / 进行中',metric(summary.total)+' / '+metric(summary.running)),stat('成功 / 失败 / 取消',metric(summary.success)+' / '+metric(summary.error)+' / '+metric(summary.cancelled)),
    stat('输入 / 输出 tokens',metric(summary.inputTokens)+' / '+metric(summary.outputTokens)),stat('平均 TTFT',metric(summary.avgTtftMs,' ms')),stat('平均总耗时',metric(summary.avgDurationMs,' ms')),stat('平均 TPS',metric(summary.avgTps,' token/s')),stat('平均缓存命中率',ratio(summary.avgCacheHitRate)),stat('已知请求标准价参考',cost,'标准价 USD')):null,
   summary?h('p',{'aria-label':'美元估算覆盖',style:ui.muted},'已估算 '+metric(priced)+' / '+metric(priced===null||unpriced===null?null:priced+unpriced)+' 个已完成请求；未知 '+metric(unpriced)+'；缓存计费上限 '+metric(upper)+'。'):null,
   h('div',{role:'region','aria-label':'请求日志表格，可横向滚动',tabIndex:0,style:{width:'100%',minWidth:0,overflowX:'auto'}},
    h('table',{'aria-label':'请求日志',style:{width:'100%',minWidth:1200,borderCollapse:'collapse'}},
     h('thead',null,h('tr',null,...headers.map(label=>h('th',{key:label,scope:'col',style:cell},label)))),
     h('tbody',null,...(Array.isArray(logs?.entries)?logs.entries:[]).slice(0,50).map(entry=>h('tr',{key:entry.id},...[
      activityStamp(entry.startedAt),entry.accountEmail||'邮箱未知',entry.source==='pelican'?'鹈鹕测试':entry.source==='conversation'?'会话':'—',entry.model??'—',activityStatus(entry.status)+(entry.errorCode?' · '+entry.errorCode:''),
      metric(entry.httpStatus),metric(entry.cacheReadTokens)+' / '+metric(entry.cacheWriteTokens),ratio(entry.cacheHitRate),metric(entry.inputTokens)+' / '+metric(entry.outputTokens),metric(entry.ttftMs),metric(entry.durationMs),metric(entry.tps),requestCost(entry),(entry.serviceTierRequested??'—')+' / '+(entry.serviceTierReported??'—')
     ].map((value,index)=>h('td',{key:index,style:cell,...(index===0?{title:entry.startedAt==null?'—':stamp(entry.startedAt)}:index===1?{title:entry.accountEmail||'邮箱未知'}:index===3?{title:(entry.provider??'—')+' · '+(entry.priceModel??'未知价格型号')}:index===4?{title:entry.finishReason?'终止原因：'+entry.finishReason:undefined}:index===6?{title:'用量来源：'+(entry.usageEvidence??'unavailable')}:{})},index===0?h('time',{dateTime:entry.startedAt??undefined,title:entry.startedAt==null?'—':stamp(entry.startedAt)},value):value))))))),
   !logs?.entries?.length?h('p',{style:ui.muted},logs?'暂无请求记录。':'正在读取请求活动…'):null,
   h('nav',{'aria-label':'日志分页',style:{...ui.buttons,alignItems:'center'}},h(Button,{type:'button',variant:'outline',onClick:activity.previous,disabled:!view.back.length||activity.clearBusy},'上一页'),h('span',{role:'status'},'第 '+(view.back.length+1)+' 页 · 每页最多 50 条'),h(Button,{type:'button',variant:'outline',onClick:activity.next,disabled:!logs?.page?.nextCursor||activity.clearBusy},'下一页'),view.cursor!==null?h(Button,{type:'button',variant:'outline',onClick:activity.newest,disabled:activity.clearBusy},'返回最新'):null),
   h('details',{'aria-label':'统计与估算说明',style:ui.muted},h('summary',null,'统计与估算说明 · '+checkedAt),h('div',{style:{display:'grid',gap:8,paddingTop:8}},
    h('p',{style:ui.muted},'文本日志持续保存在服务端，无自动条数上限；当前只读取一页 50 条。首页自动刷新，查看旧页时不跳页。导出直接下载全部匹配文本日志，清空需要确认。图片仅保存在内存，不写入日志。'),
    h('p',{style:ui.muted},'— 表示宿主未提供该指标或请求尚未产生该数据。成功不代表 HTTP 200；未知 HTTP、TTFT、TPS、缓存命中率不会推算。'),
    h('p',{style:ui.muted},'金额仅含已知请求，未知不代表零费用，也不能视作完整账单。'),
    h('p',{style:ui.muted},'按 OpenAI 标准 API 价格折算，不是 ChatGPT 订阅实际账单，也不是实际 Fast 账单。请求 priority 不代表响应确认 priority。≤ 表示缓存细节不足，按较高标准单价估算的缓存计费上限，并非精确费用。'),
    h('p',{style:ui.muted},'价目表核对日期：'+checkedAt+'；基准：OpenAI Standard API；币种：USD。'),
    summary?h('p',{style:ui.muted},'已知样本：输入 '+metric(summary.samples?.inputTokens)+'；输出 '+metric(summary.samples?.outputTokens)+'；缓存读 '+metric(summary.samples?.cacheReadTokens)+'；缓存写 '+metric(summary.samples?.cacheWriteTokens)+'；TTFT '+metric(summary.samples?.ttft)+'；TPS '+metric(summary.samples?.tps)+'；缓存命中率 '+metric(summary.samples?.cacheHitRate)+'。平均值仅统计已提供的有效数据。'):null,
    sources.length?h('div',{'aria-label':'官方价格来源',style:ui.buttons},...sources.map((href,index)=>h('a',{key:href,href,target:'_blank',rel:'noopener noreferrer',title:href},'OpenAI 官方价目表 '+(index+1)))):h('p',{style:ui.muted},'官方价目表来源：—'))),
   activity.refreshError?h('p',{role:'status',style:ui.muted},'请求活动刷新失败：'+activity.refreshError+'；当前内容可能为旧观测。'):null,
   activity.error?h('p',{role:'alert',style:ui.muted},activity.error):null,activity.message?h('p',{role:'status',style:ui.muted},activity.message):null);
 }

 function Page({selection}={}){
  const [data,setData]=React.useState(null),[auth,setAuth]=React.useState(''),[callback,setCallback]=React.useState(''),[message,setMessage]=React.useState(''),[busy,setBusy]=React.useState(false),[modelsOpen,setModelsOpen]=React.useState(false),[filter,setFilter]=React.useState(''),[selected,setSelected]=React.useState('');
  const [modelChoice,setModelChoice]=React.useState(null);
  const activity=useActivity(async(account,explicit)=>{
   const model=explicit===undefined?(data?.preferences?.plans?.[account.id]?.model||await selection?.model()):(explicit||await selection?.model());
   if(typeof model!=='string'||!(account.models??data?.models??[]).includes(model))throw Error('请先选择该账号支持的 Codex 模型。');
   return model;
  });
  const [refreshError,setRefreshError]=React.useState(''),[authVersion,setAuthVersion]=React.useState(0);
  const lifetime=React.useRef(null),reading=React.useRef(null),action=React.useRef(null),actionVersion=React.useRef(0),authGeneration=React.useRef(0),checking=React.useRef(null);
  const nextAuthorization=()=>{const version=++authGeneration.current;setAuthVersion(version);return version};
  const clearAuthorization=()=>{const version=nextAuthorization();setAuth('');setCallback('');setData(d=>({...d,authorizationPending:false}));return version};
  // Share an in-flight GET, but never apply a snapshot from before an action or auth transition.
  const readData=()=>{
   const life=lifetime.current,generation=authGeneration.current,version=actionVersion.current;
   const current=()=>life&&lifetime.current===life&&authGeneration.current===generation&&actionVersion.current===version;
   if(!life)return Promise.resolve();
   if(reading.current){
    const previous=reading.current;
    if(previous.life===life&&previous.generation===generation&&previous.version===version)return previous.promise;
    return previous.promise.catch(()=>{}).then(()=>current()?readData():undefined);
   }
   const request={life,generation,version};
   request.promise=(async()=>{
    // A snapshot can observe success before status does; only a terminal status/cancel closes a known attempt.
    try{const next=await call();if(current()){setData(previous=>({...next,authorizationPending:!!(next.authorizationPending||previous?.authorizationPending)}));setRefreshError('')}return next}
    catch(e){if(current())setRefreshError(e.message);throw e}
    finally{if(reading.current===request)reading.current=null}
   })();
   reading.current=request;return request.promise;
  };
  // Automatic reads have their own error display and do not lock buttons or erase action messages.
  React.useEffect(()=>{
   const life={};lifetime.current=life;
   const refresh=()=>{if(lifetime.current!==life||document.visibilityState==='hidden'||action.current)return;readData().catch(()=>{})};
   refresh();const timer=setInterval(refresh,60000);document.addEventListener('visibilitychange',refresh);
   return()=>{if(lifetime.current===life)lifetime.current=null;clearInterval(timer);document.removeEventListener('visibilitychange',refresh)};
  },[]);
  const run=async(op,kind='action')=>{
   if(!lifetime.current||(action.current&&(kind!=='cancel'||action.current.kind==='cancel')))return;
   const token={life:lifetime.current,kind};action.current=token;actionVersion.current++;setBusy(true);setMessage('');
   const current=()=>lifetime.current===token.life&&action.current===token;
   try{return await op(current)}catch(e){if(current())setMessage('操作失败：'+e.message)}
   finally{if(action.current===token){action.current=null;if(lifetime.current===token.life)setBusy(false)}}
  };
  const refresh=()=>run(()=>readData());
  const startAuthorization=()=>run(async current=>{
   const generation=nextAuthorization();setAuth('');setCallback('');setData(d=>({...d,authorizationPending:true}));
   try{
    const x=await call({action:'start'});if(!current()||authGeneration.current!==generation)return;
    setAuth(x.url);setMessage('正在打开浏览器，完成登录后会自动检测。');
    try{window.open(x.url,'_blank','noopener,noreferrer')}catch{setMessage('未能打开浏览器，请点击下面的备用链接。')}
   }catch(e){if(current()&&authGeneration.current===generation)clearAuthorization();throw e}
  },'start');
  const cancelAuthorization=()=>run(async current=>{
   nextAuthorization(); // Invalidate pending status/GET/callback results before awaiting cancel.
   const x=await call({action:'cancel'});if(!current())return;
   if(x.status!=='cancelled')throw Error('取消授权未确认，请重试。');
   clearAuthorization();setMessage('授权已取消，可以重新添加账号。');
  },'cancel');
  const submitCallback=()=>run(async current=>{
   const generation=authGeneration.current;
   await call({action:'callback',redirectURL:callback});if(!current()||authGeneration.current!==generation)return;
   setCallback('');setMessage('回调已提交，正在自动检查。');
  });
  React.useEffect(()=>{
   if(!data?.authorizationPending)return;
   const life=lifetime.current,generation=authGeneration.current;let stopped=false;
   const poll=async()=>{
    if(stopped||lifetime.current!==life||checking.current||action.current)return;
    const version=actionVersion.current,request={};checking.current=request;
    const current=()=>!stopped&&lifetime.current===life&&authGeneration.current===generation&&actionVersion.current===version;
    try{
     const x=await call({action:'status'});if(!current())return;
     if(x.status==='ok'){
      const completed=clearAuthorization();let refreshed=false;
      try{refreshed=!!(await readData())}catch{}
      if(lifetime.current!==life||authGeneration.current!==completed||actionVersion.current!==version)return;
      setMessage(refreshed?(x.focused===false?'授权成功，账号和模型已刷新；系统未允许自动切回，请返回 DSH。':'授权成功，账号和模型已刷新。'):'授权成功，但状态刷新失败，请手动刷新。');
      try{window.focus()}catch{}
     }else if(x.status==='error'||x.status==='cancelled'){
      clearAuthorization();setMessage(x.status==='cancelled'?'授权已取消，可以重新添加账号。':'授权未完成，请重试。');
     }
    }catch(e){if(current()){clearAuthorization();setMessage('授权检查失败：'+e.message)}}
    finally{if(checking.current===request)checking.current=null}
   };
   const timer=setInterval(poll,2000);return()=>{stopped=true;clearInterval(timer)};
  },[data?.authorizationPending,authVersion]);
  const selectAccount=(account,model)=>run(async current=>{
   let prepared=selection?.available()?await selection.prepare(account.provider,model,account.models??data?.models??[]):null;if(!current())return;
   const next=await call({action:'account-select',accountId:account.id});if(!current())return;
   if(!Array.isArray(next.accounts)||!next.preferences||!next.fast||next.accounts.filter(item=>item.enabled).length!==1||!next.accounts.find(item=>item.id===account.id)?.enabled)throw Error('api-invalid-settings');
   setData(next);
   if(prepared){prepared=await prepared.refresh(next.accounts.find(item=>item.id===account.id).models??[],current);if(!current())return}
   if(prepared?.unsupported){setModelChoice({accountId:account.id,models:prepared.models});setMessage('已启用 '+emailOf(account)+'；请选择该账号支持的模型。');return}
   if(prepared){await prepared.select(current);if(!current())return}
   setModelChoice(null);setMessage('');
  });
  const removeAccount=account=>{
   if(account.owned!==true||!window.confirm('确定移除 '+emailOf(account)+'？此账号的计划、进行中的测试和内存图片将被清除。'))return;
   return run(async current=>{const next=await call({action:'account-remove',accountId:account.id});if(!current())return;if(!Array.isArray(next.accounts)||!next.preferences||!next.fast)throw Error('api-invalid-settings');setData(next);activity.forget(account.id);if(modelChoice?.accountId===account.id)setModelChoice(null);setMessage('账号已移除。')});
  };
  const button=(label,fn,disabled=false,variant='outline')=>h(Button,{type:'button',variant,size:'md',disabled:busy||disabled,onClick:fn},label);
  const status=data?.sync?.status==='ok'?`自动同步正常${data.sync.missing.length?` · ${data.sync.missing.length} 个模型缺少可靠资料`:""}`:data?.sync?.status==='error'?`同步不可用：${data.sync.error}`:'等待首次同步';
  return h('div',{style:ui.page},
   h('header',{className:'cpaGo_pageTop'},h('h2',{className:'cpaGo_title'},'ChatGPT')),
   h('section',{className:'cpaGo_card',style:ui.card},
    !data?h('p',{style:ui.muted},'正在读取连接状态…'):null,
    h('div',{style:ui.buttons},button('刷新状态',refresh),button('添加 ChatGPT 账号',startAuthorization,!data?.management||data?.authorizationPending,'primary')),
    refreshError?h('p',{role:'status',style:ui.muted},'状态刷新失败：'+refreshError+(data?'；当前显示为上次读取的旧数据。':'；尚未读取到状态，请稍后刷新。')):null),
   (auth||data?.authorizationPending)?h('section',{className:'cpaGo_card',style:ui.card},h('strong',null,'正在等待 ChatGPT 授权'),auth?h('a',{href:auth,target:'_blank',rel:'noreferrer noopener'},'重新打开授权页面 ↗'):null,h('p',{style:ui.muted},'完成登录后自动检测并刷新；若未自动返回，可粘贴浏览器中的本机回调地址。'),h('input',{className:'cpaGo_input',type:'text','aria-label':'授权回调地址',value:callback,onChange:e=>setCallback(e.target.value),placeholder:'http://localhost:.../auth/callback?...'}),h('div',{style:ui.buttons},button('提交回调',submitCallback,!callback),h(Button,{type:'button',variant:'outline',size:'md',disabled:busy&&action.current?.kind==='cancel',onClick:cancelAuthorization},'取消授权'))):null,
   h(AccountRows,{data,activity,busy,onSelect:selectAccount,onRemove:removeAccount,modelChoice}),
   h('section',{className:'cpaGo_card',style:ui.card},h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center'}},h('strong',null,'模型配置'),h('span',{style:ui.muted},`${data?.models?.length??0} 个可用`)),h('p',{style:ui.muted,title:'只添加账号目录返回且有可靠资料的新模型，保留现有模型和默认选择。'},status),h('div',{style:ui.buttons},button('立即同步模型',()=>run(async current=>{const x=await call({action:'sync'});if(!current())return;await readData();if(!current())return;setMessage(x.status==='ok'?`同步完成，新增 ${x.added.length} 个；${x.missing.length} 个缺少资料。`:`同步失败：${x.error}`)}),!data),button(modelsOpen?'收起模型':'查看模型',()=>setModelsOpen(!modelsOpen),!data)),
    modelsOpen&&data?h('div',{style:{display:'grid',gap:10}},h('input',{className:'cpaGo_input',value:filter,onChange:e=>setFilter(e.target.value),placeholder:'搜索模型名称或 ID'}),h('div',{className:'cpaGo_modelLayout'},h('nav',{'aria-label':'模型列表',className:'cpaGo_modelList'},...data.models.filter(id=>id.toLowerCase().includes(filter.toLowerCase())).map(id=>h('button',{key:id,type:'button',onClick:()=>setSelected(id),style:{display:'block',width:'100%',textAlign:'left',padding:'9px 11px',background:selected===id?'#8882':'transparent',border:0,color:'inherit'}},id))),h('div',{className:'cpaGo_modelDetails'},selected?h(React.Fragment,null,h('strong',null,selected),h('p',{style:ui.muted},data.sync?.missing?.includes(selected)?'缺少可靠模型资料，暂未自动加入 DSH。':'由 ChatGPT 提供；可在 DSH 会话模型选择器中选择已同步模型。')):h('p',{style:ui.muted},'选择左侧模型查看状态。')))):null),

   message?h('div',{role:'status',style:{padding:12,borderRadius:8,background:'#8882'}},message):null,
   h(Activity,{activity,models:data?.models??[],accounts:data?.accounts??[]}));
 }
 return {inject:['slots','modelDirectories','sessions','uiSession'],apply(ctx){
  const current=()=>ctx.uiSession.adapter.current.getSnapshot().key;
  const remove=ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'cpa-settings',order:24,label:()=> 'CPA',inject:()=>({selection:selectionAccess(ctx,current)})},Page));
  const pill=ctx.slots.inject('conversation.input.right',()=>ctx.slots.register({name:'conversation.input.right',id:'cpa-usage',order:1000,inject:sessionId=>({directory:ctx.modelDirectories.directoryFor(sessionId).store,selection:selectionAccess(ctx,()=>sessionId)})},UsagePill));
  return()=>{remove?.();pill?.()};
 }};
}});
