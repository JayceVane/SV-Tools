
'use strict';
const path=require('node:path');
const {writeClipboardPng}=require('./clipboard');
const {assertExportTarget}=require('../workspace/export-target');
const MAX_BYTES=32*1024*1024;
const PNG_SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);
/** @param {{vscode:object,sourcePath?:string,writeClipboard?:Function}} deps @returns {{save:Function,copy:Function}} 图片保存仅使用用户选择的独立文件；复制只写系统剪贴板。 */
function createImageFiles({vscode,sourcePath,writeClipboard=writeClipboardPng}){
    /** @param {{format:string,name:string,data:string}} payload @param {object} [target] @returns {Promise<boolean>} 取消返回false，非法图片或写失败抛错。 */
    async function save(payload,target){
        if(!payload||!['svg','png'].includes(payload.format)||typeof payload.data!=='string')throw new Error('不支持的图片导出格式');
        if(payload.data.length>MAX_BYTES*1.4)throw new Error('导出图片超过32 MiB');
        let bytes;
        if(payload.format==='svg'){
            if(!/^\s*(?:<\?xml[^>]*>\s*)?<svg\b[^>]*xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(payload.data)||!/<\/svg>\s*$/.test(payload.data))throw new Error('无效SVG图片');
            bytes=Buffer.from(payload.data,'utf8');
        }else{
            if(!/^[A-Za-z0-9+/]*={0,2}$/.test(payload.data))throw new Error('无效PNG编码');
            bytes=Buffer.from(payload.data,'base64');if(!bytes.subarray(0,8).equals(PNG_SIGNATURE))throw new Error('无效PNG图片');
        }
        if(bytes.length>MAX_BYTES)throw new Error('导出图片超过32 MiB');
        const name=String(payload.name||'svtools-diagram').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,100)||'svtools-diagram';
        const uri=target||await vscode.window.showSaveDialog({defaultUri:vscode.Uri.file(path.join(sourcePath?path.dirname(sourcePath):vscode.workspace.workspaceFolders?.[0]?.uri.fsPath||process.cwd(),name+'.'+payload.format)),filters:{[payload.format.toUpperCase()+' Image']:[payload.format]}});
        if(!uri)return false;
        if(uri.scheme!=='file'||path.extname(uri.fsPath).toLowerCase()!=='.'+payload.format)throw new Error('导出文件扩展名必须是 .'+payload.format);
        if(sourcePath&&path.resolve(uri.fsPath).toLowerCase()===path.resolve(sourcePath).toLowerCase())throw new Error('导出图片不能覆盖源文件');
        await assertExportTarget(uri.fsPath,sourcePath);
        await vscode.workspace.fs.writeFile(uri,bytes);return true;
    }
    /** @param {{format:string,data:string}} payload @returns {Buffer} 严格校验后的PNG字节。 */
    function decodePng(payload){
        if(!payload||payload.format!=='png'||typeof payload.data!=='string')throw new Error('剪贴板复制需要PNG图片');
        if(payload.data.length>Math.ceil(MAX_BYTES/3)*4)throw new Error('导出图片超过32 MiB');
        if(!/^[A-Za-z0-9+/]*={0,2}$/.test(payload.data))throw new Error('无效PNG编码');
        const bytes=Buffer.from(payload.data,'base64');
        if(!bytes.subarray(0,8).equals(PNG_SIGNATURE))throw new Error('无效PNG图片');
        if(bytes.length>MAX_BYTES)throw new Error('导出图片超过32 MiB');
        return bytes;
    }
    /**
     * 将PNG交给原生层异步解码和提交；电路与波形共用此边界。
     * @param {{format:string,data:string}} payload PNG载荷。
     * @returns {Promise<boolean>} 成功返回true，失败抛出具体原因。
     */
    async function copy(payload){
        const bytes=decodePng(payload);
        if(process.platform!=='win32')throw new Error('当前系统暂不支持复制图片到剪贴板');
        try{
            await writeClipboard(bytes);
            return true;
        }catch(error){throw new Error('写入系统剪贴板失败：'+String(error?.message||error),{cause:error});}
    }
    return {save,copy};
}
module.exports={createImageFiles,MAX_BYTES};
