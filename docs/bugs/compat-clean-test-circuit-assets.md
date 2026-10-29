# 干净检出在通用测试前缺少电路资源

4.1正式发布PR的Node22/24 CI均在`project_signal_flow_test.js`的真实Slang/Yosys用例失败：`内置 Yosys 资源缺失 ... bin/vendor/yosys/yosys.wasm`。本地完整测试通过，因为之前打包留下了vendor资源。

`npm test`原顺序是通用Node测试后才运行`test:circuit`，而`build:circuit`只在后者中执行。新增通用工程追踪集成测试已需要真实Yosys，因此干净检出不再满足这一顺序。依赖已安装和原生模块已构建不代表离线运行资源已生成。

现将`build:circuit`移到全部Node合同测试之前，末尾直接运行电路测试执行器；独立`npm run test:circuit`仍包含自己的资源准备。资源只构建一遍，不删除/跳过实际工具测试，也不更改运行代码。

修复前证据为[PR #12](https://github.com/JayceVane/SV-Tools/pull/12)首轮CI日志（本地留档`bin/release41-ci-node22-failed.log`）；修复后以该PR中包含本修复的头提交之干净检出Node22/24 CI为最终验证，具体结果保存在PR检查记录中。正式标签与Release必须等待该检查通过。
