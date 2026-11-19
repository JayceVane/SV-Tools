'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');

async function main() {
    const root = path.resolve(__dirname, '..');
    const directory = path.join(root, 'bin', 'vendor');
    const shared = { absWorkingDir: root, bundle: true, metafile: true, legalComments: 'inline', logLevel: 'warning' };
    const bundles = await Promise.all([
        esbuild.build({ ...shared, entryPoints: ['src/design/note-rich-client.mjs'], outfile: path.join(directory, 'note-editor.js'),
            minify: true, platform: 'browser', format: 'iife', target: 'chrome120' }),
        esbuild.build({ ...shared, entryPoints: ['markdown-it'], outfile: path.join(directory, 'note-markdown.cjs'),
            minify: true, platform: 'node', format: 'cjs', target: 'node22' })
    ]);
    const packages = new Set();
    for (const bundle of bundles) for (const file of Object.keys(bundle.metafile.inputs)) {
        const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//u.exec(file.replaceAll('\\', '/'));
        if (match) packages.add(match[1]);
    }
    const blocks = [];
    for (const name of [...packages].sort()) {
        const pkg = path.join(root, 'node_modules', name);
        const manifest = JSON.parse(await fs.readFile(path.join(pkg, 'package.json'), 'utf8'));
        const files = (await fs.readdir(pkg)).filter(name => /^(?:licen[cs]e|notice|copying)(?:$|[.-])/i.test(name));
        if (!files.length) throw new Error('Missing bundled license for ' + name);
        const terms = await Promise.all(files.map(name => fs.readFile(path.join(pkg, name), 'utf8')));
        blocks.push(`${name} ${manifest.version}\n${terms.join('\n\n')}`);
    }
    await fs.writeFile(path.join(directory, 'note-LICENSES.txt'), blocks.join('\n\n' + '-'.repeat(72) + '\n\n') + '\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
