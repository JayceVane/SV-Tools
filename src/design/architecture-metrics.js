'use strict';

/* ---------- 版式常量（px） ----------
   卡片：标题带 34（每多一行 +17）、副标题 24、引脚行距 18、共享网络脚注 20；
   端口排：标题带 28、行距 18；连线标签高 16；拐角半径 4。 */
const HEAD = 34;
const HEAD_LINE = 17;
const SUB = 24;
const PIN_PITCH = 18;
const BODY_PAD = 2;
const FOOT = 20;
const PAD_ROW = 18;
// 图2 边界端口符号：沿用 BD terminalSymbol 的尺寸（宽 20、高 12）。
const PAD_SYM = 20;
const PAD_SYM_H = 12;
const CORNER = 4;
const LABEL_H = 16;
const ARROW = 6;
const TITLE_MAX = 316;
const NOTE_MAX = 316;
const TITLE_NAMES = 3;
const ENTRY_ROW = 22;
// 分组卡片的对外端口行高：一行一个端口，名称 + 端点符号。
const GROUP_PORT_ROW = 22;
// 卡底时钟/复位脚注：两行、行高 14px，标签列宽 28px。
const CLOCK_ROW = 14;
const CLOCK_LABEL = 28;
const OVERVIEW_MAX_WIDTH = 1400;

const FONT = {
    title: 12.5, subtitle: 10.5, chip: 9.5, pin: 10.5, foot: 10, label: 10,
    padName: 10.5, padMeta: 9.5, entryName: 11, entryType: 10, junction: 10.5, clock: 10,
};
const MONO = 0.6;
const UI = 0.55;

const PAD_TITLES = { input: '输入端口', output: '输出端口', inout: '双向端口', interface: '接口束', other: '待确认端口' };
const CLOCK_BAND_TITLE = '时钟 / 复位 · 同名标签连接（CLK / RST）';

const isWide = character => character.codePointAt(0) > 255;
const textWidth = (value, size, ratio = MONO) => [...String(value ?? '')]
    .reduce((width, character) => width + (isWide(character) ? size : size * ratio), 0);
const round = value => Math.round(value * 10) / 10;

/** 按显示宽度裁剪并加省略号。 @param {unknown} value @param {number} maxWidth @param {number} size @param {number} ratio @returns {string} */
function clipText(value, maxWidth, size, ratio = MONO) {
    const text = String(value ?? '');
    if (textWidth(text, size, ratio) <= maxWidth) return text;
    const limit = maxWidth - textWidth('…', size, ratio);
    let clipped = '';
    for (const character of text) {
        if (textWidth(clipped + character, size, ratio) > limit) break;
        clipped += character;
    }
    return clipped + '…';
}

/** 标题按词换行，超长以省略号结束。 @param {unknown} value @param {number} maxWidth @param {number} maxLines @returns {string[]} */
function wrapTitle(value, maxWidth, maxLines = 2) {
    const units = [];
    let word = '';
    for (const character of String(value ?? '')) {
        if (isWide(character) || /\s/u.test(character)) {
            if (word) { units.push(word); word = ''; }
            units.push(character);
        } else word += character;
    }
    if (word) units.push(word);
    const lines = [''];
    let index = 0;
    while (index < units.length) {
        const unit = units[index], current = lines[lines.length - 1];
        if (!current.trim() && textWidth(unit, FONT.title, UI) > maxWidth) {
            lines[lines.length - 1] = clipText(unit, maxWidth, FONT.title, UI);
            index++;
            continue;
        }
        if (current.trim() && textWidth(current + unit, FONT.title, UI) > maxWidth) {
            if (lines.length >= maxLines) break;
            lines.push('');
            continue;
        }
        lines[lines.length - 1] = current + unit;
        index++;
    }
    if (index < units.length && lines.length) {
        const last = lines.length - 1;
        lines[last] = clipText(lines[last].trim() + '…', maxWidth, FONT.title, UI);
    }
    const visible = lines.map(line => line.trim()).filter(Boolean);
    return visible.length ? visible : ['（未命名）'];
}

module.exports = { HEAD, HEAD_LINE, SUB, PIN_PITCH, BODY_PAD, FOOT, PAD_ROW, PAD_SYM, PAD_SYM_H, CORNER, LABEL_H, ARROW, TITLE_MAX, NOTE_MAX, TITLE_NAMES, ENTRY_ROW, GROUP_PORT_ROW, CLOCK_ROW, CLOCK_LABEL, OVERVIEW_MAX_WIDTH, FONT, MONO, UI, PAD_TITLES, CLOCK_BAND_TITLE, isWide, textWidth, round, clipText, wrapTitle };
