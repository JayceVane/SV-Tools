'use strict';

const CHUNK = 65536;

/** 逐位dump的总线只保存联合时间索引，数值仍读取原标量存储，不复制完整事件向量。 */
class CompositeEvents {
    constructor(members, budget) {
        this.members = members; this.width = members.length; this.type = 'wire'; this.chunks = []; this.length = 0;
        this.chunkSize = Math.min(CHUNK, Math.max(1, members.reduce((sum, member) => sum + member.length, 0)));
        const heap = [];
        const before = (a, b) => a.time < b.time;
        const push = entry => {
            let at = heap.length; heap.push(entry);
            while (at) { const parent = (at - 1) >>> 1; if (!before(entry, heap[parent])) break; heap[at] = heap[parent]; at = parent; }
            heap[at] = entry;
        };
        const pop = () => {
            const first = heap[0], last = heap.pop();
            if (heap.length) {
                let at = 0;
                while (at * 2 + 1 < heap.length) {
                    let child = at * 2 + 1; if (child + 1 < heap.length && before(heap[child + 1], heap[child])) child++;
                    if (!before(heap[child], last)) break; heap[at] = heap[child]; at = child;
                }
                heap[at] = last;
            }
            return first;
        };
        for (const member of members) if (member.length) push({ member, index: 0, time: member.timeAt(0) });
        let previous;
        while (heap.length) {
            const entry = pop();
            if (entry.time !== previous) {
                if (this.length % this.chunkSize === 0) { budget.reserve(this.chunkSize * 8); this.chunks.push(new Float64Array(this.chunkSize)); }
                this.chunks[Math.floor(this.length / this.chunkSize)][this.length++ % this.chunkSize] = entry.time;
                previous = entry.time;
            }
            if (++entry.index < entry.member.length) { entry.time = entry.member.timeAt(entry.index); push(entry); }
        }
    }
    timeAt(index) { return this.chunks[Math.floor(index / this.chunkSize)][index % this.chunkSize]; }
    upperBound(time) {
        let low = 0, high = this.length;
        while (low < high) { const mid = (low + high) >>> 1; if (this.timeAt(mid) <= time) low = mid + 1; else high = mid; }
        return low;
    }
    valueLengthAt() { return this.width; }
    bitAt(index, offset) {
        const member = this.members[this.width - 1 - offset], at = member.upperBound(this.timeAt(index)) - 1;
        return at < 0 ? 'x' : member.bitAt(at, 0);
    }
    event(index) {
        return { t: this.timeAt(index), value: this.members.map((_, at) => this.bitAt(index, this.width - 1 - at)).join('') };
    }
}
module.exports = { CompositeEvents };
