# 骏骏订单智能采购系统

独立部署的移动端订单、库存与收发货管理系统。前后端均由本仓库提供，不依赖 `chatgpt.site`、Cloudflare D1/R2 或 ChatGPT 登录。

完整的业务规则、技术实现和维护指南见 [系统知识库](docs/系统知识库.md)。

采购订单采用"订单头 + 商品行"结构：一笔订单可包含多个商品（不同货号/尺码/数量/金额），共享采购渠道、平台单号与快递信息；入库按整单收货，发货按商品行逐个进行（每个商品可单独填写二级平台单号、售价与发货物流），订单状态随商品行发货进度自动推导（待发货 → 已发货）。

采购订单录入页支持智能识图：一次最多上传 3 张平台订单详情截图（京东 / 拼多多 / 淘宝 / 唯品会 / 抖音，数量上限与普通附件相同），系统把这些图一起交给视觉大模型，抽取一份采购渠道、平台订单号、快递公司、快递单号以及每个商品的名称 / 货号 / 尺码 / 数量 / 实付金额，自动填入表单并把截图加入订单附件（附件合计仍最多 3 张）。如果截图只有物流/快递信息、没有商品，就只填快递公司和快递单号，不编造商品。识别结果只是草稿，提交前请核对。需要在服务器配置 `VISION_*` 环境变量（见下文）。每次进入「新增 / 上报」都会清空上一单留下的表单内容；从订单列表点编辑才会带出原单。

管理员和采购员的订单列表都可以按状态多选筛选：点多个状态标签同时查看，未选或点「全部」显示全部订单；管理员点「待发货」横幅时会单独筛出待发货订单。

订单列表与库存页的搜索框会记住最近的搜索词：点击输入框即可看到搜索记录（最多 10 条，最近优先，输入时按包含关系过滤），点一条自动填入，也可单条删除或一键清空。记录保存在浏览器本地，按设备与列表分开，不会同步到服务器。

手动入库填写库位时，输入框下方会列出最近使用过的历史库位（按最近入库时间排序、去重，最多 12 个），点一下即可填入，也可以直接手输新库位。

入库如有误操作，管理员可在订单详情中「退回在途」撤销入库：库存同步扣回、清空库位与入库时间并留下一条库存调整流水，之后可重新入库；订单内只要有商品已发货就不允许退回。

## 技术架构

- Next.js + React + TypeScript
- PostgreSQL + Drizzle ORM
- HttpOnly Cookie + JWT 会话
- 服务器持久化目录保存订单图片
- Docker Compose + Caddy 自动 HTTPS

## 一键部署

服务器需要安装 Docker Engine 与 Docker Compose，域名 A/AAAA 记录需指向服务器。

```bash
cp .env.example .env
```

编辑 `.env`，至少替换：

- `APP_DOMAIN`：例如 `order.example.com`；只用 IP 测试时填 `:80`
- `SITE_ORIGIN`：例如 `https://order.example.com`
- `POSTGRES_PASSWORD`：数据库强密码，建议只使用 URL 安全字符
- `AUTH_SECRET`：使用 `openssl rand -base64 48` 生成
- `ADMIN_WECHAT_ID`、`ADMIN_PASSWORD`：首次启动创建的管理员账号
- HTTPS 域名部署时设置 `COOKIE_SECURE=true`；纯 HTTP 测试时设置为 `false`

启动：

```bash
docker compose up -d --build
docker compose ps
```

首次启动会自动执行数据库迁移并创建管理员。之后使用 `ADMIN_WECHAT_ID` 和 `ADMIN_PASSWORD` 登录；管理员可在系统的“成员与权限”中创建采购员或其他管理员账号、调整角色、停用账号以及重置成员密码（新密码至少 8 位，重置后立即生效，请线下告知成员）。管理员也可以删除采购员账号：仅限采购员角色、不能删除自己、需二次确认；为保护订单归属与审计记录，已经提交过订单或有任何操作记录的采购员不允许删除，此类账号请使用「停用」。为兼容旧部署，启动脚本仍可读取原 `ADMIN_EMAIL` 的值。

游客也可从登录页进入“申请采购员账号”，填写姓名、手机号、微信号和密码后提交申请。新申请默认不能登录，管理员需在“我的 → 采购员申请”中审批；通过后账号才会启用并允许登录，拒绝的申请仍保留在审批记录中，管理员可重新通过。

升级：

```bash
git pull
docker compose up -d --build
```

数据库和图片分别保存在 Docker 命名卷 `postgres_data`、`app_uploads`，重新构建容器不会丢失。

## 备份与恢复

备份数据库：

```bash
docker compose exec -T postgres pg_dump -U junjun -d junjun_order > junjun-order.sql
```

恢复数据库前应先停止应用写入，然后执行：

```bash
docker compose exec -T postgres psql -U junjun -d junjun_order < junjun-order.sql
```

图片位于 `app_uploads` 卷，建议使用服务器快照或定期将该卷同步到对象存储。数据库和图片应在相同时间窗口备份。

## 本地开发

本地需要 Node.js 22 和 PostgreSQL：

```bash
npm ci
cp .env.example .env.local
npm run db:generate
npm run db:bootstrap
npm run dev
```

`DATABASE_URL` 在本地开发时应指向本机 PostgreSQL。访问 `http://localhost:3000`。

## 环境变量

- `DATABASE_URL`：PostgreSQL 连接地址
- `DATABASE_POOL_SIZE`：连接池大小，默认 10
- `AUTH_SECRET`：会话签名密钥，至少 32 字符
- `COOKIE_SECURE`：HTTPS 环境必须为 `true`
- `UPLOAD_DIR`：订单图片持久化目录
- `OCR_ENDPOINT`、`OCR_TOKEN`：可选 OCR 服务适配器（收货面单识别快递单号）
- `VISION_API_BASE`、`VISION_API_KEY`、`VISION_MODEL`：可选智能识图服务，用于上传最多 3 张订单截图自动填写采购订单。走 OpenAI 兼容的 `chat/completions` 协议，通义千问 VL（`https://dashscope.aliyuncs.com/compatible-mode/v1` + `qwen-vl-plus`）、豆包、智谱 GLM-4V、GPT-4o 等均可直接使用；`VISION_TIMEOUT_MS` 为单次识别超时（未设置时单张默认 45000，多张默认 75000）。未配置时识图入口会提示"尚未配置"，其余功能不受影响
- `DEWU_SYNC_ENDPOINT`、`DEWU_APP_KEY`、`DEWU_APP_SECRET`：可选得物服务端适配器

## 常用命令

- `npm run dev`：开发服务器
- `npm run build`：生产构建
- `npm run lint`：代码规范检查
- `npm test`：生产构建与关键结构测试
- `npm run db:generate`：数据模型变更后生成迁移
- `npm run db:bootstrap`：执行迁移并在空数据库创建初始管理员

## 安全提示

- 不要提交 `.env`。
- PostgreSQL 不对公网暴露端口，默认只在 Compose 内部网络访问。
- 图片接口经过登录和订单归属校验，不直接暴露上传目录。
- 得物和 OCR 凭证只保存在服务器环境变量中。
- 上线后定期备份 PostgreSQL 与图片卷，并及时更新基础镜像和 npm 依赖。
