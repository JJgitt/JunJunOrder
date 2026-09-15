# GHCR 流水线快照（2026-09-15）

这是切换华为云 SWR 之前、正在生产使用的发布脚本和工作流备份。

回滚仓库内流水线：

```bash
cp deploy/ci/rollback/ghcr-20260915/ci-cd.yml .github/workflows/ci-cd.yml
cp deploy/ci/rollback/ghcr-20260915/deploy.sh deploy/ci/deploy.sh
cp deploy/ci/rollback/ghcr-20260915/ssh-entry.sh deploy/ci/ssh-entry.sh
```

回滚服务器发布脚本（在服务器上、用 root）：

```bash
ls /usr/local/sbin/hongyun-deploy.bak-*
install -o root -g root -m 755 /usr/local/sbin/hongyun-deploy.bak-<时间戳> /usr/local/sbin/hongyun-deploy
```

或直接装回本目录的 `deploy.sh`：

```bash
install -o root -g root -m 755 /home/junjun/hongyun-order/deploy/ci/rollback/ghcr-20260915/deploy.sh /usr/local/sbin/hongyun-deploy
```

GitHub 变量 `IMAGE_REGISTRY` 设为 `ghcr` 或不设，发布目标就会走 GHCR。不要把 SWR 密码写进这个目录。
