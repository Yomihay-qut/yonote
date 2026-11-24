# 部署与运维指南

Yonote 服务端为单二进制 Go 程序，内嵌纯 Go SQLite 驱动（`CGO_ENABLED=0`），支持 **Docker Compose**、**Linux systemd + Nginx** 与 **Windows 独立运行**三种方式。

---

## 环境变量说明

| 变量名 | 说明 |
| --- | --- |
| `YONOTE_ADMIN` | 首次启动（数据库为空时）创建的管理员用户名，例如 `admin` |
| `YONOTE_PASSWORD` | 首次启动创建的管理员密码（**至少 12 个字符**） |
| `YONOTE_ORIGIN` | 对外公开的 HTTPS 站点地址（末尾不带 `/`），用于 CORS 校验，例如 `https://notes.example.com` |

> `YONOTE_ADMIN` 与 `YONOTE_PASSWORD` 仅在数据库 `users` 表为空时生效；初始化完成后可通过应用内「设置 → 用户管理」修改密码或管理账号。

---

## 方式一：Docker Compose 部署（推荐）

1. 克隆仓库并编辑 `docker-compose.yml` 中的 `YONOTE_PASSWORD` 和 `YONOTE_ORIGIN`：

```bash
git clone https://github.com/Yomihay-qut/yonote.git
cd yonote
docker compose up -d
```

2. 检查服务健康状态：

```bash
curl http://127.0.0.1:8787/api/health
# 返回 {"status":"ok"}
```

3. 使用 Nginx / Caddy 将你的 HTTPS 域名反向代理至 `http://127.0.0.1:8787`（参考 `deploy/nginx.conf`）。

---

## 方式二：Linux 预编译包（systemd + Nginx）

1. 从 [Releases](https://github.com/Yomihay-qut/yonote/releases) 下载对应架构包（`yonote-linux-amd64-*.tar.gz` 或 `arm64`），解压到 `/opt/yonote`：

```bash
sudo mkdir -p /opt/yonote
sudo tar -xzf yonote-linux-amd64-v0.9.0.tar.gz -C /opt/yonote
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

3. 配置 Nginx 反代：复制 `deploy/nginx.conf`，将 `notes.example.com` 及证书路径替换为你的实际配置并重载 Nginx。

---

## 数据备份与恢复

所有持久化数据位于数据目录（默认 `/var/lib/yonote` 或 Docker 卷 `/data`）：
- `yonote.db`：SQLite 数据库（WAL 模式）
- `blobs/`：按用户与 SHA-256 内容寻址存放的附件

### 一致性热快照命令

```bash
/opt/yonote/yonote -data /var/lib/yonote -backup /path/to/new-snapshot.db
```

该命令使用 SQLite `VACUUM INTO` 生成一致性数据库副本（目标路径需为不存在的新文件）。

### 自动化私有 Git 定时备份（可选）

`deploy/backup.sh` 配合 `deploy/yonote-backup.service` / `yonote-backup.timer` 支持每日自动停写快照并推送到专用私有 Git 备份仓库（需预先配置好 `BACKUP_REPO` 本地仓库与 SSH/Token 鉴权）。

### 恢复步骤

1. 停止服务：`sudo systemctl stop yonote`
2. 替换整个数据目录（同时恢复 `yonote.db` 与 `blobs/`），并确认权限归 `yonote:yonote`
3. 重新启动：`sudo systemctl start yonote`

---

## 构建签名 Android APK（GitHub Actions）

如需在你自己的仓库自动构建可覆盖升级的签名 Android APK，请在 GitHub 仓库 **Settings → Secrets and variables → Actions** 配置以下 4 个 Secrets：

- `ANDROID_KEYSTORE_BASE64`：签名 `.jks` 文件的 Base64 编码
- `ANDROID_KEYSTORE_PASSWORD`：Keystore 密码
- `ANDROID_KEY_ALIAS`：密钥别名
- `ANDROID_KEY_PASSWORD`：密钥密码

未配置上述 Secrets 时（例如开源 Fork），CI 会自动改走 `assembleDebug` 编译校验并保持绿灯通过，不会阻塞常规 PR 与构建。
