# 部署与运维指南

Yonote 服务端为单二进制 Go 程序，内嵌纯 Go SQLite 驱动（`CGO_ENABLED=0`）与**全部前端静态页面（`go:embed`）**，提供 **Docker Compose** 与 **Linux 单文件（systemd + Nginx）** 两种部署方式。

> 说明：Windows 不提供服务端发行包，Windows 电脑请使用 Release 中的 Tauri 桌面客户端（`yonote-windows-setup-*.exe` / `yonote-windows-portable-*.exe`）或直接通过浏览器访问已部署的服务器地址。

---

## 环境变量与首次初始化

Yonote 支持两种方式创建首个管理员账号：

1. **网页 / 客户端向导初始化（推荐，零前置配置）**：直接启动服务端后，在浏览器打开地址（或在桌面端/APK「设置 → 账号与同步」输入服务器地址），页面会自动识别尚未初始化，提示设置首个管理员用户名与密码（至少 12 位）。
2. **环境变量静默初始化**：适合自动化脚本或 Docker Compose。

| 变量名 | 说明 |
| --- | --- |
| `YONOTE_ADMIN` | 首次启动创建的管理员用户名 |
| `YONOTE_PASSWORD` | 首次启动创建的管理员密码（**至少 12 个字符**） |
| `YONOTE_ORIGIN` | 对外公开的 HTTPS 站点地址（末尾不带 `/`），用于 CORS 校验，例如 `https://notes.example.com` |

---

## 方式一：Docker Compose 部署（推荐）

1. 克隆仓库并按需编辑 `docker-compose.yml` 中的环境变量：

```bash
git clone https://github.com/Yomihay-qut/yonote.git
cd yonote
docker compose up -d
```

2. 验证健康状态：

```bash
curl http://127.0.0.1:8787/api/health
# 返回 {"status":"ok"}
```

3. 使用 Nginx / Caddy 将你的 HTTPS 域名反向代理至 `http://127.0.0.1:8787`（参考 `deploy/nginx.conf`）。

---

## 方式二：Linux 单文件预编译包（systemd + Nginx）

1. 从 [Releases](https://github.com/Yomihay-qut/yonote/releases/latest) 下载 `yonote-server-linux-amd64-v*.tar.gz`（或 `arm64`），解压到 `/opt/yonote`：

```bash
sudo mkdir -p /opt/yonote
sudo tar -xzf yonote-server-linux-amd64-v1.0.0.tar.gz -C /opt/yonote
sudo useradd --system --home /var/lib/yonote --shell /usr/sbin/nologin yonote
sudo install -d -o yonote -g yonote -m 700 /var/lib/yonote
sudo chmod 755 /opt/yonote/yonote
```

2. 配置环境变量与 systemd 服务：

```bash
sudo cp /opt/yonote/deploy/yonote.env.example /etc/yonote.env
sudo chmod 600 /etc/yonote.env
sudoedit /etc/yonote.env

sudo cp /opt/yonote/deploy/yonote.service /etc/systemd/system/yonote.service
sudo systemctl daemon-reload
sudo systemctl enable --now yonote
curl http://127.0.0.1:8787/api/health
```

3. 如需使用自定义前端目录覆盖内嵌页面，可传递 `-web /path/to/dist` 启动参数。

---

## 数据备份与恢复

持久化数据全部位于数据目录（默认 `/var/lib/yonote` 或 Docker 卷 `/data`）：
- `yonote.db`：SQLite 数据库（WAL 模式）
- `blobs/`：按用户与 SHA-256 内容寻址存放的附件

```bash
# 一致性热快照（使用 SQLite VACUUM INTO，目标路径需为不存在的新文件）
/opt/yonote/yonote -data /var/lib/yonote -backup /path/to/new-snapshot.db
```

自动化备份脚本参考 `deploy/backup.sh`、`deploy/yonote-backup.service` 与 `deploy/yonote-backup.timer`。恢复时先停止 `yonote` 服务，完整替换 `yonote.db` 与 `blobs/` 并确保权限归 `yonote:yonote` 后重启。

---

## 构建签名 Android APK（GitHub Actions）

如需在你自己的 Fork 仓库自动构建正式签名 Android APK，请在仓库 **Settings → Secrets and variables → Actions** 配置以下 4 个 Secrets：

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

未配置时，CI 会自动改走 Debug APK 编译验证以保持流水线绿灯，但不会往 Release 发布未签名 APK。
