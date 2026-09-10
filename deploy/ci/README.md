# 鸿运采购 CI/CD

流程：推送 → 测试/数据库迁移验证 → main 构建镜像 → GHCR → SSH 拉取摘要镜像 → 数据库备份 → 切换 → 健康检查。

- `.github/workflows/ci-cd.yml`：所有分支 push 和 main PR 执行测试；只有 main push / main 手动运行可以发布。
- Actions 固定到上游提交 SHA；镜像按 Git commit 标记，生产部署按 digest 固定版本。
- 构建在 GitHub 执行，服务器只拉取和启动。应用、PostgreSQL、上传卷仍在现有服务器。
- GitHub 并发组 + 服务器 flock 双重串行保护。测试失败不会发布；镜像拉取失败不会切换线上应用。
- 发布失败自动切换旧镜像，但**不自动恢复数据库**。数据库变更必须向后兼容，破坏性迁移需要人工维护窗口。
- 不自动清理备份和旧镜像；需定期检查磁盘容量和配置异机备份。

## 仓库 Secrets

在 Settings → Secrets and variables → Actions 中：

| 名称 | 内容 |
| --- | --- |
| DEPLOY_SSH_KEY | 专用 Ed25519 私钥，不要输出或提交 |
| DEPLOY_KNOWN_HOSTS | 已核验的服务器 SSH 主机公钥，不在运行时盲目信任 ssh-keyscan |

推送镜像用 GitHub 自动提供的 `GITHUB_TOKEN`（publish 作业 packages:write）；部署作业仅 packages:read。短期令牌通过 SSH 标准输入传入，在临时 Docker 配置目录中使用，结束后删除。无需长期 GHCR PAT。

## 服务器

- `/usr/local/bin/hongyun-ci-entry`：root 所有的 SSH 强制入口。
- `/usr/local/sbin/hongyun-deploy`：root 所有的发布脚本，仅接受 `ghcr.io/jjgitt/junjunorder@sha256:<64位摘要>`。
- `/etc/sudoers.d/hongyun-ci`：仅允许免密执行上述发布脚本。
- `/etc/hongyun-cicd/compose.image.yaml`：覆盖应用镜像；沿用 `/home/junjun/hongyun-order` 的 Compose 和 `.env`。
- SSH 公钥使用 `restrict,command="/usr/local/bin/hongyun-ci-entry"`，禁止普通命令、PTY 和转发。
- 备份：`/home/junjun/hongyun-ci-backup.*/database.dump`，目录仅 root 可读。
- 当前部署摘要：`/var/lib/hongyun-cicd/current-image`。

流水线不会自动替换服务器 Compose、SSH 或 sudo 配置，这些属于基础设施变更，需管理员单独安装和检查。

## 日常使用

将功能改动推送到分支观察测试结果，合并到 main 后自动部署。可在 GitHub Actions 查看各阶段日志；失败先查看失败步骤。建议为 main 配置分支保护、PR 审核和 test 必须通过。

GHCR 包应保持私有，并关联本仓库及授予本仓库 Actions 访问权；首次创建镜像通过 OCI source 标签关联。不得为解决下载权限而把含私有代码的镜像改为公开。

## 华为云备用方案

当前服务器 GHCR 入口可达；大镜像实际下载以首次流水线为准。若后续持续超时，可将发布仓库改为用户自己的华为云 SWR。需要指定区域、组织名、镜像地址，并配置受限凭证。同步修改工作流镜像地址/登录方式和服务器脚本的精确仓库白名单；两端一致后再启用。不会自动向未授权的镜像仓库上传代码。

## 参考

- https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images
- https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry
