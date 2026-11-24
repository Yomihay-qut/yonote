# Changelog

All notable changes to Yonote will be documented in this file.

## [v1.0.0] - 2026-11-24

首个正式版里程碑，新增完整多语言国际化支持。

### Added
- **全端四语国际化（`zh-CN` / `en` / `ja` / `ko`）**：基于 `i18next` + `react-i18next` 实现简体中文、English、日本語、한국어 完整界面翻译；首次启动自动跟随系统/浏览器语言（未命中时默认简体中文），并可在「设置 → 外观」随时手动切换。
- **全面区域化适配**：随语言实时联动 `<html lang>`、文档标题、中日韩原生系统字体栈、列表/编辑器/历史记录日期格式、导出与打印模板，以及后端常见错误提示的多语自动映射；新增 `i18n.test.ts` 自动化校验四语词条 Key 与插值占位符 100% 一致。
- **Windows 安装向导四语支持**：NSIS 安装程序支持简体中文、English、日本語、한국어；客户端窗口标题同步适配多语环境。
- **多语言仓库文档**：保留 [README.md](README.md) 默认简体中文，新增 [README.en.md](README.en.md)、[README.ja.md](README.ja.md) 与 [README.ko.md](README.ko.md) 并添加顶部语言导航栏。

## [v0.9.1] - 2026-11-24

完善全端普通用户开箱体验与 Release 产物划分。

### Added
- **Windows 桌面客户端（Tauri v2）**：新增 `desktop/` 轻量桌面端壳工程，Release 直接提供安装版 `yonote-windows-setup` 与绿色免安装版 `yonote-windows-portable`，双击即可打开独立窗口离线记笔记或连接自建服务器。
- **正式签名 Android APK**：为本开源仓库独立签发发布签名证书并自动打包 `yonote-android` APK，支持后续版本直接覆盖升级。
- **服务端真单文件 + 网页首次初始化**：Go 服务端通过 `go:embed` 内嵌前端静态资源，不再额外暴露零散 `web/` 文件；首次启动无需预先传环境变量，支持在网页/客户端直接初始化首个管理员账号（`GET/POST /api/setup`）。

### Changed
- **精简清晰的发布资产**：服务端仅保留 Docker 与 Linux（`amd64` / `arm64`）单文件发行包，移除容易误导用户的 Windows 服务端黑框程序与单独的 `web.zip`。

## [v0.9.0] - 2026-11-24

首个公开开源整理版（MIT License）。

### Added
- **社区开源规范与治理**：新增 MIT `LICENSE`、`CONTRIBUTING.md`、`SECURITY.md`、Issue/PR 模板与全新 `README.md` / `docs/ARCHITECTURE.md` / `docs/DEPLOYMENT.md`。
- **Docker 自托管支持**：新增多阶段 `Dockerfile`、`docker-compose.yml` 与 `.dockerignore`。
- **核心能力同步**：离线优先 + 哈希增量同步与附件秒传、语义深浅主题与纸张系统、Web/Android 真矢量 PDF 与导出、GitHub 风格历史 Diff、Scoped AI API Key 与 MCP `/mcp`。
