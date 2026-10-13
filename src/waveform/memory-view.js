/* 存储器交互：只查询当前页，快速换页或移动游标时合并任务。 */
(function (root) {
    'use strict';
    const PAGE_ROWS = 8, PAGE_COLUMNS = 8;

    /**
     * @param {{request:Function,addSignals:Function,onChange:Function}} options 页面边界。
     * @returns {{initialize:Function,refresh:Function,toggle:Function,snapshot:Function}} 单面板存储器控制器。
     */
    root.createMemoryInspector = function ({ request, addSignals, onChange }) {
        const $ = id => document.getElementById(id), model = root.WaveModel, memory = root.WaveMemory;
        let groups = [], group = null, page = null, rowStart = 0, columnStart = 0, radix = 'hex';
        let cursorA = 0, cursorB = null, secondsPerTick = null, isOpen = false;
        let queryKey = '', wanted = null, isBusy = false;
        let valuesA = Object.create(null), valuesB = Object.create(null), cells = [];

        function snapshot() { return { open: isOpen, key: group?.key, rowStart, columnStart, radix }; }
        function setOpen(value) {
            isOpen = value && !!group;
            $('memoryPanel').hidden = !isOpen;
            $('memoryToggle').classList.toggle('active', isOpen);
            if (isOpen) rebuildPage();
            else { queryKey = ''; wanted = null; }
            onChange();
        }
        function updateValues() {
            for (const cell of cells) {
                const { signal } = cell;
                const a = valuesA[signal.id], b = valuesB[signal.id];
                const aText = model.formatValue(a, signal, radix), bText = model.formatValue(b, signal, radix);
                cell.a.textContent = 'A ' + aText;
                cell.b.textContent = cursorB === null ? '' : 'B ' + bText;
                cell.button.classList.toggle('changed', cursorB !== null && memory.compareMemoryValues(a, b, signal) === true);
                cell.a.classList.toggle('unknown', /[xz]/i.test(String(a)));
                cell.b.classList.toggle('unknown', cursorB !== null && /[xz]/i.test(String(b)));
                cell.button.title = `${signal.path}${signal.range || ''}\nA ${aText}${cursorB === null ? '' : '\nB ' + bText}\n点击添加至波形`;
            }
        }
        function queueValues() {
            if (!isOpen || !page) return;
            $('memoryTimeA').textContent = 'A ' + model.formatTime(cursorA, secondsPerTick);
            $('memoryTimeB').textContent = cursorB === null ? 'B —' : 'B ' + model.formatTime(cursorB, secondsPerTick);
            const ids = [...new Set(page.cells.filter(cell => cell.signal).map(cell => cell.signal.id))];
            const params = { ids, a: cursorA, b: cursorB }, key = JSON.stringify([group.key, params]);
            if (key === queryKey) { updateValues(); return; }
            queryKey = key; valuesA = Object.create(null); valuesB = Object.create(null);
            wanted = { params, key }; $('memoryReadStatus').textContent = '读取中…'; updateValues(); pumpValues();
        }
        async function pumpValues() {
            if (isBusy || !wanted) return;
            const job = wanted; wanted = null; isBusy = true;
            try {
                const requests = [request('values', { ids: job.params.ids, time: job.params.a })];
                if (job.params.b !== null) requests.push(request('values', { ids: job.params.ids, time: job.params.b }));
                const result = await Promise.all(requests);
                if (job.key === queryKey && isOpen) {
                    valuesA = result[0].values; valuesB = result[1]?.values || Object.create(null);
                    $('memoryReadStatus').textContent = `${job.params.ids.length} 个单元 · 精确读值`; updateValues();
                }
            } catch (error) {
                if (job.key === queryKey && isOpen) $('memoryReadStatus').textContent = '读取失败：' + error.message;
            } finally { isBusy = false; pumpValues(); }
        }
        function appendCell(line, signal) {
            const td = document.createElement('td');
            if (signal) {
                const button = document.createElement('button'), a = document.createElement('span'), b = document.createElement('span');
                button.className = 'memoryWord'; a.className = 'a'; b.className = 'b'; button.append(a, b);
                button.setAttribute('aria-label', '添加波形 ' + signal.path);
                button.onclick = () => addSignals([model.signalKey(signal)]);
                td.appendChild(button); cells.push({ signal, button, a, b });
            } else { td.textContent = '未 dump'; td.className = 'memoryMissing'; }
            line.appendChild(td);
        }
        function drawTable() {
            cells = [];
            const head = $('memoryHead'), body = $('memoryBody'); head.replaceChildren(); body.replaceChildren();
            const tr = document.createElement('tr'), address = document.createElement('th');
            address.textContent = group.dimensions === 1 ? '地址' : '行 / 列'; tr.appendChild(address);
            for (const column of page.columns) { const th = document.createElement('th');
                th.textContent = group.dimensions === 1 ? `WORD · ${group.width} bit` : '[' + column + ']'; tr.appendChild(th); }
            head.appendChild(tr); $('memoryTable').classList.toggle('oneDimension', group.dimensions === 1);
            const pageCells = new Map(page.cells.map(cell => [JSON.stringify([cell.row, cell.column]), cell]));
            for (const row of page.rows) {
                const line = document.createElement('tr'), label = document.createElement('th');
                label.textContent = '[' + row + ']'; label.scope = 'row'; line.appendChild(label);
                for (const column of page.columns) {
                    appendCell(line, pageCells.get(JSON.stringify([row, column]))?.signal);
                }
                body.appendChild(line);
            }
        }
        function rebuildPage() {
            if (!group) return;
            page = memory.memoryPage(group, { rowStart, columnStart, rowCount: PAGE_ROWS, columnCount: PAGE_COLUMNS });
            rowStart = page.rowStart; columnStart = page.columnStart; drawTable();
            $('memoryPrevRow').disabled = rowStart === 0;
            $('memoryNextRow').disabled = rowStart + page.rows.length >= group.rows.length;
            $('memoryPrevColumn').hidden = $('memoryNextColumn').hidden = group.dimensions === 1;
            $('memoryPrevColumn').disabled = columnStart === 0;
            $('memoryNextColumn').disabled = columnStart + page.columns.length >= group.columns.length;
            $('memoryInfo').textContent = `${group.cellCount.toLocaleString()} 个已 dump 单元 · ${group.width} bit · 行 ${rowStart + 1}–${rowStart + page.rows.length}/${group.rows.length}${group.dimensions === 1 ? '' : ' · 列 ' + (columnStart + 1) + '–' + (columnStart + page.columns.length) + '/' + group.columns.length}`;
            queueValues();
        }
        function changePage(rows, columns) {
            rowStart = Math.max(0, rowStart + rows); columnStart = Math.max(0, columnStart + columns);
            rebuildPage(); onChange();
        }
        function jumpAddress() {
            if (!group) return;
            const text = $('memoryAddress').value.trim();
            if (!/^[+-]?\d+(?:\s*,\s*[+-]?\d+)?$/.test(text)) { $('memoryReadStatus').textContent = '输入地址，二维数组可输入 行,列'; return; }
            const indices = text.split(',').map(Number), row = group.rows.indexOf(indices[0]);
            const column = indices.length === 1 ? columnStart : group.columns.indexOf(indices[1]);
            if (indices.some(index => !Number.isSafeInteger(index)) || row < 0 || column < 0 || (group.dimensions === 1 && indices.length !== 1)) {
                $('memoryReadStatus').textContent = '该地址没有索引记录；仅能定位已 dump 的行和列'; return;
            }
            rowStart = row; columnStart = column; rebuildPage(); onChange();
        }
        function initialize(signals, saved) {
            const index = memory.indexMemories(signals); groups = index.groups;
            const select = $('memorySelect'); select.replaceChildren();
            for (const item of groups) { const option = document.createElement('option'); option.value = item.key;
                option.textContent = item.path + (item.dimensions === 1 ? ' [addr]' : ' [row][col]'); select.appendChild(option); }
            group = groups.find(item => item.key === saved?.key) || groups[0] || null;
            $('memoryToggle').disabled = !group;
            $('memoryToggle').title = group ? `${groups.length} 个索引数组 · 按游标查看` : '没有可识别的索引数组；请在仿真时逐单元 dump';
            if (group) select.value = group.key;
            radix = ['hex', 'bin', 'dec', 'sdec'].includes(saved?.radix) ? saved.radix : 'hex'; $('memoryRadix').value = radix;
            rowStart = Number.isSafeInteger(saved?.rowStart) ? saved.rowStart : 0;
            columnStart = Number.isSafeInteger(saved?.columnStart) ? saved.columnStart : 0;
            if (index.diagnostics.length) $('memoryToggle').title += `；${index.diagnostics.length} 项定义无法归并，保留在普通波形中`;
            setOpen(!!saved?.open);
        }
        function refresh(a, b, seconds) { cursorA = a; cursorB = b; secondsPerTick = seconds; queueValues(); }
        $('memorySelect').onchange = () => { group = groups.find(item => item.key === $('memorySelect').value);
            rowStart = 0; columnStart = 0; rebuildPage(); onChange(); };
        $('memoryRadix').onchange = () => { radix = $('memoryRadix').value; updateValues(); onChange(); };
        $('memoryClose').onclick = () => setOpen(false);
        $('memoryPrevRow').onclick = () => changePage(-PAGE_ROWS, 0); $('memoryNextRow').onclick = () => changePage(PAGE_ROWS, 0);
        $('memoryPrevColumn').onclick = () => changePage(0, -PAGE_COLUMNS); $('memoryNextColumn').onclick = () => changePage(0, PAGE_COLUMNS);
        $('memoryJump').onclick = jumpAddress;
        $('memoryAddress').onkeydown = event => { if (event.key === 'Enter') jumpAddress(); };
        return { initialize, refresh, snapshot, toggle() { setOpen(!isOpen); } };
    };
})(window);
