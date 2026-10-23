/* 两种视图共用选项、SVG封装和PNG栅格化；绘图仍归各自renderer。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./svg-canvas'));
    else root.ImageExport = factory(root.SvgCanvas);
})(typeof window === 'object' ? window : globalThis, function (S) {
    'use strict';
    const MAX_SIDE = 16384, MAX_PIXELS = 32 * 1024 * 1024;

    /** @param {object} options @returns {string} 自含SVG，不依赖编辑器CSS。 */
    function svgDocument({ width, height, title, detail = '', body, background = '#fff' }) {
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('导出尺寸无效');
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${S.escape(title)}</title><desc>${S.escape(detail)}</desc><rect width="100%" height="100%" fill="${S.escape(background)}"/>${body}</svg>`;
        if (svg.length > S.MAX_CHARS) throw new Error('矢量图超过24 MiB，请减少导出内容');
        return svg;
    }

    /** @param {string} svg @param {number} width @param {number} height @param {object} window @returns {Promise<string>} 2倍PNG；预算不够时拒绝，不裁剪内容。 */
    async function png(svg, width, height, window) {
        const scale = Math.min(2, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_PIXELS / width / height));
        if (scale < 1) throw new Error('PNG尺寸过大；请选择SVG，或减少信号/电路规模');
        const url = window.URL.createObjectURL(new window.Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
        try {
            const image = new window.Image();
            await new Promise((resolve, reject) => {
                image.onload = resolve;
                image.onerror = () => reject(new Error('SVG栅格化失败'));
                image.src = url;
            });
            const canvas = window.document.createElement('canvas');
            canvas.width = Math.floor(width * scale); canvas.height = Math.floor(height * scale);
            canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
            const result = canvas.toDataURL('image/png');
            if (!result.startsWith('data:image/png;base64,')) throw new Error('浏览器无法创建该尺寸PNG');
            return result.slice(result.indexOf(',') + 1);
        } finally { window.URL.revokeObjectURL(url); }
    }

    /** @param {{svg:string,width:number,height:number}} image @param {object} options @param {object} window @returns {Promise<object>} 宿主文件服务的载荷。 */
    async function payload(image, options, window) {
        return { name: options.name, format: options.format,
            data: options.format === 'svg' ? image.svg : await png(image.svg, image.width, image.height, window) };
    }

    /** @param {object} document @param {object} options @returns {Promise<object|null>} 模态选项；取消不产生图片或文件。 */
    function choose(document, { wave = false, hasAB = false, selectionCount = 0, returnFocus } = {}) {
        return new Promise(resolve => {
            const overlay = document.createElement('div'); overlay.className = 'imageExportOverlay';
            const dialog = document.createElement('section'); dialog.className = 'imageExportDialog';
            dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
            dialog.setAttribute('aria-label', wave ? '导出波形图' : '导出电路图');
            const title = document.createElement('h2'); title.textContent = wave ? '导出波形图' : '导出电路图';
            dialog.appendChild(title);

            function select(id, label, choices) {
                const row = document.createElement('label'); row.textContent = label;
                const input = document.createElement('select'); input.id = id;
                for (const [value, text, disabled] of choices) {
                    const option = document.createElement('option');
                    option.value = value; option.textContent = text; option.disabled = !!disabled;
                    input.appendChild(option);
                }
                row.appendChild(input); dialog.appendChild(row); return input;
            }
            const style = select('imageStyle', '图形风格', [['document', '文档黑白线稿'], ['theme', '当前界面主题']]);
            const format = select('imageFormat', '文件格式', [['svg', 'SVG · 矢量图'], ['png', 'PNG · 高清图片']]);
            const ranges = hasAB ? [['ab', 'A/B 游标之间'], ['view', '当前时间视口']]
                : [['view', '当前时间视口'], ['ab', '请先设置两个不同的 A/B 游标', true]];
            const range = wave ? select('imageRange', '时间区间', ranges) : null;
            const signals = wave ? select('imageSignals', '导出信号', [
                ['all', '全部已添加信号（遵循展开/折叠状态）'], ['selected', `仅所选信号（${selectionCount} 条）`, !selectionCount]
            ]) : null;
            const hint = document.createElement('p');
            hint.textContent = wave ? '按区间重新读取数据并自动调整画幅；密集跳变会明确标示。' : '导出当前模块完整电路，不受缩放或画布裁剪影响。';
            dialog.appendChild(hint);
            const actions = document.createElement('div'); actions.className = 'imageExportActions';
            const cancel = document.createElement('button'); cancel.textContent = '取消';
            const confirm = document.createElement('button'); confirm.id = 'imageConfirm'; confirm.textContent = '导出图片';
            actions.append(cancel, confirm); dialog.appendChild(actions); overlay.appendChild(dialog); document.body.appendChild(overlay);

            const close = value => { overlay.remove(); returnFocus?.focus(); resolve(value); };
            cancel.onclick = () => close(null);
            confirm.onclick = () => {
                const options = { style: style.value, format: format.value };
                if (wave) { options.range = range.value; options.signals = signals.value; }
                close(options);
            };
            overlay.onkeydown = event => {
                if (event.key === 'Escape') close(null);
                else if (event.key === 'Enter') confirm.click();
                else if (event.key === 'Tab') {
                    const controls = [style, format, range, signals, cancel, confirm].filter(Boolean);
                    const index = controls.indexOf(document.activeElement);
                    controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
                } else { event.stopPropagation(); return; }
                event.preventDefault(); event.stopPropagation();
            };
            style.focus();
        });
    }
    return { svgDocument, png, payload, choose };
});
