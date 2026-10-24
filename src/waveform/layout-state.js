/* 布局文件只保存声明身份与显示设置；VCD identifier code 不属于可复用身份。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./model'), require('./signal-display'), require('./row-layout'), require('./column-layout'));
    else root.WaveLayoutState = factory(root.WaveModel, root.WaveSignalDisplay, root.WaveRowLayout, root.WaveColumnLayout);
})(typeof window === 'object' ? window : globalThis, function (M, D, L, C) {
    'use strict';
    const MAX_BYTES = 4 * 1024 * 1024;
    const identity = signal => JSON.stringify([signal.path, signal.range || '', signal.width]);
    const boundedText = value => typeof value === 'string' && value.length <= 4096;
    /** @param {object} state 页面状态。@returns {object} 可移植的 v1 布局，包含隐藏位设置。 */
    function capture(state) {
        const chosen = new Set(state.selected), keys = [...new Set([...state.selected, ...(state.bitKeys || [])])];
        const tracks = keys.map(key => {
            const signal = state.signals.get(key); if (!signal) return null;
            const parent = signal.parentKey ? state.signals.get(signal.parentKey) : signal;
            if (!parent) return null;
            return { signal: { path: parent.path, range: parent.range || '', width: parent.width,
                ...(Number.isInteger(signal.bitOffset) ? { bitOffset: signal.bitOffset } : {}) }, visible: chosen.has(key),
                format: state.formats?.[key], group: state.groups?.[key], highlight: state.highlights?.[key], height: state.heights?.[key] };
        }).filter(Boolean);
        return { kind: 'svtools-wave-layout', version: 1, tracks, collapsedGroups: [...(state.collapsedGroups || [])],
            view: state.view, cursorA: state.cursorA, cursorB: state.cursorB, secondsPerTick: state.secondsPerTick,
            columns: state.columns, fullName: !!state.fullName, snap: state.snap !== false };
    }
    /** @param {unknown} layout @returns {object} 已检查结构与资源预算的布局；非法输入抛错。 */
    function validate(layout) {
        if (!layout || layout.kind !== 'svtools-wave-layout' || layout.version !== 1) throw new Error('不支持的波形布局文件或版本');
        if (!Array.isArray(layout.tracks) || layout.tracks.length > D.MAX_TRACKS * 2
            || layout.tracks.filter(track => track?.visible !== false).length > D.MAX_TRACKS
            || layout.tracks.filter(track => track?.visible === false).length > D.MAX_TRACKS) throw new Error('布局最多包含2000个可见行和2000个隐藏位');
        for (const track of layout.tracks) {
            const s = track?.signal;
            if (!s || !boundedText(s.path) || !boundedText(s.range || '') || !Number.isSafeInteger(s.width) || s.width < 1
                || s.bitOffset !== undefined && (!Number.isSafeInteger(s.bitOffset) || s.bitOffset < 0 || s.bitOffset >= s.width)
                || track.group !== undefined && (!boundedText(track.group) || track.group.length > 80)) throw new Error('波形布局的信号声明或分组无效');
        }
        if (layout.collapsedGroups !== undefined && (!Array.isArray(layout.collapsedGroups) || layout.collapsedGroups.length > D.MAX_TRACKS
            || layout.collapsedGroups.some(group => !boundedText(group) || group.length > 80))) throw new Error('波形布局的收起分组无效');
        if (JSON.stringify(layout).length > MAX_BYTES) throw new Error('波形布局超过4 MiB预算');
        return layout;
    }
    /** @param {object} input @param {Map<string,object>} signals 当前声明；按需添加派生位。@param {object} metadata @returns {object} 可应用状态与缺失信号清单。 */
    function restore(input, signals, metadata) {
        const layout = validate(input), declarations = new Map();
        for (const signal of signals.values()) if (!signal.parentKey) {
            const key = identity(signal); if (!declarations.has(key)) declarations.set(key, []); declarations.get(key).push(signal);
        }
        const state = { selected: [], bitKeys: new Set(), formats: Object.create(null), groups: Object.create(null),
            heights: Object.create(null), highlights: Object.create(null), missing: [], collapsedGroups: layout.collapsedGroups || [],
            columns: C.restoreColumns(layout.columns), fullName: !!layout.fullName, snap: layout.snap !== false };
        const seen = new Set();
        for (const track of layout.tracks) {
            const ref = track.signal, candidates = declarations.get(identity(ref));
            if (candidates?.length !== 1) { state.missing.push(ref.path + (ref.range || '') + (ref.bitOffset === undefined ? '' : ' bit@' + ref.bitOffset)); continue; }
            let signal = candidates[0];
            if (ref.bitOffset !== undefined) {
                const key = JSON.stringify(['$bit', M.signalKey(signal), ref.bitOffset]);
                D.restoreBits([key], signals, D.MAX_TRACKS); signal = signals.get(key);
                if (!signal || state.bitKeys.size >= D.MAX_TRACKS) { state.missing.push(ref.path + ' bit@' + ref.bitOffset); continue; }
                state.bitKeys.add(key);
            }
            const key = M.signalKey(signal); if (seen.has(key)) continue; seen.add(key);
            if (track.visible !== false) state.selected.push(key);
            if (M.supportsFormat(signal, track.format)) state.formats[key] = track.format;
            if (track.group) state.groups[key] = track.group;
            if (D.highlightColor(track.highlight)) state.highlights[key] = track.highlight;
            if (Number.isFinite(track.height)) state.heights[key] = L.analogHeight(track.height);
        }
        const factor = layout.secondsPerTick > 0 && metadata.secondsPerTick > 0 ? layout.secondsPerTick / metadata.secondsPerTick : 1;
        const time = value => Number.isFinite(value) ? Math.max(0, Math.min(metadata.endTime, Math.round(value * factor))) : 0;
        state.view = M.clampView(time(layout.view?.start), Number.isFinite(layout.view?.span) ? layout.view.span * factor : metadata.endTime, metadata.endTime);
        state.cursorA = time(layout.cursorA); state.cursorB = layout.cursorB === null || !Number.isFinite(layout.cursorB) ? null : time(layout.cursorB);
        return state;
    }
    return { MAX_BYTES, capture, validate, restore };
});
