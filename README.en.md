# Yonote

[简体中文](README.md) | English | [日本語](README.ja.md) | [한국어](README.ko.md)

<p>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg" /></a>
  <img alt="Go 1.25" src="https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white" />
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" />
  <img alt="Tauri 2" src="https://img.shields.io/badge/Windows-Tauri%202-FFC131?logo=tauri&logoColor=black" />
  <img alt="Capacitor 8" src="https://img.shields.io/badge/Android-Capacitor%208-3DDC84?logo=android&logoColor=white" />
  <a href="https://github.com/Yomihay-qut/yonote/releases"><img alt="Releases" src="https://img.shields.io/github/v/release/Yomihay-qut/yonote" /></a>
</p>

A **self-hosted, offline-first**, cross-platform notes & tasks app (automatically following your system language across Simplified Chinese / English / Japanese / Korean). Android, Windows Desktop, and Web / PWA share the same React client, backed by a zero-CGO single-binary Go + SQLite server (with embedded Web UI) and built-in scoped **AI REST API & Streamable HTTP MCP** support.

---

## Download Clients (Ready to Use)

Download the client for your platform from [Releases](https://github.com/Yomihay-qut/yonote/releases/latest). **Works 100% offline out of the box with no server required**; when you want multi-device sync, simply enter your server URL under **Settings → Account & Sync**:

| Platform | Package | Notes |
| --- | --- | --- |
| **Android Phone / Tablet** | `yonote-android-v*.apk` | Signed release APK for Android 7.0+ (supports seamless in-place updates) |
| **Windows Desktop (Installer)** | `yonote-windows-setup-v*.exe` | Tauri v2 native desktop window (WebView2), multi-language installer |
| **Windows Desktop (Portable)** | `yonote-windows-portable-v*.exe` | Single-file portable executable, double-click to launch |
| **Web / PWA** | Visit your server URL in any browser | Hosted directly from the Go binary; click "Install app" in Chrome/Edge for offline PWA mode |

---

## Self-Hosting the Server (Docker or Single Linux Binary)

### Option 1: Docker Compose (Recommended)

```bash
git clone https://github.com/Yomihay-qut/yonote.git
cd yonote
# Edit YONOTE_PASSWORD (min 12 chars) and YONOTE_ORIGIN in docker-compose.yml as needed
docker compose up -d
```

### Option 2: Prebuilt Linux Binary

Download `yonote-server-linux-amd64-v*.tar.gz` (or `arm64`) from [Releases](https://github.com/Yomihay-qut/yonote/releases/latest). The Web UI is embedded directly inside the single `yonote` executable:

```bash
sudo tar -xzf yonote-server-linux-amd64-v1.0.0.tar.gz -C /opt/yonote
/opt/yonote/yonote -addr 127.0.0.1:8787 -data /var/lib/yonote
```

> **First-Run Web Setup**: You can start the server without presetting `YONOTE_ADMIN` / `YONOTE_PASSWORD`. Open the Web UI or desktop/mobile client, go to **Settings → Account & Sync**, enter your server URL, and **create the first admin account directly in the app**. For production systemd + Nginx HTTPS templates, see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## Key Features

- **Multi-Language & System Auto-Detection**: Built-in Simplified Chinese, English, Japanese, and Korean; follows system/browser language by default and can be switched anytime under **Settings → Appearance**.
- **Offline-First & Content-Hash Sync**: All writes go to local IndexedDB (Dexie) first so you can write without a connection. Sync uses SHA-256 content-hash delta detection and SHA-256 deduplicated attachment uploads.
- **Semantic Light/Dark Theme & Paper Palette**: Paper tints, text ink colors, and highlights are stored as semantic tokens that adapt automatically across light/dark modes, public share links, exports, and printing, while sanitizing pasted external inline colors.
- **Vector PDF & Multi-Format Export**: True searchable, selectable, paginated vector PDF output on Web/Windows (hidden `iframe` print pipeline) and Android (native `PrintManager`), plus clean long-image PNG and Markdown export.
- **Version History & Word-Level Diff**: Automatic server-side snapshots with side-by-side desktop / stacked mobile word-level diffs and one-click restore.
- **Native AI / MCP Integration**: Generate fine-grained scoped Bearer API keys (`read` / `write` / `todo` + optional folder allowlist) in Settings to connect Cherry Studio, Claude, Codex, RikkaHub, and other MCP clients (`/mcp`).

---

## Local Development

Requirements: **Node.js 22+**, **Go 1.25+** (Android requires JDK 21 + Android SDK 36; Windows desktop requires Rust stable + MSVC).

```bash
# 1. Start frontend dev server (http://127.0.0.1:5178, proxies /api to 8788)
cd web
npm ci
npm run dev

# 2. In another terminal, start Go backend
cd server
go run . -addr 127.0.0.1:8788 -data ../data/dev
```

Run tests and production builds:

```bash
# Frontend tests & build
cd web && npm test && npm run build

# Backend vet & tests
cd server && go vet ./... && go test -count=1 ./...
```

---

## Project Structure

```text
.
├── web/                  # React 19 + TipTap 3 + PWA + Capacitor Android client
├── desktop/              # Tauri v2 Windows desktop wrapper
├── server/               # Go 1.25 single-binary backend (embedded UI + SQLite + MCP/Agent API)
├── deploy/               # systemd, Nginx reverse proxy, and scheduled backup templates
├── docs/                 # Architecture and self-hosting deployment guides
├── Dockerfile            # Multi-stage container build
└── docker-compose.yml    # Ready-to-run self-hosted compose setup
```

## Documentation & License

- [Architecture](docs/ARCHITECTURE.md) · [Deployment Guide](docs/DEPLOYMENT.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security Policy](SECURITY.md)
- Released under the [MIT License](LICENSE)
