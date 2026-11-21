'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, dumpScript, sessionLines } = require('../src/vivado/ip-gui');

test('解析 SVGUI 调用序列：页面/分组路径、提示与静态说明', () => {
    const stdout = [
        'SVGUI_ROW\tview#1\tview\t\t\t\t\t\t',
        'SVGUI_ROW\tpage#2\tpage\tview#1\tPage%200\t\t\t\t',
        'SVGUI_ROW\tgroup#3\tgroup\tpage#2\tGPIO\t\t\tGPIO%20%E9%80%9A%E9%81%93\t',
        'SVGUI_ROW\tparam#4\tparam\tgroup#3\tC_GPIO_WIDTH\ttextEdit\t%E4%BD%8D%E5%AE%BD\tGPIO%20Width\t',
        'SVGUI_ROW\tstatic#5\tstatic\tgroup#3\tnote\t\t\t\t%5B0x0%2C0x1%5D',
        'SVGUI_ROW\tparam#6\tparam\tpage#2\tC_IS_DUAL\tcheckBox\t\t\t'
    ].join('\n');
    const layout = parse(stdout);
    assert.equal(layout.params.size, 2);
    assert.deepEqual(layout.params.get('C_GPIO_WIDTH'),
        { label: 'GPIO Width', help: '位宽', group: 'Page 0 / GPIO 通道', widget: 'textEdit' });
    assert.deepEqual([...layout.notes], [['Page 0 / GPIO 通道', ['[0x0,0x1]']]]);
});

test('dumpScript 内嵌目标文件，sessionLines 在子解释器里执行并清理', () => {
    const script = dumpScript('C:/xilinx/axi_gpio_v2_0/xgui/axi_gpio_v2_0.tcl');
    assert.match(script, /source -encoding utf-8/u);
    assert.ok(script.includes('set ::sv::file {C:/xilinx/axi_gpio_v2_0/xgui/axi_gpio_v2_0.tcl}'));
    assert.match(script, /proc ::source_subcore_ipfile/u);
    const lines = sessionLines('C:/tmp/dump.tcl');
    assert.equal(lines[0], 'set ::svtools_gui_script {C:/tmp/dump.tcl}');
    assert.ok(lines.some(line => line.includes('interp create ::svtools_gui')));
    assert.ok(lines.some(line => line.includes('interp delete ::svtools_gui')));
});

test('额外参数页（其他参数）保留在原位置并被解析', () => {
    const stdout = [
        'SVGUI_ROW\tpage#1\tpage\t\tTop\t\t\t\t',
        'SVGUI_ROW\tparam#2\tparam\tpage#1\tNUM_SI\tcomboBox\t\t\t'
    ].join('\n');
    const layout = parse(stdout);
    assert.deepEqual(layout.params.get('NUM_SI'), { label: '', help: '', group: 'Top', widget: 'comboBox' });
});
