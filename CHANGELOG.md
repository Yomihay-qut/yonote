# Changelog

All notable changes to Yonote will be documented in this file.

## [v0.9.0] - 2026-11-24

首个公开开源整理版（MIT License）。

### Added
- **社区开源规范与治理**：新增 MIT `LICENSE`、`CONTRIBUTING.md`、`SECURITY.md`、Issue/PR 模板与全新 `README.md` / `docs/ARCHITECTURE.md` / `docs/DEPLOYMENT.md`。
- **Docker 自托管支持**：新增多阶段 `Dockerfile`、`docker-compose.yml` 与 `.dockerignore`，支持一条命令启动完整服务。
- **Fork 友好的 CI 流水线**：GitHub Actions 在无 Android 签名密钥时自动回退至 Debug APK 编译校验，并新增 Docker 镜像构建验证。

### Core Capabilities Included
- **离线优先与增量同步**：Dexie / IndexedDB 本地优先存储、基于内容 SHA-256 哈希的状态增量同步与附件去重秒传。
- **语义色彩与纸张系统**：纸张、字色与荧光高亮全语义化，自动适配深浅主题、导出与打印对比度，并净化外部粘贴脏样式。
- **真矢量 PDF 与多格式导出**：Web 隐藏 `iframe` 与 Android 原生 `PrintManager` 真矢量 PDF/打印，支持纯净 PNG 长图与 Markdown 导出。
- **历史版本对比与 AI/MCP**：GitHub 风格双栏/堆叠字词 Diff 对比、公开只读分享、Scoped AI API 密钥与 Streamable HTTP `/mcp` 端点。
