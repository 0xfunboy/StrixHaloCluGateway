import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
await mkdir(path.join(root,'dist/web'),{recursive:true});await mkdir(path.join(root,'vscode/dist'),{recursive:true});
await Promise.all([
  build({entryPoints:[path.join(root,'src/server.ts')],outfile:path.join(root,'dist/server.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',sourcemap:false}),
  build({entryPoints:[path.join(root,'src/cli.ts')],outfile:path.join(root,'dist/cli.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',sourcemap:false}),
  build({entryPoints:[path.join(root,'src/execution/runner-entry.ts')],outfile:path.join(root,'dist/runner.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',sourcemap:false}),
  build({entryPoints:[path.join(root,'web/app.ts')],outfile:path.join(root,'dist/web/app.js'),bundle:true,platform:'browser',format:'iife',target:'es2022',sourcemap:false}),
  build({entryPoints:[path.join(root,'vscode/src/extension.ts')],outfile:path.join(root,'vscode/dist/extension.cjs'),bundle:true,platform:'node',format:'cjs',target:'node20',external:['vscode'],sourcemap:false})
]);
for(const file of ['index.html','style.css','favicon.svg'])await cp(path.join(root,'web',file),path.join(root,'dist/web',file));
await cp(path.join(root,'dist/web'),path.join(root,'vscode/web'),{recursive:true});
await cp(path.join(root,'LICENSE.md'),path.join(root,'vscode/LICENSE.md'));
const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
await writeFile(path.join(root,'dist/build.json'),JSON.stringify({version:manifest.version,node:process.version,language:'TypeScript',entrypoints:['server.mjs','cli.mjs','runner.mjs']},null,2)+'\n');
process.stdout.write('Build server, CLI, runner SSH, web e VS Code completata.\n');
