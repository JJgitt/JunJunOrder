# 鸿运采购 CI/CD

流程：推送 → 测试/数据库迁移验证 → main 构建镜像 → GHCR（必推）→ 可选镜像到华为云 SWR → SSH 按 `IMAGE_REGISTRY` 拉取摘要镜像 → 数据库备份 → 切换 → 健康检查。

当前生产发布默认仍走 GHCR，避免服务器脚本未更新时中断上线。SWR 凭证只放在 GitHub Secrets，仓库里只有 2026-09-15 的 GHCR 快照：`deploy/ci/rollback/ghcr-20260915/`。

- `.github/workflows/ci-cd.yml`：所有分支 push 和 main PR 执行测试；只有 main push / main 手动运行可以发布。
- Actions 固定到上游提交 SHA；镜像按 Git commit 标记，生产部署按 digest 固定版本。
- 构建在 GitHub 执行，服务器只拉取和启动。应用、PostgreSQL、上传卷仍在现有服务器。
- GitHub 并发组 + 服务器 flock 双重串行保护。测试失败不会发布；镜像拉取失败不会切换线上应用。
- 发布失败自动切换旧镜像，但**不自动恢复数据库**。数据库变更必须向后兼容，破坏性迁移需要人工维护窗口。
- 每次发布会清理过期回滚标签和未再引用的本项目 digest；仍需定期看磁盘，并做异机备份。

## 仓库 Secrets

在 Settings → Secrets and variables → Actions 中：

| 名称 | 内容 |
| --- | --- |
| DEPLOY_SSH_KEY | 专用 Ed25519 私钥，不要输出或提交 |
| DEPLOY_KNOWN_HOSTS | 已核验的服务器 SSH 主机公钥，不在运行时盲目信任 ssh-keyscan |
| SWR_USERNAME | 华为云 SWR 登录用户，例如 `cn-north-4@AK` |
| SWR_PASSWORD | 华为云 SWR 登录密码，不要写入仓库 |

Variables：

| 名称 | 内容 |
| --- | --- |
| SWR_REGISTRY | 默认 `swr.cn-north-4.myhuaweicloud.com` |
| SWR_REPOSITORY | 例如 `junjunorder/junjunorder` |
| IMAGE_REGISTRY | 空或 `ghcr`：服务器仍拉 GHCR；`swr`：服务器改拉 SWR（须先更新服务器脚本） |

推送镜像用 GitHub 自动提供的 `GITHUB_TOKEN`（publish 作业 packages:write）；部署作业仅 packages:read。短期令牌通过 SSH 标准输入传入，在临时 Docker 配置目录中使用，结束后删除。无需长期 GHCR PAT。SWR 镜像是 GHCR 构建结果的副本，失败时默认不阻断 GHCR 发布。

## 服务器

- `/usr/local/bin/hongyun-ci-entry`：root 所有的 SSH 强制入口。
- `/usr/local/sbin/hongyun-deploy`：root 所有的发布脚本。新版本同时接受 `ghcr.io/jjgitt/junjunorder@sha256:<64位摘要>` 和 `swr.cn-north-4.myhuaweicloud.com/junjunorder/junjunorder@sha256:<64位摘要>`。未执行 `deploy/ci/install-server-deploy.sh` 前，线上仍是 GHCR-only 旧脚本。
- 回滚快照：`deploy/ci/rollback/ghcr-20260915/`。服务器安装新脚本时会先写成 `/usr/local/sbin/hongyun-deploy.bak-<时间戳>`。
- `/etc/sudoers.d/hongyun-ci`：仅允许免密执行上述发布脚本。
- `/etc/hongyun-cicd/compose.image.yaml`：覆盖应用镜像；沿用 `/home/junjun/hongyun-order` 的 Compose 和 `.env`。
- SSH 公钥使用 `restrict,command="/usr/local/bin/hongyun-ci-entry"`，禁止普通命令、PTY 和转发。
- 备份：`/home/junjun/hongyun-ci-backup.*/database.dump`，目录仅 root 可读。
- 当前部署摘要：`/var/lib/hongyun-cicd/current-image`。
- 空间保护：每次部署前后只保留「当前运行应用 + `hongyun-order-app:latest` + 最近 3 个 `rollback-*`」引用的本项目镜像，删除其余 GHCR/SWR digest；数据库备份保留最近 10 份；清理已退出的构建容器和服务器构建缓存。可用空间低于 5 GiB 时停止部署。仓库里的新脚本要再执行一次 `install-server-deploy.sh` 才会装到 `/usr/local/sbin/hongyun-deploy`。
- 日志轮转：服务器覆盖配置将应用与 PostgreSQL 的 Docker 日志限制为单文件 10MB、最多 3 份。

流水线不会自动替换服务器 Compose、SSH 或 sudo 配置，这些属于基础设施变更，需管理员单独安装和检查。

## 日常使用

将功能改动推送到分支观察测试结果，合并到 main 后自动部署。可在 GitHub Actions 查看各阶段日志；失败先查看失败步骤。建议为 main 配置分支保护、PR 审核和 test 必须通过。

GHCR 包应保持私有，并关联本仓库及授予本仓库 Actions 访问权；首次创建镜像通过 OCI source 标签关联。不得为解决下载权限而把含私有代码的镜像改为公开。

## 华为云 SWR

目标仓库：`swr.cn-north-4.myhuaweicloud.com/junjunorder/junjunorder`（私有）。

启用服务器从 SWR 拉镜像的顺序：

1. 在 GitHub 配置 `SWR_USERNAME`、`SWR_PASSWORD`、`SWR_REPOSITORY=junjunorder/junjunorder`。
2. 推送本仓库后，在服务器用 root 执行 `bash /home/junjun/hongyun-order/deploy/ci/install-server-deploy.sh`（先备份再替换发布脚本）。
3. 把 GitHub Variable `IMAGE_REGISTRY` 设为 `swr`。
4. 再推一次 `main`，确认健康检查通过。

回滚到 GHCR：`IMAGE_REGISTRY` 改回 `ghcr` 或不设；需要时把服务器脚本从 `hongyun-deploy.bak-*` 或 `deploy/ci/rollback/ghcr-20260915/deploy.sh` 装回去。线上正在跑的容器不会因为拉镜像失败而被替换。

## 参考

- https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images
- https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry
