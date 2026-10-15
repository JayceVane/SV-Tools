# 单 bit packed 范围与数组地址混淆

显式 `$var wire 1 ! bus [3:3] $end` 原先只生成显示名称 `bus[3]`，与真正
unpacked 元素 `bus[3]` 无法区分。存储器归并会将该 bus bit 当作数组地址；一位
`mem[2] [0:0]` 也会被误认成两层数组。width=1 分支还未记录已经见过范围，
因此可能接受重复 packed 范围或范围之后的数组索引。

解析器保留历史 name/path，并在单 bit packed 选择上增加 `referenceName`，表示
附加显示用 bit 索引之前的引用。存储器归并优先用该字段；独立 `hasRange` 状态
约束范围只能出现一次且处于数组索引之后。多位 range 的显示与事件查询继续兼容。

合同覆盖 packed bus 不归并、一位 mem 仍按 word 查看、重复范围拒绝以及原名称保留。
仅有单整数索引且没有 packed 范围的 VCD 仍缺少源码类型事实，不能自动判定其声明类型。
