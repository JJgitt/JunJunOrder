# 鸿运采购 CI/CD

流程：推送 → 测试/数据库迁移验证 → main 在 runner 本地构建镜像 → 只推 GHCR → 国内服务器拉 GHCR，再推到广州 ACR → 用 ACR 部署 → 数据库备份 → 切换 → 健康检查。

选仓顺序：默认部署目标 ACR，种子固定为 GHCR。`IMAGE_REGISTRY=ghcr` 或 `swr` 时只拉 GHCR。美国 GitHub runner **不推 ACR，也不推 SWR**：两个国内仓库从海外上传都会卡住。凭证只放在 GitHub Secrets，仓库里保留 2026-09-15 的 GHCR 快照：`deploy/ci/rollback/ghcr-20260915/`。

更新 `deploy/ci/deploy.sh` 后必须在服务器重新执行 `deploy/ci/install-server-deploy.sh`，否则 ACR 五段 stdin 对不上旧脚本。

- `.github/workflows/ci-cd.yml`：所有分支 push 和 main PR 执行测试；只有 main push / main 手动运行可以发布。
- Actions 固定到上游提交 SHA；镜像按 Git commit 标记，生产部署按 digest 固定版本。
- 构建在 GitHub 执行，服务器只拉取和启动。应用、PostgreSQL、上传卷仍在现有服务器。
- GitHub 并发组 + 服务器 flock 双重串行保护。测试失败不会发布；SWR / ACR 登录或镜像同步失败时，按选仓顺序改拉本次构建的同摘要镜像。每次镜像拉取最多等待 5 分钟、最多尝试 3 次，全部失败也不会切换线上应用。
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
| IMAGE_REGISTRY | 空或 `acr`：ACR → SWR → GHCR；`swr`：SWR → ACR → GHCR；`ghcr`：只拉 GHCR |

推送镜像用 GitHub 自动提供的 `GITHUB_TOKEN`（publish 作业 packages:write）；部署作业仅 packages:read。短期令牌通过 SSH 标准输入传入，在临时 Docker 配置目录中使用，结束后删除。无需长期 GHCR PAT。ACR 由国内服务器从 SWR（或 GHCR）灌入，不从美国 runner 直推广州。

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

1. 服务器 `/usr/local/sbin/hongyun-deploy` 须已包含「国内灌 ACR」逻辑（五段 stdin）。
2. 在 GitHub 配置 Variables `ACR_REGISTRY`、`ACR_REPOSITORY=junjunorder/junjunorder`，Secrets `ACR_USERNAME`、`ACR_PASSWORD`（阿里云控制台 → 容器镜像服务 → 访问凭证 → 固定密码）。
3. `IMAGE_REGISTRY` 设为 `acr` 或不设：部署目标 ACR，由国内服务器从 SWR/GHCR 灌入。

停用 ACR：删掉 `ACR_REPOSITORY`。停用 SWR：删掉 `SWR_REPOSITORY`。只拉 GHCR：把 `IMAGE_REGISTRY` 设为 `ghcr`。

美国 runner 不推 ACR，也不推华为云 SWR。`Push image to Huawei SWR` 卡住的原因和 ACR 一样：runner 在美国，SWR 在华北，跨境上传停住。国内服务器从 GHCR 拉镜像（下载方向），再在国内推广州 ACR。

## 为什么 GitHub 上推国内仓库会卡住

GitHub-hosted runner 在美国。阿里云个人版在广州，华为云 SWR 在华北。阿里云文档写明：个人版从海外再推回中国内地会慢，而且容易因跨域网络失败。SWR 没有单独的海外加速，从美国 `docker push` 同样会停在上传。账号是登上的。处理办法是 runner 只推 GHCR，国内机器再拉 GHCR、推广州 ACR。

## 参考

- https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images
- https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry
- https://help.aliyun.com/zh/acr/support/faq-about-the-basic-operations-of-container-registry
