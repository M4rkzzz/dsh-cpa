// Run via pnpm run test:install, or set CPA_PNPM_CLI to the pinned pnpm CLI.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,cp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const repo=fileURLToPath(new URL('../',import.meta.url));
const cli=process.env.CPA_PNPM_CLI??process.env.npm_execpath;
assert.ok(cli&&/^pnpm\.(?:cjs|mjs|js)$/.test(basename(cli)),'Run with pnpm, not npm; the test must exercise pnpm strictDepBuilds.');
const dir=await mkdtemp(join(tmpdir(),'cpa-strict-install-'));
const pack=process.argv[2]??join(repo,'dsh-cpa-'+JSON.parse(await readFile(join(repo,'package.json'),'utf8')).version+'.tgz');
function run(args,cwd=dir){const result=spawnSync(process.execPath,args,{cwd,encoding:'utf8',timeout:120000,env:{...process.env,CI:'true'},maxBuffer:8*1024*1024});if(result.status!==0){const lines=result.stdout.split('\n'),detail=[];for(let i=0;i<lines.length;i++)if(/^not ok|ERR_PNPM_/.test(lines[i]))detail.push(...lines.slice(Math.max(0,i-2),i+23));throw Error(JSON.stringify({args,status:result.status,error:result.error?.message,failures:detail,tail:lines.slice(-12),stderr:result.stderr}));}return result.stdout;}
try{
 await writeFile(join(dir,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{'dsh-cpa':'file:'+pack.replaceAll('\\','/')}}));
 await writeFile(join(dir,'pnpm-workspace.yaml'),'packages: []\nallowBuilds: {}\nstrictDepBuilds: true\nignoreScripts: false\nautoInstallPeers: true\n');
 await writeFile(join(dir,'.npmrc'),'registry=https://registry.npmjs.org/\nupdate-notifier=false\n');
 assert.equal(run([cli,'--version']).trim(),'11.28.5');
 const output=run([cli,'install','--store-dir',join(dir,'store'),'--reporter=append-only']);
 assert.doesNotMatch(output,/IGNORED_BUILDS|preinstall|postinstall/);
 const installed=join(dir,'node_modules','dsh-cpa');
 const locked=await readFile(join(dir,'pnpm-lock.yaml'),'utf8');
 assert.doesNotMatch(locked,/@google\/genai|protobufjs|@earendil-works\/pi-ai|dsh-llm-pi-ai/);
 await mkdir(join(installed,'tests'),{recursive:true});
 await cp(join(repo,'tests'),join(installed,'tests'),{recursive:true});
 // Host AuthorizationService is a development test fixture, not a consumer dependency.
 const summary=run(['--test','--experimental-test-isolation=none','tests/index.test.mjs','tests/transport.test.mjs','tests/png.test.mjs','tests/sdk-bundle.test.mjs','tests/upgrade.test.mjs'],installed).split('\n').filter(line=>/tests |pass |fail |skipped |duration_ms /.test(line)).slice(-5);
 console.log(JSON.stringify({node:process.version,pnpm:'11.28.5',strictDepBuilds:true,allowBuilds:{},ignoreScripts:false,installedVersion:JSON.parse(await readFile(join(installed,'package.json'),'utf8')).version,installedIntegrationSuite:summary}));
}finally{assert.equal(dirname(dir),tmpdir());assert.ok(basename(dir).startsWith('cpa-strict-install-'));await rm(dir,{recursive:true,force:true,maxRetries:3});}
