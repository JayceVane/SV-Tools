/* 本地矢量图标不将工程文本解释为HTML。 */
(function (root) {
    'use strict';
    const paths = {
        chevron: 'M6 3.5 10.5 8 6 12.5',
        folder: 'M1.5 4.5V3h4l1.5 1.5h7.5v8.5h-13Z',
        folderOpen: 'M1.5 6V3h4l1.5 1.5h7.5V6M1.5 6h13l-2 7H3Z',
        fileset: 'M2 5h12v8H2ZM4 2.5h8M3 5V4h10v1',
        file: 'M9.5 1.5h-7v13h11v-9ZM9.5 1.5v4h4M5.5 8l-2 2 2 2m5-4 2 2-2 2',
        constraint: 'M9.5 1.5h-7v13h11v-9ZM9.5 1.5v4h4M5 8h5M7 7v2M5 11h5M9 10v2',
        instance: 'M4 4h8v8H4ZM6 1.5V4m4-2.5V4m-4 8v2.5m4-2.5V12M1.5 6H4m-2.5 4H4m8-4h2.5M12 10h2.5',
        input: 'M13.5 8h-11m4-4-4 4 4 4',
        output: 'M2.5 8h11m-4-4 4 4-4 4',
        inout: 'M2 8h12M5 5 2 8l3 3m6-6 3 3-3 3',
        unknown: 'M8 1.5 14.5 8 8 14.5 1.5 8ZM6.5 5.5a1.5 1.5 0 1 1 2 1.5L8 8.5M8 11h.01',
        plus: 'M8 3v10M3 8h10',
        refresh: 'M13.3 5a5.5 5.5 0 1 0 .2 5M13.5 1.5V5H10',
        close: 'M4 4l8 8m0-8-8 8',
        synthesize: 'm3 12 6-6M6 3l3-1 5 5-2 2-2-2-2 2-3-3ZM2 12l2 2',
        implement: 'M2 2h5v5H2Zm7 7h5v5H9ZM10 2h4v4h-4ZM2 10h4v4H2ZM7 4.5h3M4.5 7v3M6 12h3',
        bitstream: 'M5 1.5h6v13H5ZM2 4h3m-3 4h3m-3 4h3m6-8h3m-3 4h3m-3 4h3M8 4l-1 4h2l-1 4',
        report: 'M9.5 1.5h-7v13h11v-9ZM9.5 1.5v4h4M5 12V9m3 3V7m3 5v-2',
        stop: 'M4 4h8v8H4Z'
    };
    /** @param {Document} document 页面文档。 @param {string} name 本地图标名。 @returns {SVGElement} 继承颜色的16px矢量图标。 */
    function icon(document, name) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('class', 'icon');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        const shape = document.createElementNS('http://www.w3.org/2000/svg', name === 'internal' ? 'circle' : 'path');
        if (name === 'internal') {
            shape.setAttribute('cx', '8'); shape.setAttribute('cy', '8'); shape.setAttribute('r', '3');
            shape.setAttribute('fill', 'currentColor'); shape.setAttribute('stroke', 'none');
        } else {
            shape.setAttribute('d', paths[name] || paths.file);
        }
        svg.append(shape);
        return svg;
    }
    root.SVToolsProjectIcons = { icon };
})(globalThis);
