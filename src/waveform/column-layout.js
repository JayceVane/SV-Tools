/* 请求宽度与当前视口的有效宽度分开；临时收窄不覆盖用户偏好。 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WaveColumnLayout = api;
})(typeof window === 'object' ? window : globalThis, function () {
    'use strict';
    const CATALOG_DEFAULT = 252, CATALOG_NARROW_DEFAULT = 185, NARROW_VIEWPORT = 800;
    const CATALOG_MIN = 175, CATALOG_VIEWPORT_RATIO = .45, RIGHT_MIN = 320;
    const NAMES_DEFAULT = 270, NAMES_FULL_DEFAULT = 340, NAMES_MIN = 160, PLOT_MIN = 160, PLOT_GUTTER = 12;

    function viewportWidth(value) { return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, value) : 1; }
    function requestedWidth(value) {
        return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER ? Math.max(1, Math.round(value)) : undefined;
    }
    function clamp(value, min, max) { return Math.max(min, Math.min(value, max)); }

    /** @param {unknown} saved @returns {{catalog?:number,names?:number}} 仅恢复已知列的合法请求宽度，不按当前视口裁切。 */
    function restoreColumns(saved) {
        const columns = {};
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return columns;
        for (const key of ['catalog', 'names']) {
            if (!Object.hasOwn(saved, key)) continue;
            const width = requestedWidth(saved[key]);
            if (width !== undefined) columns[key] = width;
        }
        return columns;
    }

    /**
     * @param {unknown} requested 用户保存的目录宽度。
     * @param {number} viewport 浏览器视口，约束 45vw 和窄视口默认值。
     * @param {number} available 主区域可用宽度；能容纳时给右侧至少 320px。
     * @returns {{width:number,min:number,max:number,defaultWidth:number}} 当前有效目录几何。
     */
    function catalogGeometry(requested, viewport, available = viewport) {
        const screen = viewportWidth(viewport), space = viewportWidth(available);
        const right = Math.min(RIGHT_MIN, space * .65);
        const max = Math.max(0, Math.floor(Math.min(screen * CATALOG_VIEWPORT_RATIO, space - right)));
        const min = Math.min(CATALOG_MIN, max), defaultWidth = screen <= NARROW_VIEWPORT ? CATALOG_NARROW_DEFAULT : CATALOG_DEFAULT;
        const width = clamp(requestedWidth(requested) ?? defaultWidth, min, max);
        return { width, min, max, defaultWidth };
    }

    /**
     * @param {number} available 波形区域可用宽度。
     * @param {unknown} requested 用户保存的名称/A-B栏宽度。
     * @param {boolean} fullName 全名模式决定未设置宽度时的默认值。
     * @returns {{width:number,names:number,plot:number,gutter:number,min:number,max:number,defaultWidth:number}} Canvas 与分隔线共享几何。
     */
    function waveGeometry(available, requested, fullName = false) {
        const width = Math.max(1, Math.floor(viewportWidth(available))), gutter = Math.min(PLOT_GUTTER, Math.max(0, width - 2));
        const space = width - gutter, plotMin = Math.min(PLOT_MIN, Math.max(1, Math.ceil(space * .6)));
        const max = Math.max(0, space - plotMin), min = Math.min(NAMES_MIN, max);
        const defaultWidth = Math.min(fullName ? NAMES_FULL_DEFAULT : NAMES_DEFAULT, Math.max(80, width * .42));
        const names = clamp(requestedWidth(requested) ?? defaultWidth, min, max);
        return { width, names, plot: width - names - gutter, gutter, min, max, defaultWidth };
    }

    return { CATALOG_DEFAULT, CATALOG_NARROW_DEFAULT, NARROW_VIEWPORT, CATALOG_MIN, RIGHT_MIN,
        NAMES_DEFAULT, NAMES_FULL_DEFAULT, NAMES_MIN, PLOT_MIN, PLOT_GUTTER, restoreColumns, catalogGeometry, waveGeometry };
});
