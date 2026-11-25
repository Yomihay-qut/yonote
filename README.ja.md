# Yonote（メモ）

[简体中文](README.md) | [English](README.en.md) | 日本語 | [한국어](README.ko.md)

<p>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg" /></a>
  <img alt="Go 1.25" src="https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white" />
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" />
  <img alt="Tauri 2" src="https://img.shields.io/badge/Windows-Tauri%202-FFC131?logo=tauri&logoColor=black" />
  <img alt="Capacitor 8" src="https://img.shields.io/badge/Android-Capacitor%208-3DDC84?logo=android&logoColor=white" />
  <a href="https://github.com/Yomihay-qut/yonote/releases"><img alt="Releases" src="https://img.shields.io/github/v/release/Yomihay-qut/yonote" /></a>
</p>

**シンプルで落ち着いた、オフラインファースト・セルフホスト対応**のクロスプラットフォームメモ＆タスクワークスペースです（システム／ブラウザ言語を自動判別し、簡体字中国語・English・日本語・한국어 に対応）。見やすい 3 カラム構成に、リッチテキストメモ（フローティング書式パネル、行間・用紙背景の切り替え、チェックリスト、画像・添付ファイル）と軽快なタスク管理を統合。サーバーなしでもそのままローカルでオフライン利用でき、CGO 不要の単一バイナリ Go + SQLite サーバーに接続すれば、マルチデバイス差分同期、履歴 Diff 比較・復元、閲覧専用共有、権限制御付き **AI API / Streamable HTTP MCP** 連携を **Windows デスクトップ・Android・Web / PWA** で利用できます。

---

## 画面プレビュー

| メモ編集＆フローティングスタイルパネル | タスク管理＆フォルダーワークスペース |
| :---: | :---: |
| ![Yonote メモ編集とスタイルパネル](docs/assets/screenshot-notes.jpg) | ![Yonote タスク管理画面](docs/assets/screenshot-todos.png) |

---

## クライアントのダウンロード（すぐに利用可能）

[Releases](https://github.com/Yomihay-qut/yonote/releases/latest) から各 OS 向けのアプリを入手できます。**サーバーなしでも端末単体で完全オフライン動作**し、複数端末で同期したい場合は「設定 → アカウントと同期」から自分のサーバー URL を入力するだけです：

| プラットフォーム | パッケージ | 説明 |
| --- | --- | --- |
| **Android スマホ / タブレット** | `yonote-android-v*.apk` | 署名済みリリース APK（Android 7.0 以降対応、上書きアップデート可能） |
| **Windows デスクトップ（インストーラー）** | `yonote-windows-setup-v*.exe` | Tauri v2 ネイティブウィンドウ（WebView2）、4 言語インストーラー対応 |
| **Windows デスクトップ（ポータブル版）** | `yonote-windows-portable-v*.exe` | インストール不要の単一実行ファイル |
| **Web / PWA** | サーバーの URL にアクセス | サーバーバイナリから直接配信。Chrome / Edge から PWA としてインストール可能 |

---

## サーバーのセルフホスト（Docker / Linux 単一バイナリ）

### 方法 1：Docker Compose（推奨）

```bash
git clone https://github.com/Yomihay-qut/yonote.git
cd yonote
# docker-compose.yml 内の YONOTE_PASSWORD（12文字以上）と YONOTE_ORIGIN を環境に合わせて変更
docker compose up -d
```

### 方法 2：Linux 単一バイナリ

[Releases](https://github.com/Yomihay-qut/yonote/releases/latest) から `yonote-server-linux-amd64-v*.tar.gz`（または `arm64`）をダウンロードしてください。フロントエンドは `yonote` バイナリに直接組み込まれています：

```bash
sudo tar -xzf yonote-server-linux-amd64-v1.0.0.tar.gz -C /opt/yonote
/opt/yonote/yonote -addr 127.0.0.1:8787 -data /var/lib/yonote
```

> **Web 初回セットアップ**：`YONOTE_ADMIN` / `YONOTE_PASSWORD` 環境変数を事前に設定しなくても起動できます。ブラウザまたはアプリを開き、「設定 → アカウントと同期」にサーバー URL を入力すると、**そのまま最初の管理者アカウントを作成**できます。本番環境向けの systemd / Nginx HTTPS 設定は [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) をご覧ください。

---

## 主な機能

- **多言語対応とシステム自動追従**：簡体字中国語・English・日本語・한국어 を内蔵。初期状態では OS／ブラウザ言語に自動で合わせ、「設定 → 外観」からいつでも切り替えられます。
- **オフラインファースト＆コンテンツハッシュ同期**：すべての読み書きをまずローカル IndexedDB（Dexie）に保存し、ネット接続復帰後に SHA-256 コンテンツハッシュで差分同期。添付ファイルも SHA-256 重複排除で高速アップロードします。
- **セマンティックなテーマ＆用紙カラー**：用紙背景・文字色・蛍光ハイライトをセマンティックトークンとして保持し、ライト／ダークモードや公開共有ページ・PDF 印刷時にも高コントラストを維持。外部リッチテキストの貼り付け時に不要な配色を自動クレンジングします。
- **ベクター PDF 出力＆多彩なエクスポート**：Web・Windows（隠し `iframe` 印刷）および Android（システム `PrintManager`）から文字選択・検索・自動改ページ可能なベクター PDF を直接出力可能。ロング PNG 画像や Markdown 出力にも対応。
- **履歴スナップショット＆単語単位 Diff**：編集履歴を自動保存し、PC では 2 カラム・モバイルでは上下表示で文字レベルの差分比較とワンクリック復元が可能。
- **AI / MCP ネイティブ連携**：設定画面から権限（`read` / `write` / `todo` + フォルダー指定）を絞った Bearer API キーを発行でき、Cherry Studio・Claude・Codex・RikkaHub などの MCP クライアント（`/mcp`）へ直接接続できます。

---

## ローカル開発

動作要件：**Node.js 22+**、**Go 1.25+**（Android ビルドには JDK 21 + Android SDK 36、Windows デスクトップビルドには Rust stable + MSVC が必要）。

```bash
# 1. フロントエンド開発サーバーを起動（http://127.0.0.1:5178、/api を 8788 へプロキシ）
cd web
npm ci
npm run dev

# 2. 別ターミナルで Go バックエンドを起動
cd server
go run . -addr 127.0.0.1:8788 -data ../data/dev
```

テストと本番ビルドの実行：

```bash
# フロントエンドのテストとビルド
cd web && npm test && npm run build

# バックエンドの静的解析とテスト
cd server && go vet ./... && go test -count=1 ./...
```

---

## ディレクトリ構成

```text
.
├── web/                  # React 19 + TipTap 3 + PWA + Capacitor Android クライアント
├── desktop/              # Tauri v2 Windows デスクトップラッパー
├── server/               # Go 1.25 単一バイナリサーバー（Web UI 内蔵 + SQLite + MCP/Agent API）
├── deploy/               # systemd・Nginx リバースプロキシ・自動バックアップ設定テンプレート
├── docs/                 # アーキテクチャおよび運用デプロイドキュメント
├── Dockerfile            # マルチステージ Docker ビルド
└── docker-compose.yml    # セルフホスト用 Compose 設定例
```

## ドキュメントとライセンス

- [アーキテクチャ設計](docs/ARCHITECTURE.md) · [デプロイガイド](docs/DEPLOYMENT.md) · [変更履歴](CHANGELOG.md) · [コントリビュートガイド](CONTRIBUTING.md) · [セキュリティポリシー](SECURITY.md)
- [MIT License](LICENSE) の下で公開されています
