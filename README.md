# 便签 · Yonote

<p>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg" /></a>
  <img alt="Go 1.25" src="https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white" />
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" />
  <img alt="Capacitor 8" src="https://img.shields.io/badge/Android-Capacitor%208-3DDC84?logo=android&logoColor=white" />
  <a href="https://github.com/Yomihay-qut/yonote/releases"><img alt="Releases" src="https://img.shields.io/github/v/release/Yomihay-qut/yonote" /></a>
</p>

一个**可自托管、离线优先**的跨平台中文备忘与待办应用。Web、PWA 与 Android 共享同一套 React 客户端，服务端采用零 CGO 单二进制 Go + SQLite，并原生内置受控 **AI API 与 Streamable HTTP MCP** 接口。

---

## 核心特性

- **离线优先 & 增量同步**：所有读写先落本地 IndexedDB（Dexie），断网可随时创作；联网后通过基于内容 SHA-256 哈希的状态增量协议自动同步，未改动不上传，附件支持 SHA-256 去重秒传。
- **优雅的富文本编辑体验**：基于 TipTap 3，支持标题、列表、嵌套勾选清单、图片、附件、篇内查找与高亮、自定义行距及多设备流畅交互。
- **语义化深浅主题与纸张系统**：纸张底色、文字颜色、荧光高亮全部采用语义令牌存储，在浅色/深色模式、公开分享页、导出及打印间自动切换至 WCAG AA 高对比度方案。
- **真矢量 PDF 与多格式导出**：Web（隐藏 `iframe`）与 Android（系统原生 `PrintManager`）均直接输出真矢量、可选字、可搜索且自动分页的 PDF；同时支持长图片 PNG 与 Markdown 导出，可选保留纸张底色。
- **历史版本与 Diff 对比**：服务端自动记录编辑快照，支持桌面双栏 / 窄屏堆叠的字词级 Diff 对比与一键回滚。
- **AI / MCP 原生集成**：在设置页创建细粒度权限（`read` / `write` / `todo` + 指定文件夹范围）的 Bearer API 密钥，可直接接入 Cherry Studio、Claude、Codex、RikkaHub 等 MCP 客户端（端点 `/mcp`）。
- **单二进制轻量自托管**：无需外部数据库，一份 `yonote` 二进制 + `web/` 静态目录 + SQLite 即可运行，同时提供 Docker Compose 与 systemd + Nginx 方案。

---

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
git clone https://github.com/Yomihay-qut/yonote.git
cd yonote
# 修改 docker-compose.yml 中的 YONOTE_PASSWORD（至少 12 位）与 YONOTE_ORIGIN
docker compose up -d
```

服务默认监听 `http://127.0.0.1:8787`，可通过 `http://127.0.0.1:8787/api/health` 检查健康状态。生产环境请在前置 Nginx / Caddy 配置 HTTPS 反向代理。

### 方式二：预编译二进制部署（Linux / Windows）

前往 [Releases](https://github.com/Yomihay-qut/yonote/releases) 下载对应架构的发行包（含 `yonote`、`web/` 与 `deploy/` 模板）：

- **Linux（systemd + Nginx）**：参见 [部署与运维文档](docs/DEPLOYMENT.md)
- **Windows 本地试用**：解压 `yonote-windows-amd64-*.zip`，设置首次管理员环境变量后运行：

```powershell
$env:YONOTE_ADMIN = 'admin'
$env:YONOTE_PASSWORD = 'replace-with-a-strong-password'
$env:YONOTE_ORIGIN = 'http://127.0.0.1:8787'
.\yonote.exe -addr 127.0.0.1:8787 -data ./data -web ./web
```

> 首次启动环境变量仅在数据库为空时创建首个管理员账号；之后账号管理、修改密码、创建子账号与配额控制均在应用内「设置 → 用户管理」完成。

### 客户端使用

- **Web / Windows PWA**：使用 Edge / Chrome 打开你的 HTTPS 地址，点击地址栏「安装应用」即可作为桌面应用离线使用。
- **Android APK**：前往 [Releases](https://github.com/Yomihay-qut/yonote/releases) 下载 `yonote-*.apk`（Android 7.0 / API 24+），内置前端资源支持完全离线使用，需要同步时在设置中填入服务端 HTTPS 地址即可。

---

## AI / MCP 接入

在应用内打开 **设置 → 账号与同步 → AI 与自动化密钥**，新建密钥并勾选权限范围与允许访问的文件夹：

- **Streamable HTTP MCP 端点**：`https://<your-domain>/mcp`
- **认证头**：`Authorization: Bearer yn_...`
- **REST Agent API**：`/api/agent/folders`、`/api/agent/notes`、`/api/agent/todos`

---

## 本地开发

环境要求：**Node.js 22+**、**Go 1.25+**（构建 Android 需 JDK 21 + Android SDK 36）。

```bash
# 1. 启动前端开发服务器（默认 http://127.0.0.1:5178，自动代理 /api 到 8788）
cd web
npm ci
npm run dev

# 2. 另开终端启动 Go 后端
cd server
YONOTE_ADMIN=admin YONOTE_PASSWORD=dev-password-1234 YONOTE_ORIGIN=http://127.0.0.1:5178 \
  go run . -addr 127.0.0.1:8788 -data ../data/dev -web ../web/dist
```

运行全量测试与生产构建：

```bash
# 前端单测与构建
cd web && npm test && npm run build

# 后端单测与静态检查
cd server && go test -count=1 ./... && go vet ./...
```

---

## 技术栈与项目结构

| 层级 | 技术选型 |
| --- | --- |
| 前端界面 | React 19、TypeScript、Vite 7、TipTap 3、Dexie 4（IndexedDB）、Motion、Floating UI |
| 移动端 | Capacitor 8（Android）、`@capgo/capacitor-printer`（系统原生 `PrintManager`） |
| 后端服务 | Go 1.25 标准库 HTTP、`modernc.org/sqlite`（纯 Go SQLite + FTS5 全文检索）、Argon2id |

```text
.
├── web/                  # React + TipTap + PWA + Capacitor Android 客户端
├── server/               # Go 单二进制后端（同步、附件、分享、历史、MCP/Agent API）
├── deploy/               # systemd、Nginx 反代与定时备份脚本模板
├── docs/                 # 架构设计与自托管部署文档
├── Dockerfile            # 多阶段轻量镜像构建
└── docker-compose.yml    # 一键自托管编排示例
```

## 文档与社区

- [架构设计](docs/ARCHITECTURE.md)
- [部署与备份指南](docs/DEPLOYMENT.md)
- [更新日志](CHANGELOG.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。
