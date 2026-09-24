# 鸿运采购 CI/CD

流程：推送 → 测试/数据库迁移验证 → 阿里云 ACR 个人版在中国内地构建镜像（标签 `main`）→ 国内服务器等到该镜像里的提交号与本次 Git 提交一致 → 按 digest 从 ACR 部署 → 数据库备份 → 切换 → 健康检查。

GitHub Actions 不再构建或推送镜像。构建规则要关掉「海外机器构建」。凭证只放在 GitHub Secrets，仓库里保留 2026-09-15 的 GHCR 快照：`deploy/ci/rollback/ghcr-20260915/`。

更新 `deploy/ci/deploy.sh` 后必须在服务器重新安装 `/usr/local/sbin/hongyun-deploy`，否则服务器仍会按旧协议从 GHCR 灌 ACR。

- `.github/workflows/ci-cd.yml`：所有分支 push 和 main PR 执行测试；只有 main push / main 手动运行可以发布。
- Actions 固定到上游提交 SHA；镜像按 Git commit 标记，生产部署按 digest 固定版本。
- 镜像由 ACR 个人版在中国内地构建，服务器只拉取和启动。应用、PostgreSQL、上传卷仍在现有服务器。
- GitHub 并发组 + 服务器 flock 双重串行保护。测试失败不会发布。服务器最多等 25 分钟，直到 ACR 的 `main` 标签对上本次提交；等不到就不切换线上应用。
- 发布失败自动切换旧镜像，但**不自动恢复数据库**。数据库变更必须向后兼容，破坏性迁移需要人工维护窗口。
- 每次发布会清理过期回滚标签和未再引用的本项目 digest；仍需定期看磁盘，并做异机备份。

## 仓库 Secrets

在 Settings → Secrets and variables → Actions 中：

| 名称 | 内容 |
| --- | --- |
| DEPLOY_SSH_KEY | 专用 Ed25519 私钥，不要输出或提交 |
| DEPLOY_KNOWN_HOSTS | 已核验的服务器 SSH 主机公钥，不在运行时盲目信任 ssh-keyscan |
| SWR_USERNAME | 华为云 SWR 登录用户名（区域@AK） |
| SWR_PASSWORD | 华为云 SWR 登录密码（SK），不要写入仓库 |
| ACR_USERNAME | 阿里云 ACR 个人版登录用户名（控制台「访问凭证」显示的账号全名） |
| ACR_PASSWORD | 阿里云 ACR 个人版 Registry 固定密码，不要写入仓库 |

Variables：

| 名称 | 内容 |
| --- | --- |
| SWR_REGISTRY | 默认 `swr.cn-north-4.myhuaweicloud.com` |
| SWR_REPOSITORY | 例如 `junjunorder/junjunorder`；为空则跳过 SWR |
| ACR_REGISTRY | 默认 `crpi-lz061y1f8ajv9wzf.cn-guangzhou.personal.cr.aliyuncs.com` |
| ACR_REPOSITORY | 例如 `junjunorder/junjunorder`；为空则跳过 ACR |
| IMAGE_REGISTRY | 不再参与选仓。发布固定等待 ACR 个人版构建的 `main` 标签 |

部署只使用 `ACR_USERNAME` / `ACR_PASSWORD`。令牌通过 SSH 标准输入传入，在临时 Docker 配置目录中使用，结束后删除。`SWR_*` 已不参与发布。

## 服务器

- `/usr/local/bin/hongyun-ci-entry`：root 所有的 SSH 强制入口。
- `/usr/local/sbin/hongyun-deploy`：root 所有的发布脚本，只接受 `ghcr.io/jjgitt/junjunorder`、`swr.cn-north-4.myhuaweicloud.com/junjunorder/junjunorder`、`crpi-lz061y1f8ajv9wzf.cn-guangzhou.personal.cr.aliyuncs.com/junjunorder/junjunorder` 三个仓库带 `@sha256:<64位摘要>` 的镜像；单次 `docker pull` 超时为 5 分钟。仓库脚本更新后需要重新执行 `deploy/ci/install-server-deploy.sh` 才会安装到服务器。
- 回滚快照：`deploy/ci/rollback/ghcr-20260915/`。服务器安装新脚本时会先写成 `/usr/local/sbin/hongyun-deploy.bak-<时间戳>`。
- `/etc/sudoers.d/hongyun-ci`：仅允许免密执行上述发布脚本。
- `/etc/hongyun-cicd/compose.image.yaml`：覆盖应用镜像；沿用 `/home/junjun/hongyun-order` 的 Compose 和 `.env`。
- SSH 公钥使用 `restrict,command="/usr/local/bin/hongyun-ci-entry"`，禁止普通命令、PTY 和转发。
- 备份：`/home/junjun/hongyun-ci-backup.*/database.dump`，目录仅 root 可读。
- 当前部署摘要：`/var/lib/hongyun-cicd/current-image`。
- 空间保护：每次部署前后只保留「当前运行应用 + `hongyun-order-app:latest` + 最近 3 个 `rollback-*`」引用的本项目镜像，删除其余 GHCR/SWR/ACR digest；数据库备份保留最近 10 份；清理已退出的构建容器和服务器构建缓存。可用空间低于 5 GiB 时停止部署。仓库里的新脚本要再执行一次 `install-server-deploy.sh` 才会装到 `/usr/local/sbin/hongyun-deploy`。
- 日志轮转：服务器覆盖配置将应用与 PostgreSQL 的 Docker 日志限制为单文件 10MB、最多 3 份。

流水线不会自动替换服务器 Compose、SSH 或 sudo 配置，这些属于基础设施变更，需管理员单独安装和检查。

## 日常使用

将功能改动推送到分支观察测试结果，合并到 main 后自动部署。可在 GitHub Actions 查看各阶段日志；失败先查看失败步骤。建议为 main 配置分支保护、PR 审核和 test 必须通过。

GHCR 包应保持私有，并关联本仓库及授予本仓库 Actions 访问权；首次创建镜像通过 OCI source 标签关联。不得为解决下载权限而把含私有代码的镜像改为公开。

回滚到 GHCR：`IMAGE_REGISTRY` 设为 `ghcr`；需要时把服务器脚本从 `hongyun-deploy.bak-*` 或 `deploy/ci/rollback/ghcr-20260915/deploy.sh` 装回去。线上正在跑的容器不会因为拉镜像失败而被替换。

## 阿里云 ACR

目标仓库：`crpi-lz061y1f8ajv9wzf.cn-guangzhou.personal.cr.aliyuncs.com/junjunorder/junjunorder`（个人版实例，华南·广州，私有）。个人版免费、无 SLA、单账号一个实例。生产发布从这里拉镜像。

启用顺序：

1. 广州个人版仓库绑定 GitHub 账号 `JJgitt/JunJunOrder`。
2. 构建规则：类型 Branch，分支 `main`，上下文目录 `/`，Dockerfile 文件名 `Dockerfile`，镜像版本 `main`。开启「代码变更时自动构建镜像」，关闭「海外机器构建」。
3. 服务器 `/usr/local/sbin/hongyun-deploy` 须会等待 `main` 标签里的 `/app/source-revision` 与本次提交一致。
4. GitHub Secrets `ACR_USERNAME`、`ACR_PASSWORD` 仍是控制台「访问凭证」里的固定密码。

镜像里的 `/app/source-revision` 在 ACR 构建时由 `git rev-parse HEAD` 写入。个人版构建规则的标签是固定的 `main`，所以用这个文件区分是不是这次提交。构建超时为 30 分钟。

基础镜像使用 AWS ECR Public 中 Docker 官方账号的 `node:22-alpine` 与 `alpine:3.20`，并锁定已核验的 OCI 摘要。这样不会在 ACR 构建时向 Docker Hub 请求基础镜像，避开个人版共享出口的 429 限流。升级 Node/Alpine 时需核验新摘要并同步更新 `Dockerfile`。若中国内地构建器访问 ECR Public 不稳定，按[阿里云官方建议](https://help.aliyun.com/zh/acr/product-overview/notice-about-speed-limits-on-image-pulling-from-docker-hub-in-container-registry-personal-edition)，将这两个基础镜像同步到同地域同账号的 ACR 仓库后再替换 `FROM`；不要改用未经核验的第三方镜像代理。

回滚仍可手动传入 GHCR、SWR 或 ACR 的 digest。自动发布不再推这些仓库。

## 参考

- https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images
- https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry
- https://help.aliyun.com/zh/acr/support/faq-about-the-basic-operations-of-container-registry
