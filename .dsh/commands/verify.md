---
description: 跑本插件的全部单元测试与端到端验收
argument-hint: ''
---

请运行 dsh-imitate-claude 插件的完整验证流程：

1. 逐个运行 packages/*/test/ 下的全部测试文件（node <文件>），汇总 pass/fail；
2. 运行 node test/acceptance.mjs 端到端验收；
3. 如有失败，先诊断再修复，不要凭猜测改代码；
4. 最后给出一份简短的通过情况汇总。
