'use strict';
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { getPublicGalleryAPI } = require('@vscode/vsce/out/util');
const { ExtensionQueryFlags: Flags } = require('azure-devops-node-api/interfaces/GalleryInterfaces');

/** 发布完成后从公开下载入口复核，重复版本也必须与本次发布载荷一致。 */
async function verifyMarketplace(report, { attempts = 60, delayMs = 10000 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const extension = await getPublicGalleryAPI().getExtension('JayceVane.svtools', [Flags.IncludeVersions, Flags.IncludeFiles, Flags.IncludeVersionProperties]);
        const version = extension?.versions?.find(value => value.version === report.version && value.targetPlatform === report.target);
        if (version) {
            const asset = version.files?.find(file => file.assetType === 'Microsoft.VisualStudio.Services.VSIXPackage');
            if (!asset) throw new Error('Marketplace版本缺少VSIX下载入口');
            const url = new URL(asset.source);
            if (url.protocol !== 'https:' || !url.hostname.toLowerCase().endsWith('.vsassets.io')) throw new Error('Marketplace返回了非预期下载主机');
            const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
            if (!response.ok) throw new Error('Marketplace安装包下载失败：HTTP ' + response.status);
            const hash = createHash('sha256'); let bytes = 0;
            for await (const chunk of response.body) {
                bytes += chunk.length;
                if (bytes > 64 * 1024 * 1024) throw new Error('Marketplace安装包超过下载预算');
                hash.update(chunk);
            }
            const sha256 = hash.digest('hex');
            if (sha256 !== report.sha256) throw new Error('Marketplace同版本安装包与本次载荷的SHA256不一致');
            return { version: report.version, target: report.target, sha256, bytes, verified: true };
        }
        if (attempt % 6 === 0) console.log(`等待Marketplace公开版本 ${report.version}（第${attempt + 1}/${attempts}次核验）`);
        if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    throw new Error('Marketplace尚未公开本次版本；请检查市场扫描状态后重试核验');
}

if (require.main === module) {
    fs.readFile(process.argv[2], 'utf8').then(JSON.parse).then(report => verifyMarketplace(report))
        .then(result => console.log(JSON.stringify(result)))
        .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { verifyMarketplace };
