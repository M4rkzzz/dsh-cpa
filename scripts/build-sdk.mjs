import {build} from 'esbuild';
import {readFile, writeFile, mkdir, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const result=await build({absWorkingDir:root,entryPoints:['scripts/sdk-entry.mjs'],bundle:true,platform:'node',format:'esm',target:'node22.19',
  external:['@deepseek-ai/dsh-llm','@deepseek-ai/cordis','@deepseek-ai/schemastery','@anthropic-ai/sdk'],
  outfile:'lib/vendor/sdk.mjs',write:false,metafile:true,legalComments:'eof',minifySyntax:true,
  banner:{js:'// Generated from pinned public SDKs by scripts/build-sdk.mjs; see vendor/licenses.\nimport {createRequire as __cpaCreateRequire} from "node:module"; const require=__cpaCreateRequire(import.meta.url);'}});
const bundled=new Map();
for(const filename of Object.keys(result.metafile.inputs)){
  const match=filename.replaceAll('\\','/').match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if(match)bundled.set(match[1],JSON.parse(await readFile(join(root,match[1],'package.json'),'utf8')));
}
const licenses=[];
for(const [directory,pkg] of [...bundled].sort(([a],[b])=>a.localeCompare(b))){
  const files=(await readdir(join(root,directory))).filter(name=>/^(?:licen[sc]e|copying|notice)(?:\.|$)/i.test(name)).sort();
  const name=pkg.name.replaceAll('/','__').replaceAll('@','');
  const texts=[];
  if(!files.length){
    if(['@earendil-works/pi-ai','@earendil-works/pi-telemetry'].includes(pkg.name)&&pkg.version==='1.3.0'){
      texts.push('Upstream: https://raw.githubusercontent.com/earendil-works/pi/v1.3.0/LICENSE\n'+await readFile(join(root,'scripts/licenses/pi-1.3.0.txt'),'utf8'));
    }else{
      const readme=await readFile(join(root,directory,'README.md'),'utf8');
      if(!readme.includes('Permission is hereby granted')||!readme.includes('Copyright'))throw Error('Missing license text for '+pkg.name);
      texts.push(readme);
    }
  }
  for(const file of files)texts.push('--- '+file+' ---\n'+await readFile(join(root,directory,file),'utf8'));
  licenses.push({path:'lib/vendor/licenses/'+name+'.txt',text:pkg.name+'@'+pkg.version+'\nLicense: '+JSON.stringify(pkg.license)+'\n\n'+texts.join('\n\n')});
}
const code=result.outputFiles[0].text;
const manifest={format:1,sha256:createHash('sha256').update(code).digest('hex'),packages:[...bundled.values()].map(pkg=>({name:pkg.name,version:pkg.version,license:pkg.license})).sort((a,b)=>a.name.localeCompare(b.name))};
const outputs=[{path:'lib/vendor/sdk.mjs',text:code},{path:'lib/vendor/manifest.json',text:JSON.stringify(manifest,null,2)+'\n'},...licenses];
for(const output of outputs){output.text=output.text.replaceAll('\r\n','\n');const file=join(root,output.path);if(process.argv.includes('--check')){if(await readFile(file,'utf8')!==output.text)throw Error('Stale generated SDK: '+output.path);}else{await mkdir(dirname(file),{recursive:true});await writeFile(file,output.text);}}
console.log(JSON.stringify({sdkBytes:Buffer.byteLength(code),bundledPackages:bundled.size,checked:process.argv.includes('--check'),sha256:manifest.sha256}));
