# JunJunOrder Agent Wiki

本 Wiki 是后续 Agent 进入项目的导航层，不代替源码和迁移。先读本页，再按任务选读；文档与实现冲突时，以当前代码、`db/schema.ts` 和已执行 SQL 迁移为准，并在同次迭代中修正文档。

## 30 秒识别项目

- 产品：采购员录单、管理员审核与入库、逐商品发货、采购结款、库存和成员管理的移动端系统。
- 技术：Next.js 16.3.3 App Router、React 19、TypeScript、PostgreSQL 17、Drizzle ORM；Node.js 至少 22.13。
- 主入口：页面在 `app/page.tsx`，多数业务写操作集中在 `app/api/app/route.ts` 的 `POST action`，读操作由同文件的 `snapshot()` 生成角色化快照。
- 持久化：`db/schema.ts` 定义模型；`drizzle/*.sql` 是实际部署的迁移；图片二进制在持久化卷，数据库保存元数据。
- 交付：推送 `main` 会触发 CI 测试、镜像发布和生产部署。纯文档改动也会触发整条流水线，操作前看 `AGENTS.md` 的交付规则。

## 按任务阅读

| 任务 | 先读 | 再定位 |
| --- | --- | --- |
| 订单、库存、结款业务 | [业务与不变量](业务与不变量.md) | `app/api/app/route.ts`、`db/schema.ts` |
| 页面或 API 改动 | [架构与定位](架构与定位.md) | `app/page.tsx`、对应 `app/api/**/route.ts` |
| 数据库字段/迁移 | [迭代手册](迭代手册.md) | `db/schema.ts`、`drizzle/`、[数据库设计](../数据库设计.md) |
| 鉴权、上传、识图 | [架构与定位](架构与定位.md) | `lib/auth.ts`、`lib/file-storage.ts`、`lib/vision.ts` |
| 测试、上线、故障 | [迭代手册](迭代手册.md) | `.github/workflows/ci-cd.yml`、[CI/CD 说明](../../deploy/ci/README.md) |
| 录单操作教学 | [上传订单教程](../%E4%B8%8A%E4%BC%A0%E8%AE%A2%E5%8D%95%E6%95%99%E7%A8%8B.html) | `app/page.tsx` 的 `UploadPage`、`app/api/app/route.ts` 的 `create-order` |

## 现有深度资料

- [上传订单教程](../%E4%B8%8A%E4%BC%A0%E8%AE%A2%E5%8D%95%E6%95%99%E7%A8%8B.html)：面向采购员与管理员的可视化录单教程（界面示意 + 箭头标注），含识图填写、必填项速查与常见报错；界面或校验变更后需同步更新。
- [系统知识库](../系统知识库.md)：历史业务流程与设计解释；先核对其中日期和当前代码，尤其是后续增加的结款、看板事项与识图能力。
- [数据库设计](../数据库设计.md)：表、列、索引与外键快照；以迁移为最终依据。
- [README](../../README.md)：本地启动、环境变量、部署和基本使用。
- [CI/CD 说明](../../deploy/ci/README.md)：镜像仓库、部署、回滚与服务器权限。

## 新 Agent 的第一轮检查

1. `git status --short --branch`：识别用户已有改动，禁止顺手覆盖或带入提交。
2. 查任务对应源码和测试；不要仅凭 Wiki 推断实现。
3. 若写 Next.js 代码，先读 `node_modules/next/dist/docs/` 下对应版本指南（仓库 `AGENTS.md` 要求）。
4. 明确角色权限、订单原始状态/派生状态、事务边界、库存三层同步、审计和兼容迁移。
5. 运行与改动相称的本地检查；按 `AGENTS.md` 的交付工作流处理提交、推送与部署观察。

本文档只写结构和规则，不记录账号密码、令牌、生产数据或临时运维凭据。
