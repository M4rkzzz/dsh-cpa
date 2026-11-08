import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PiAiAdapter, openaiCodexProvider, streamCodex, buildBaseOptions} from '../lib/vendor/sdk.mjs';

test('prebuilt SDK has an audited byte hash and pinned upstream provenance',async()=>{
 const bytes=await readFile(new URL('../lib/vendor/sdk.mjs',import.meta.url));
 const manifest=JSON.parse(await readFile(new URL('../lib/vendor/manifest.json',import.meta.url),'utf8'));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.sha256);
 for(const [name,version] of [['@deepseek-ai/dsh-llm-pi-ai','0.2.2-rc.1'],['@earendil-works/pi-ai','1.3.0']])assert.equal(manifest.packages.find(pkg=>pkg.name===name)?.version,version);
 assert.equal(typeof PiAiAdapter,'function');assert.equal(typeof streamCodex,'function');assert.equal(typeof buildBaseOptions,'function');
});
test('bundled native OAuth lazy loader is self-contained and does not require runtime pi-ai packages',async()=>{
 const oauth=openaiCodexProvider().auth.oauth;
 assert.equal(oauth.isSubscription,true);
 assert.deepEqual(await oauth.toAuth({type:'oauth',access:'synthetic-no-network-token'}),{apiKey:'synthetic-no-network-token'});
});
test('consumer dependencies do not reinstall the full-provider SDK graph or request install-time builds',async()=>{
 const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
 assert.equal(pkg.dependencies['@earendil-works/pi-ai'],undefined);assert.equal(pkg.dependencies['@deepseek-ai/dsh-llm-pi-ai'],undefined);
 for(const hook of ['preinstall','install','postinstall','prepare','prepublish'])assert.equal(pkg.scripts?.[hook],undefined);
 assert.equal(pkg.devDependencies['@earendil-works/pi-ai'],'1.3.0');assert.equal(pkg.devDependencies['@deepseek-ai/dsh-llm-pi-ai'],'0.2.2-rc.1');
});
