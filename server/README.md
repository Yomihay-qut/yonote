# Go 服务端

## 启动

```sh
go test ./...
go build -o yonote .
YONOTE_ADMIN=admin YONOTE_PASSWORD='至少十二字节的首次管理员密码' \
  ./yonote -addr 127.0.0.1:8787 -data ./data -web ../web/dist
```

首次启动创建管理员。后续启动读取现有用户，密码变更通过应用里的管理员页面完成。`YONOTE_ORIGIN` 可以配置额外获准的网页来源；安卓壳的本地来源已经列入 CORS。反向代理应保留 HTTPS 并限制请求体到 51MB。

SQLite 使用 WAL；密码以带独立随机盐的 Argon2id 保存；设备令牌以 SHA-256 哈希保存。数据库和附件目录应限制为运行服务的专用账号访问。

## 同步约定

- `POST /api/login` 接受 `username`、`password`、`device`，返回设备 `token` 与 `user`。
- 后续私有接口使用 `Authorization: Bearer <token>`。
- `POST /api/sync` 接受 `{mutations:[{opId,base,record}]}`。`record` 包含 `id,kind,version,updatedAt,deletedAt,value`，kind 为 `note` / `todo` / `folder`。
- `opId` 在账号内唯一；成功的重复请求重放相同回执。记录、变更日志、历史、搜索索引、冲突副本与回执在同一数据库事务内提交。
- 服务端提交顺序决定最终版本。已有版本与 `base` 不一致时，原服务端正文另存为 `标题（冲突副本）`，新提交写入原 ID。
- `GET /api/changes?cursor=0` 返回 `{records,cursor,more}`；客户端持续拉取直至 `more=false`，并将游标与本地应用记录原子保存。
- 文件夹先同步后同步成员。删除文件夹会在事务内将成员移到默认文件夹；离线编辑引用已删除文件夹时也会归入默认文件夹。
- 删除是软删除；`DELETE /api/records/{id}` 彻底删除最近删除中的记录，30 天后服务端定时做同样处理。保留无正文的 tombstone 与净化过的幂等回执，防止网络重试复活原内容。新的离线编辑以独立的恢复副本保留。

## 其他接口

| 用途 | 接口 |
|---|---|
| 当前账号与配额 | `GET /api/me` |
| 中文搜索 | `GET /api/search?q=…` |
| 历史 | `GET /api/history/{noteId}` |
| 上传 | `POST /api/attachments`，multipart 字段 `id,noteId,file` |
| 附件读取 / 移除 | `GET /api/attachments/{id}` / `DELETE /api/attachments/{id}` |
| 查看 / 创建分享 | `GET /api/shares/{noteId}` / `POST /api/shares/{noteId}` |
| 撤销分享 | `DELETE /api/shares/{token}` |
| 公开正文 / 附件 | `GET /api/public/{token}` / `GET /api/public/{token}/attachments/{id}` |
| 设备列表 / 注销 | `GET /api/devices` / `DELETE /api/devices/{id}` |
| 管理账号 | `GET/POST /api/admin/users` / `PATCH /api/admin/users/{id}` |

上传每文件 50MB，内容按账号与 SHA-256 去重；重复内容计费一次。管理员可调账号附件空间，默认 2GB。公开下载同时验证分享有效、账号启用、笔记未删除、附件在当前正文实际引用；附件保留账号隔离。

## 备份

```sh
./yonote -data ./data -backup /secure/new-snapshot.db
```

备份目标必须为新文件。命令使用 SQLite `VACUUM INTO` 生成一致的数据库快照。完整备份还应包含 `data/blobs`；部署文档提供定时备份示例。

## 验证

`go test -count=1 -v ./...` 覆盖同步幂等/冲突与并发、用户隔离、文件夹模块隔离与删除竞态、中文检索、历史合并、回收站恢复/彻底删除/过期清理、附件去重与配额、分享附件权限及冲突副本附件保留、管理员重置/禁用/注销设备和 CORS。`go vet ./...` 检查静态问题。
