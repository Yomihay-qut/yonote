# 贡献指南

感谢你对 **Yonote（便签）** 的关注！欢迎通过 Issue 或 Pull Request 参与改进。

## 开发环境

- **Node.js**：22+
- **Go**：1.25+
- **Android（可选）**：JDK 21 + Android SDK 36

## 提交 Pull Request 前的检查

1. **前端测试与构建**
   ```bash
   cd web
   npm ci
   npm test
   npm run build
   ```
2. **后端测试与检查**
   ```bash
   cd server
   go test -count=1 ./...
   go vet ./...
   ```
3. **代码风格**
   - 遵循仓库根目录下 `.editorconfig` 与 `.prettierrc.json` 规范，使用 UTF-8 编码。
   - 请保持改动聚焦，一个 PR 尽量解决一个明确的问题或新增一项独立特性。
   - 涉及核心同步协议、数据结构变更或外部依赖引入时，建议先开 Issue 讨论思路。

## 提交信息约定

推荐使用简洁的 Conventional Commits 前缀：

- `feat:` 新功能
- `fix:` 缺陷修复
- `refactor:` 重构
- `docs:` 文档更新
- `chore:` 构建、依赖或工程配置调整
