'use strict';
// 架构前端视觉预览：把某一页或整本架构文档渲染成 HTML，再用本机 Edge/Chromium 截图。
// 用法：
//   node scripts/preview-architecture.js --workspace <伪SV目录> --top <top> --page <模块名|top> --mode overview|detailed --out shot.png
//   node scripts/preview-architecture.js --workspace <伪SV目录> --top <top> --all --out-dir <目录>
//   node scripts/preview-architecture.js --workspace <伪SV目录> --top <top> --book --out report.png
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveContext } = require('../src/design/architecture-model');
const { buildArchitectureBook } = require('../src/design/architecture-model');
const { layoutDiagram, renderDiagram } = require('../src/design/architecture-diagram');
const { renderModuleSymbol } = require('../src/design/architecture-details');
const { renderArchitectureBook } = require('../src/design/architecture-export');

const CSS = ['architecture.css', 'architecture-diagram.css', 'architecture-symbol.css', 'architecture-book.css'];

/** @param {string[]} argv @returns {Record<string,string|true>} 简单 --key value 解析。 */
function parse(argv) {
    const result = {};
    for (let index = 0; index < argv.length; index++) {
        const token = argv[index];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[index + 1];
        result[key] = next && !next.startsWith('--') ? (index++, next) : true;
    }
    return result;
}

/** @returns {string|undefined} 本机可用的 Chromium 浏览器路径。 */
function findBrowser(explicit) {
    const candidates = [explicit, process.env.SVTOOLS_PDF_BROWSER,
        path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe')].filter(Boolean);
    const fsSync = require('node:fs');
    return candidates.find(candidate => fsSync.existsSync(candidate));
}

/** @param {string} htmlPath @param {string} out @param {number} width @param {number} height @param {string} browser @returns {string} 截图路径。 */
async function screenshot(htmlPath, out, width, height, browser) {
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.rm(out, { force: true });
    const profile = path.join(os.tmpdir(), 'svtools-architecture-preview');
    const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
        '--virtual-time-budget=4000', '--user-data-dir=' + profile,
        '--window-size=' + width + ',' + height, '--screenshot=' + out, 'file:///' + htmlPath.replace(/\\/g, '/')];
    const child = spawnSync(browser, args, { encoding: 'utf8', timeout: 180000 });
    if (!require('node:fs').existsSync(out)) {
        throw new Error('浏览器截图失败：' + (child.stderr || child.stdout || 'unknown'));
    }
    return out;
}

/** @param {string} body @returns {Promise<string>} 带全部样式的一次性 HTML。 */
async function pageHtml(body) {
    const sheets = await Promise.all(CSS.map(name => fs.readFile(path.join(__dirname, '..', 'src', 'design', name), 'utf8').catch(() => '')));
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>' + sheets.join('\n')
        + '\nhtml,body{margin:0;padding:0;background:#fff;}'
        + '\n.diagram-print{border:0;padding:0;max-height:none;overflow:visible;background:#fff;display:block;}'
        + '\n.architecture-book{padding:0;margin:0;max-width:none;}'
        + '\n.preview{padding:16px;}'
        + '</style></head><body>' + body + '</body></html>';
}

/** @returns {Promise<void>} 预览入口。 */
async function main() {
    const options = parse(process.argv.slice(2));
    if (!options.workspace || !options.top) {
        throw new Error('需要 --workspace 与 --top；可选 --page/--mode/--out/--all/--out-dir/--book/--browser');
    }
    const browser = findBrowser(typeof options.browser === 'string' ? options.browser : undefined);
    if (!browser) throw new Error('找不到 Edge/Chromium，请用 --browser 指定路径');
    const workspace = path.resolve(String(options.workspace));
    const snapshot = await resolveContext({ workspace, top: String(options.top) }, { requireVirtualWorkspace: true });
    const { book } = await buildArchitectureBook(snapshot);
    const directory = path.resolve(String(options['out-dir'] || path.join(os.tmpdir(), 'svtools-architecture-preview')));
    if (options.book) {
        const html = await renderArchitectureBook(book, undefined, { print: Boolean(options.print) });
        const file = path.join(directory, 'book.html');
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(file, html, 'utf8');
        const out = path.resolve(String(options.out || path.join(directory, 'book.png')));
        const width = Number(options.width || 1600), height = Number(options.height || 2400);
        console.log(await screenshot(file, out, width, height, browser));
        return;
    }
    const pages = options.all ? book.pages : [book.pages.find(page => page.name === String(options.page)) || book.pages[0]];
    for (const page of pages) {
        const mode = ['overview', 'detailed'].includes(String(options.mode)) ? String(options.mode) : page.auto;
        const diagram = renderDiagram(await layoutDiagram(page, mode), page, false);
        const targets = new Map(page.links.filter(link => link.kind === 'interface')
            .flatMap(link => link.endpoints.filter(endpoint => endpoint.boundary).map(endpoint => [endpoint.port, link.id])));
        const symbol = renderModuleSymbol(page.name, page.ports, { targets });
        const html = await pageHtml('<div class="preview"><div class="diagram-print book-full-size">' + diagram + '</div>'
            + '<h3>模块端口图</h3>' + symbol + '</div>');
        const size = /width="(\d+)" height="(\d+)"/.exec(diagram);
        const file = path.join(directory, 'page-' + page.name + '-' + mode + '.html');
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(file, html, 'utf8');
        const out = options.out && !options.all ? path.resolve(String(options.out)) : path.join(directory, 'page-' + page.name + '-' + mode + '.png');
        console.log(await screenshot(file, out, size ? Number(size[1]) + 40 : 1200, size ? Number(size[2]) + 120 : 1200, browser));
    }
}

main().catch(error => { console.error(error.message || String(error)); process.exit(1); });
