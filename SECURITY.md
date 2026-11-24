# 安全策略

## 报告安全漏洞

如果你发现了安全隐患（如认证绕过、越权访问、XSS、路径遍历、SQL 注入等），请**不要**直接在公开 Issue 中披露完整利用细节。

请通过 GitHub 仓库的 **Security → Advisories → Report a vulnerability**（私密漏洞报告）联系维护者，我们会尽快确认并发布修复版本。

## 自托管安全建议

1. **强制使用 HTTPS**：生产部署请务必在 Nginx / Caddy 等反向代理层启用 TLS，并正确配置 `YONOTE_ORIGIN`。
2. **强管理员密码**：首次启动的 `YONOTE_PASSWORD` 至少 12 位随机字符；如使用 `docker-compose.yml` 或 `/etc/yonote.env`，切勿将真实密码提交到 Git。
3. **最小权限 AI 密钥**：为外部 MCP / AI 客户端创建 API Key 时，按需勾选只读/可写权限并限定可访问的文件夹范围，不再使用时及时吊销。
4. **定期备份数据**：数据库与附件位于数据目录的 `yonote.db` 和 `blobs/`，建议使用 `yonote -backup` 配合加密或私有仓库定期备份。
