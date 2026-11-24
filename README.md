# 便签 · Yonote

<p>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg" /></a>
  <img alt="Go 1.25" src="https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white" />
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" />
  <img alt="Tauri 2" src="https://img.shields.io/badge/Windows-Tauri%202-FFC131?logo=tauri&logoColor=black" />
  <img alt="Capacitor 8" src="https://img.shields.io/badge/Android-Capacitor%208-3DDC84?logo=android&logoColor=white" />
  <a href="https://github.com/Yomihay-qut/yonote/releases"><img alt="Releases" src="https://img.shields.io/github/v/release/Yomihay-qut/yonote" /></a>
</p>

一个**可自托管、离线优先**的跨平台中文备忘与待办应用。Android、Windows 桌面端与 Web / PWA 共享同一套 React 客户端；服务端采用零 CGO 单二进制 Go + SQLite（内嵌前端页面），并原生内置受控 **AI API 与 Streamable HTTP MCP** 接口。

---

## 下载客户端（普通用户直接下载即用）

前往 [Releases](https://github.com/Yomihay-qut/yonote/releases/latest) 下载对应客户端，**无需任何服务器也可直接离线使用本机记录**；需要跨设备云同步时，在「设置 → 账号与同步」填入你的服务器地址即可：

| 平台 | 发行包 | 说明 |
| --- | --- | --- |
| **Android 手机 / 平板** | `yonote-android-v*.apk` | 正式签名安装包，Android 7.0+ 直接安装，支持后续版本直接覆盖升级 |
| **Windows 桌面版（安装版）** | `yonote-windows-setup-v*.exe` | 基于 Tauri v2 原生桌面窗口（内置 WebView2），双击直接打开便签 |
| **Windows 桌面版（便携版）** | `yonote-windows-portable-v*.exe` | 单文件绿色免安装版，双击即开 |
| **网页端 / PWA** | 直接浏览器访问服务端域名 | 部署服务端后打开网址即可使用，Edge / Chrome 点击地址栏「安装应用」离线运行 |

---

## 服务端自托管部署（Docker 或 Linux 单文件）

### 方式一：Docker Compose（推荐）

```bash
git clone https://github.com/Yomihay-qut/yonote.git
cd yonote
# 按需修改 docker-compose.yml 中的 YONOTE_PASSWORD（至少 12 位）与 YONOTE_ORIGIN
docker compose up -d
```

### 方式二：Linux 单文件预编译包

前往 [Releases](https://github.com/Yomihay-qut/yonote/releases/latest) 下载 `yonote-server-linux-amd64-v*.tar.gz`（或 `arm64`）。前端界面已直接内嵌进 `yonote` 单文件二进制中：

```bash
sudo tar -xzf yonote-server-linux-amd64-v0.9.1.tar.gz -C /opt/yonote
/opt/yonote/yonote -addr 127.0.0.1:8787 -data /var/lib/yonote
```

> **网页首次初始化**：即使未设置 `YONOTE_ADMIN` / `YONOTE_PASSWORD` 环境变量，服务端也可直接启动；打开网页或客户端进入「设置 → 账号与同步」填入你的服务端地址，即可**直接创建首个管理员账号**。生产部署建议配置 systemd 与 Nginx HTTPS，详见 [部署与运维文档](docs/DEPLOYMENT.md)。

---

## 核心特性

- **离线优先 & 增量同步**：所有读写先落本机 IndexedDB（Dexie），断网可随时创作；联网后通过基于内容 SHA-256 哈希的状态增量协议同步，未改动不上传，附件支持 SHA-256 去重秒传。
- **语义深浅主题与纸张系统**：纸张底色、字色与荧光高亮全部采用语义令牌存储，在浅色/深色模式、公开分享页、导出与打印间自动切换高对比度配色，粘贴外部富文本自动净化杂色。
- **真矢量 PDF 与多格式导出**：Web / Windows 桌面（隐藏 `iframe`）与 Android（系统 `PrintManager`）均直接输出真矢量、可选字、可搜索且自动分页的 PDF；同时支持纯净长图 PNG 与 Markdown 导出。
- **历史版本与 Diff 对比**：服务端自动记录编辑快照，支持桌面双栏 / 窄屏堆叠的字词级 Diff 对比与一键回滚。
- **AI / MCP 原生集成**：在设置页创建细粒度权限（`read` / `write` / `todo` + 指定文件夹范围）的 Bearer API 密钥，可直接接入 Cherry Studio、Claude、Codex、RikkaHub 等 MCP 客户端（端点 `/mcp`）。

---

## 本地开发

环境要求：**Node.js 22+**、**Go 1.25+**（构建 Android 需 JDK 21 + Android SDK 36；构建 Windows 桌面端需 Rust stable + MSVC）。

```bash
# 1. 启动前端开发服务器（默认 http://127.0.0.1:5178，自动代理 /api 到 8788）
cd web
npm ci
npm run dev

# 2. 另开终端启动 Go 后端（本地联调指向 web/dist 或空目录）
cd server
go run . -addr 127.0.0.1:8788 -data ../data/dev
```

运行全量测试与生产构建：

```bash
# 前端单测与构建
cd web && npm test && npm run build

# 后端静态检查与单测
cd server && go vet ./... && go test -count=1 ./...
```

---

## 项目结构

```text
.
├── web/                  # React 19 + TipTap 3 + PWA + Capacitor Android 前端
├── desktop/              # Tauri v2 Windows 桌面端壳工程
├── server/               # Go 1.25 单二进制后端（内嵌前端 + SQLite + MCP/Agent API）
├── deploy/               # systemd、Nginx 反代与定时备份脚本模板
├── docs/                 # 架构设计与自托管部署文档
├── Dockerfile            # 多阶段轻量镜像构建
└── docker-compose.yml    # 一键自托管编排示例
```

## 文档与协议

- [架构设计](docs/ARCHITECTURE.md) · [部署与运维指南](docs/DEPLOYMENT.md) · [更新日志](CHANGELOG.md) · [贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md)
- 基于 [MIT License](LICENSE) 开源
