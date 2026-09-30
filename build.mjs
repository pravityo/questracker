import { cp, mkdir, rm } from 'node:fs/promises';
await rm('dist',{recursive:true,force:true}); await mkdir('dist'); await cp('web','dist',{recursive:true});
console.log('Built GitHub Pages assets in dist/');
