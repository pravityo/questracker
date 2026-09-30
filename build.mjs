import { cp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await rm('dist', { recursive: true, force: true });
await mkdir('dist');
await cp('web', 'dist', { recursive: true });
const files = (await readdir('web')).filter(name => /\.(js|css)$/.test(name)).sort();
const contents = await Promise.all(files.map(name => readFile(`web/${name}`, 'utf8')));
const version = createHash('sha256').update(contents.join('\n')).digest('hex').slice(0, 12);
for (const name of files.filter(name => name.endsWith('.js'))) {
  const source = await readFile(`dist/${name}`, 'utf8');
  await writeFile(`dist/${name}`, source.replace(/(['"])(\.\/[^'"?]+\.js)\1/g, (_, quote, url) => `${quote}${url}?v=${version}${quote}`));
}
const html = await readFile('dist/index.html', 'utf8');
await writeFile('dist/index.html', html.replace(/(\.\/(?:app\.js|style\.css))(?=["'])/g, `$1?v=${version}`));
console.log(`Built GitHub Pages assets in dist/ (${version})`);
