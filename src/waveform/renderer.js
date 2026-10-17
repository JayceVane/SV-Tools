/* Canvas 只拥有绘制；事件查询、布局持久化和交互由 client 管理。 */
(function () {
    'use strict';
    window.createWaveRenderer = function ({ canvas, ruler, tracks, state, model }) {
        const L = window.WaveRowLayout, C = window.WaveColumnLayout, D = model.signalDisplay;
        let projections = new Map();
        let palette;
        function colors() {
            const style = getComputedStyle(document.body);
            palette = Object.fromEntries(['bg', 'panel', 'border', 'fg', 'dim', 'grid', 'accent', 'bus', 'x', 'z', 'a', 'b', 'selection', 'labelText', 'labelHalo']
                .map(key => [key, style.getPropertyValue('--' + key).trim()]));
            palette.labelText ||= palette.fg;
            palette.labelHalo ||= palette.bg;
        }
        colors();
        function geometry() {
            return { ...C.waveGeometry(tracks.clientWidth, state.columns?.names, state.fullName), height: Math.max(1, tracks.clientHeight) };
        }
        const x = time => { const g = geometry(); return g.names + (time - state.view.start) / state.view.span * g.plot; };
        function context(element, width, height) {
            const ratio = Math.min(window.devicePixelRatio || 1, 2, 8192 / Math.max(width, height));
            const w = Math.ceil(width * ratio), h = Math.ceil(height * ratio);
            if (element.width !== w || element.height !== h) { element.width = w; element.height = h; }
            element.style.width = width + 'px'; element.style.height = height + 'px';
            const ctx = element.getContext('2d');
            ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
            ctx.font = '11px Consolas, monospace';
            return ctx;
        }
        function line(ctx, x1, y1, x2, y2, color) {
            ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        }
        function text(ctx, value, left, top, maxWidth, color, halo) {
            const raw = String(value);
            if (!raw || maxWidth <= 0) return;
            let label = raw;
            if (ctx.measureText(raw).width > maxWidth) {
                const scientific = raw.match(/^([+-]?\d+(?:\.\d+)?)([eE][+-]?\d+)$/);
                const source = scientific ? scientific[1] : raw;
                const suffix = scientific ? '…' + scientific[2] : '…';
                // 数值缩略仍须保留符号、整数部分及数量级；空间不足时不画。
                let low = scientific ? source.match(/^[+-]?\d+/)[0].length : 0, high = source.length;
                if (ctx.measureText(source.slice(0, low) + suffix).width > maxWidth) return;
                while (low < high) {
                    const middle = Math.ceil((low + high) / 2);
                    if (ctx.measureText(source.slice(0, middle) + suffix).width <= maxWidth) low = middle;
                    else high = middle - 1;
                }
                label = source.slice(0, low).replace(/\.$/, '') + suffix;
            }
            if (halo) {
                ctx.save(); ctx.strokeStyle = halo; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
                ctx.strokeText(label, left, top);
            }
            ctx.fillStyle = color;
            // 省略后使用自然字形；Canvas maxWidth 会横向压缩细小数字。
            ctx.fillText(label, left, top);
            if (halo) ctx.restore();
        }
        function ticks() {
            const g = geometry(), ideal = state.view.span / Math.max(1, g.plot / 110);
            const magnitude = 10 ** Math.floor(Math.log10(ideal));
            const factor = [1, 2, 5, 10].find(value => value * magnitude >= ideal);
            const step = Math.max(1, factor * magnitude);
            const first = Math.ceil(state.view.start / step) * step;
            const out = [];
            for (let time = first; time <= state.view.start + state.view.span && out.length < 100; time += step) out.push(time);
            return out;
        }
        function drawRuler(axis, g, marks) {
            axis.fillStyle = palette.panel; axis.fillRect(0, 0, g.width, 35);
            text(axis, 'Signal', 12, 21, g.names - 100, palette.dim);
            text(axis, 'A / B', g.names - 90, 21, 80, palette.dim);
            axis.save(); axis.beginPath(); axis.rect(g.names, 0, g.plot, 35); axis.clip();
            for (const time of marks) {
                line(axis, x(time), 24, x(time), 35, palette.border);
                text(axis, model.formatTime(time, state.secondsPerTick), x(time) + 4, 16, 100, palette.dim);
            }
            axis.restore();
        }
        function segments(series, callback) {
            const end = state.view.start + state.view.span;
            let start = state.view.start, value = null;
            for (const change of series.changes) {
                if (change.t <= start) { value = change.value; continue; }
                if (change.t > end) break;
                callback(start, change.t, value, true, change.value); start = change.t; value = change.value;
            }
            callback(start, end, value, false);
        }
        function digital(ctx, row, series, top) {
            const scalar = row.signal.width === 1;
            const middle = top + row.height / 2, high = top + 10, low = top + row.height - 10;
            segments(series, (start, end, value, endsAtChange) => {
                const left = x(start), right = x(end);
                const color = value === null ? palette.dim : /x/i.test(value) ? palette.x : /z/i.test(value) ? palette.z : scalar ? palette.accent : palette.bus;
                if (scalar && /^[01]$/.test(value)) {
                    const y = value === '1' ? high : low;
                    line(ctx, left, y, right, y, color); if (endsAtChange) line(ctx, right, high, right, low, color);
                } else if (scalar) {
                    ctx.setLineDash(value === 'z' ? [3, 3] : []); line(ctx, left, middle, right, middle, color); ctx.setLineDash([]);
                    if (right - left > 16) text(ctx, value ?? '?', left + 4, middle - 4, right - left - 8, color);
                } else {
                    const alpha = ctx.globalAlpha;
                    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.globalAlpha = alpha * .08;
                    ctx.fillRect(left, high, right - left, low - high); ctx.globalAlpha = alpha;
                    ctx.beginPath(); ctx.moveTo(left, middle); ctx.lineTo(left + Math.min(4, (right - left) / 2), high);
                    ctx.lineTo(right - Math.min(4, (right - left) / 2), high); ctx.lineTo(right, middle);
                    ctx.lineTo(right - Math.min(4, (right - left) / 2), low); ctx.lineTo(left + Math.min(4, (right - left) / 2), low); ctx.closePath(); ctx.stroke();
                    if (right - left > 35) {
                        const label = model.formatValue(value, row.signal, state.formats[model.signalKey(row.signal)] || 'hex');
                        const labelColor = value === null || /[xz]/i.test(value) ? color : palette.labelText;
                        // 留出转折边沿，只给字符加细轮廓，不覆盖总线淡填充。
                        text(ctx, label, left + 6, middle + 3, right - left - 12, labelColor, palette.labelHalo);
                    }
                }
            });
        }
        function analog(ctx, row, series, top) {
            const numeric = value => {
                if (value === null || (!/real/i.test(row.signal.type) && /[xz]/i.test(value))) return NaN;
                return /real/i.test(row.signal.type) ? Number(value) : Number.isInteger(row.signal.bitOffset) ? Number(value) : Number(model.formatValue(value, row.signal, 'dec'));
            };
            const values = series.changes.map(change => numeric(change.value)).filter(Number.isFinite);
            const min = values.length ? Math.min(...values) : 0, max = values.length ? Math.max(...values) : 1;
            const y = value => top + row.height - 12 - (value - min) / Math.max(1e-12, max - min) * (row.height - 25);
            segments(series, (start, end, raw, endsAtChange, nextRaw) => {
                const value = numeric(raw);
                if (Number.isFinite(value)) {
                    line(ctx, x(start), y(value), x(end), y(value), palette.accent);
                    const next = numeric(nextRaw);
                    if (endsAtChange && Number.isFinite(next)) line(ctx, x(end), y(value), x(end), y(next), palette.accent);
                }
                else line(ctx, x(start), top + row.height / 2, x(end), top + row.height / 2, palette.x);
            });
            text(ctx, `${min} … ${max}`, geometry().names + 5, top + 11, 170, palette.dim);
        }
        function denseOverlay(ctx, row, series, top) {
            for (const bucket of series.dense || []) {
                const left = x(bucket.start), right = Math.max(left + 2, x(bucket.end));
                ctx.fillStyle = palette.bg; ctx.fillRect(left, top + 8, right - left, row.height - 16);
                const alpha = ctx.globalAlpha;
                ctx.fillStyle = palette.bus; ctx.globalAlpha = alpha * .35; ctx.fillRect(left, top + 9, right - left, row.height - 18); ctx.globalAlpha = alpha;
                if (right - left > 24) text(ctx, '密集', left + 3, top + row.height / 2 + 4, right - left - 5, palette.bus);
            }
        }
        function tint(ctx, row, top, left, width) {
            const color = D.highlightColor(state.highlights?.[row.key]);
            if (!color) return;
            ctx.save(); ctx.fillStyle = color; ctx.globalAlpha *= .16; ctx.fillRect(left, top, width, row.height); ctx.restore();
        }
        function signalIcon(ctx, signal, left, top) {
            const info = D.roleInfo(signal);
            ctx.save(); ctx.strokeStyle = info.role === 'unknown' ? palette.dim : palette.accent; ctx.lineWidth = 1.2;
            for (const points of info.paths) {
                ctx.beginPath(); points.forEach(([x, y], index) => index ? ctx.lineTo(left + x, top + y) : ctx.moveTo(left + x, top + y)); ctx.stroke();
            }
            if (info.role === 'unknown') text(ctx, '?', left + 4, top + 10, 8, palette.dim);
            ctx.restore();
        }
        function names(ctx, row, top, g) {
            const signal = row.signal, key = model.signalKey(signal), chosen = state.multi.has(key), group = state.groups[key];
            ctx.fillStyle = chosen ? palette.selection : palette.panel; ctx.fillRect(0, top, g.names, row.height);
            tint(ctx, row, top, 0, g.names);
            const highlight = D.highlightColor(state.highlights?.[key]);
            if (highlight) { ctx.fillStyle = highlight; ctx.fillRect(g.names - 3, top + 2, 3, row.height - 4); }
            if (state.activeKey === key) { ctx.fillStyle = palette.accent; ctx.fillRect(0, top + 2, 3, row.height - 4); }
            const label = state.fullName ? signal.path + (signal.range || '') : signal.name;
            const indent = Number.isInteger(signal.bitOffset) ? 12 : 0;
            signalIcon(ctx, signal, 28 + indent, top + 7);
            text(ctx, label, 48 + indent, top + 18, g.names - 148 - indent, palette.fg);
            if (D.isBus(signal)) {
                const expanded = state.selected?.some(key => state.signals?.get(key)?.parentKey === row.key);
                ctx.save(); ctx.font = '20px Consolas, monospace';
                text(ctx, expanded ? '▾' : '▸', 6, top + 22, 20, palette.dim);
                ctx.restore();
            }
            const type = /real/i.test(signal.type) ? 'real' : signal.range || signal.width + 'b';
            const format = state.formats[key] || (/real/i.test(signal.type) ? 'analog' : 'hex');
            text(ctx, `${group ? group + ' · ' : ''}${type} · ${model.formatLabel?.(format) || format}`, 12, top + 31, g.names - 112, palette.dim);
            const a = state.valuesA[signal.id], b = state.valuesB[signal.id], radix = state.formats[key] || 'hex';
            text(ctx, model.formatValue(a, signal, radix), g.names - 96, top + 17, 87, palette.a);
            text(ctx, state.cursorB === null ? '' : model.formatValue(b, signal, radix), g.names - 96, top + 31, 87, palette.b);
            line(ctx, 0, top + row.height, g.width, top + row.height, palette.border);
            if (L.isAnalog(signal, state.formats[key])) {
                const resizing = state.rowPresentation?.resizeKey === key || state.rowPresentation?.hoverResizeKey === key;
                const color = resizing ? palette.accent : palette.dim, bottom = top + row.height;
                text(ctx, `↕ ${row.height} px`, 12, bottom - 10, 85, color);
                line(ctx, g.names - 28, bottom - 6, g.names - 12, bottom - 6, color);
                line(ctx, g.names - 28, bottom - 3, g.names - 12, bottom - 3, color);
                if (resizing) line(ctx, 0, bottom - 1, g.width, bottom - 1, palette.accent);
            }
            if (state.rowPresentation?.dragKeys?.has(key)) {
                ctx.strokeStyle = palette.accent; ctx.strokeRect(2, top + 2, g.names - 4, row.height - 4);
            }
        }
        function cursors(ctx, axis, g) {
            for (const [label, time, color] of [['A', state.cursorA, palette.a], ['B', state.cursorB, palette.b]]) {
                if (time === null || time < state.view.start || time > state.view.start + state.view.span) continue;
                line(ctx, x(time), 0, x(time), g.height, color); line(axis, x(time), 19, x(time), 35, color);
                axis.fillStyle = color; axis.fillRect(x(time) - 7, 0, 14, 16); text(axis, label, x(time) - 3, 12, 12, palette.bg);
            }
        }
        function visibleRows() {
            return L.visibleRows(state.rowPresentation?.targetRows || state.rows, tracks.scrollTop, tracks.clientHeight, state.rowPresentation?.positions);
        }
        function draw() {
            const g = geometry(), ctx = context(canvas, g.width, g.height), axis = context(ruler, g.width, 35), marks = ticks();
            ctx.fillStyle = palette.bg; ctx.fillRect(0, 0, g.width, g.height); drawRuler(axis, g, marks);
            for (const time of marks) line(ctx, x(time), 0, x(time), g.height, palette.grid);
            const valid = state.seriesKey === state.windowKey, nextProjections = new Map();
            for (const row of visibleRows()) {
                const top = row.y - tracks.scrollTop, source = valid ? state.series.get(row.signal.id) : null;
                let series = source;
                if (source && Number.isInteger(row.signal.bitOffset)) {
                    const cached = projections.get(row.key);
                    series = cached?.source === source ? cached.series : D.projectSeries(source, row.signal);
                    nextProjections.set(row.key, { source, series });
                }
                ctx.save();
                if (state.rowPresentation?.dragKeys?.has(model.signalKey(row.signal))) ctx.globalAlpha = .6;
                tint(ctx, row, top, g.names, g.plot);
                ctx.save(); ctx.beginPath(); ctx.rect(g.names, top, g.plot, row.height); ctx.clip();
                if (series) {
                    const format = state.formats[model.signalKey(row.signal)] || (/real/i.test(row.signal.type) ? 'analog' : 'hex');
                    if (format === 'analog') analog(ctx, row, series, top); else digital(ctx, row, series, top);
                    denseOverlay(ctx, row, series, top);
                } else text(ctx, state.rowPresentation?.resizeKey || state.rowPresentation?.dragKeys ? '松开后加载新增可见信号…' : valid ? '无变更数据' : '加载时间窗口…', g.names + 12, top + 22, g.plot - 20, palette.dim);
                ctx.restore(); names(ctx, row, top, g); ctx.restore();
            }
            projections = nextProjections;
            if (state.rowPresentation?.insertionY !== null && state.rowPresentation?.insertionY !== undefined) {
                const y = state.rowPresentation.insertionY - tracks.scrollTop;
                ctx.lineWidth = 2; line(ctx, 0, y, g.width, y, palette.accent); ctx.lineWidth = 1;
                ctx.fillStyle = palette.accent; ctx.fillRect(0, y - 3, 6, 6);
            }
            cursors(ctx, axis, g); line(ctx, g.names, 0, g.names, g.height, palette.border);
        }
        return { draw, geometry, visibleRows, x, colors,
            rowAt: y => L.rowAt(state.rows, y + tracks.scrollTop) };
    };
})();
