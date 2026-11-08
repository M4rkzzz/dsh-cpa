// Public SDK exports prebuilt for CPA; no installed dependency build scripts.
import {registerBunOAuthFlows} from '@earendil-works/pi-ai/bun-oauth';
// This public registration hook embeds the SDK's lazy OAuth flow modules. It
// uses ordinary Node APIs, not Bun globals, and performs no authorization IO.
registerBunOAuthFlows();
export {PiAiAdapter} from '@deepseek-ai/dsh-llm-pi-ai';
export {clampThinkingLevel, createProvider} from '@earendil-works/pi-ai';
export {openaiCodexProvider} from '@earendil-works/pi-ai/providers/openai-codex';
export {stream as streamCodex} from '@earendil-works/pi-ai/api/openai-codex-responses';
export {buildBaseOptions} from '@earendil-works/pi-ai/api/simple-options';
