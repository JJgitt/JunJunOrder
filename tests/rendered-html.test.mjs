import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

/** 结构测试只关心代码是否还在，不绑死格式化空白。 */
function compactJs(source) {
  return source.replace(/\s+/g, "");
}

function compactCss(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s*([{};:,>+~])\s*/g, "$1");
}

function compactPattern(pattern) {
  const source = pattern instanceof RegExp ? pattern.source : String(pattern);
  const flags = pattern instanceof RegExp ? pattern.flags : "";
  return new RegExp(source.replace(/\\s(?:[*+?]|\{\d+(?:,\d*)?\})?/g, "").replace(/\s+/g, ""), flags);
}

function assertJsMatch(source, pattern) {
  assert.match(compactJs(source), compactPattern(pattern));
}

function assertJsNotMatch(source, pattern) {
  assert.doesNotMatch(compactJs(source), compactPattern(pattern));
}

function assertCssMatch(source, pattern) {
  assert.match(compactCss(source), pattern);
}

test("touch forms prevent iOS focus zoom while keeping field text compact", async () => {
  const css = await readFile(new URL("../app/touch-forms.css", import.meta.url), "utf8");
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /import "\.\/touch-forms\.css"/);
  assert.match(css, /@media \(max-width: 720px\), \(any-pointer: coarse\)/);
  assert.match(css, /input:not\(/);
  assert.match(css, /textarea,\s*select\s*\{/);
  assert.match(css, /font-size: 16px !important/);
  assert.match(css, /:focus\s*\{\s*font-size: 16px !important/);
  assert.match(css, /\.member-list select,\s*\.member-role-select\s*\{/);
  assert.doesNotMatch(css, /html\.ios-device|font-size: (?:12|13)px !important/);
  assert.match(layout, /export const viewport: Viewport/);
  assert.match(layout, /width: "device-width"/);
  assert.match(layout, /initialScale: 1/);
  assert.doesNotMatch(layout, /maximumScale|userScalable|maximum-scale|next\/script/);
});

test("form grids shrink and touch buyer filters match native select text", async () => {
  const css = await readFile(new URL("../app/touch-forms.css", import.meta.url), "utf8");
  assert.match(css, /\.field-grid\s*\{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.field-grid > label\s*\{\s*min-width: 0/);
  assert.match(css, /\.field-grid select\s*\{\s*width: 100%;\s*min-width: 0/);
  assert.match(css, /\.select-row \.buyer-filter-trigger\s*\{\s*font-size: 16px/);
  assert.doesNotMatch(css, /html\.ios-device/);
});

test("purchase quantity can be cleared while entering a new value", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assertJsMatch(page, /qty:number\|""/);
  assertJsMatch(page, /qty:value===""\?"":Math\.max\(1,Math\.trunc\(Number\(value\)\)\)/);
  assertJsMatch(page, /if\(item\.qty===""\)updateItem\(index,\{qty:1\}\)/);
  assertJsNotMatch(page, /qty:Math\.max\(1,Number\(e\.target\.value\)\)/);
});

test("produces a standalone Next.js server",async()=>{
  await access(new URL("../.next/standalone/server.js",import.meta.url));
  await access(new URL("../.next/static/",import.meta.url));
  const manifest=JSON.parse(await readFile(new URL("../.next/routes-manifest.json",import.meta.url),"utf8"));
  assert.ok(Array.isArray(manifest.dynamicRoutes));
});

test("is independent from chatgpt.site and Cloudflare storage",async()=>{
  const [pkg,compose,schema,auth,files]=await Promise.all([
    readFile(new URL("../package.json",import.meta.url),"utf8"),
    readFile(new URL("../compose.yaml",import.meta.url),"utf8"),
    readFile(new URL("../db/schema.ts",import.meta.url),"utf8"),
    readFile(new URL("../lib/auth.ts",import.meta.url),"utf8"),
    readFile(new URL("../lib/file-storage.ts",import.meta.url),"utf8"),
  ]);
  const packageJson=JSON.parse(pkg);
  assert.equal(packageJson.scripts.build,"next build");
  assert.ok(packageJson.dependencies.next);
  assert.ok(packageJson.dependencies.postgres);
  assert.equal(packageJson.dependencies.vinext,undefined);
  assert.match(compose,/postgres:17-alpine/);
  assert.match(compose,/app_uploads:\/app\/data\/uploads/);
  assert.match(schema,/pgTable\("users"/);
  assert.match(schema,/passwordHash/);
  assert.match(auth,/HttpOnly|SESSION_COOKIE|jwtVerify/);
  assert.match(files,/UPLOAD_DIR|uploadPath/);
  await assert.rejects(access(new URL("../.openai/hosting.json",import.meta.url)));
});

test("ships a PostgreSQL migration and deployment bootstrap",async()=>{
  const [migration,bootstrap,dockerfile]=await Promise.all([
    readFile(new URL("../drizzle/0000_puzzling_pet_avengers.sql",import.meta.url),"utf8"),
    readFile(new URL("../scripts/bootstrap.mjs",import.meta.url),"utf8"),
    readFile(new URL("../Dockerfile",import.meta.url),"utf8"),
  ]);
  for(const table of ["users","purchase_orders","inventory","inventory_lots","inventory_movements","order_images","audit_logs"]){
    assert.match(migration,new RegExp(`CREATE TABLE "${table}"`));
  }
  assert.match(bootstrap,/_junjun_migrations/);
  assert.match(bootstrap,/ADMIN_PASSWORD/);
  assert.match(dockerfile,/node scripts\/bootstrap\.mjs && node server\.js/);
});

test("documents every PostgreSQL column with a Chinese comment",async()=>{
  const [schemaMigration,commentMigration]=await Promise.all([
    readFile(new URL("../drizzle/0000_puzzling_pet_avengers.sql",import.meta.url),"utf8"),
    readFile(new URL("../drizzle/0001_add_chinese_column_comments.sql",import.meta.url),"utf8"),
  ]);
  const columns=new Set();
  for(const tableMatch of schemaMigration.matchAll(/CREATE TABLE "([^"]+)" \(([\s\S]*?)\r?\n\);/g)){
    for(const columnMatch of tableMatch[2].matchAll(/^\s*"([^"]+)"\s/gm)){
      columns.add(`${tableMatch[1]}.${columnMatch[1]}`);
    }
  }
  const comments=new Map(
    [...commentMigration.matchAll(/COMMENT ON COLUMN "([^"]+)"\."([^"]+)" IS '([^']+)';/g)]
      .map(match=>[`${match[1]}.${match[2]}`,match[3]]),
  );
  assert.equal(columns.size,67);
  assert.deepEqual([...comments.keys()].sort(),[...columns].sort());
  for(const comment of comments.values())assert.match(comment,/[\u3400-\u9fff]/);
});

test("administrator inherits purchase-order entry capabilities",async()=>{
  const [page,appRoute]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
  ]);
  assertJsMatch(page,/type AdminTab = [^;]+"upload"/);
  assertJsMatch(page,/role === "admin" && adminTab === "upload"/);
  assertJsMatch(page,/mode="admin"/);
  assertJsMatch(page,/新增采购订单/);
  assert.match(appRoute,/if\(action==="create-order"\)/);
  assert.match(appRoute,/if\(action==="update-order"\)\{\s+requireAdmin\(user\)/);
});

test("administrator can manually receive in-transit orders from order management",async()=>{
  const page=await readFile(new URL("../app/page.tsx",import.meta.url),"utf8");
  assertJsMatch(page,/type Overlay = [^;]+"manual-receive"/);
  assertJsMatch(page,/order\.status === "在途" \? <button[^\n]+手动入库<\/button>/);
  assertJsMatch(page,/function ManualReceiveSheet/);
  assertJsMatch(page,/确认入库并增加库存/);
  assertJsMatch(page,/onSubmit=\{receive\}/);
});

test("order details show persisted images and manual receipt accepts optional screenshots",async()=>{
  const [page,appRoute,imageRoute,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/api/order-images/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(appRoute,/const imageRows=rows\.length\?await db\.select/);
  assert.match(appRoute,/url:`\/api\/files\/\$\{image\.id\}`/);
  assertJsMatch(page,/type OrderImage =/);
  assertJsMatch(page,/function OrderImages/);
  assertJsMatch(page,/<OrderImages images=\{order\.images\}\/>/);
  assertJsMatch(page,/入库截图（选填）/);
  assertJsMatch(page,/onSubmit\(order\.id,location\.trim\(\),files\)/);
  assertJsMatch(page,/uploadOrderFiles\(id,files\)/);
  assert.match(imageRoute,/user\.role!=="admin"&&order\.purchaserId!==user\.id/);
  assertCssMatch(styles,/\.order-images-grid\{/);
  assertCssMatch(styles,/\.receipt-upload\{/);
});

test("administrator can edit orders and batch delete with inventory-safe backend handling",async()=>{
  const [page,appRoute,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assertJsMatch(page,/onDelete=\{deleteOrders\}/);
  assertJsMatch(page,/editing=\{orders\.find\(item=>item\.id===selectedId\)\}/);
  assertJsMatch(page,/currentUser\?\.role==="admin"\?"update-order":"resubmit-order"/);
  assertJsMatch(page,/>编辑<\/button>/);
  assertJsMatch(page,/全选当前结果/);
  assertJsMatch(page,/批量删除/);
  assertJsMatch(page,/function DeleteOrdersSheet/);
  assertJsMatch(page,/此操作不可撤销/);
  assert.match(appRoute,/if\(action==="update-order"\)/);
  assert.match(appRoute,/if\(action==="delete-orders"\)/);
  assert.match(appRoute,/requireAdmin\(user\)/);
  assert.match(appRoute,/tx\.delete\(inventoryMovements\)/);
  assert.match(appRoute,/tx\.delete\(inventoryLots\)/);
  assert.match(appRoute,/tx\.delete\(orderImages\)/);
  assert.match(appRoute,/greatest\(0,\$\{inventory\.quantity\}-\$\{lot\.qty\}\)/);
  assert.match(appRoute,/action:"delete_batch"/);
  assertCssMatch(styles,/\.batch-toolbar\{/);
  assertCssMatch(styles,/\.order-card\.selected\{/);
  assertCssMatch(styles,/\.delete-warning\{/);
});

test("buyers can edit their own purchase orders until receipt",async()=>{
  const [page,appRoute]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
  ]);
  assertJsMatch(page,/const buyerCanEditOrder = \(status:OrderStatus\) => status === "待审核" \|\| status === "在途" \|\| status === "已驳回"/);
  assertJsMatch(page,/<BuyerOrders orders=\{orders\} onOpen=\{openOrder\} onEdit=/);
  assertJsMatch(page,/编辑采购单/);
  assertJsMatch(page,/入库前均可修改并保存/);
  assert.match(appRoute,/const buyerEditableStatuses=\["待审核","在途","已驳回"\] as const/);
  assert.match(appRoute,/order\.purchaserId!==user\.id/);
  assert.match(appRoute,/订单已入库，采购员不能再修改/);
  assert.match(appRoute,/const nextStatus=order\.status==="已驳回"\?"待审核":order\.status/);
});

test("new purchase upload form remounts empty after each create",async()=>{
  const page=await readFile(new URL("../app/page.tsx",import.meta.url),"utf8");
  assertJsMatch(page,/const \[uploadNonce, setUploadNonce\] = useState\(0\)/);
  assertJsMatch(page,/const startNewUpload = \(\) => \{ setSelectedId\(""\); setUploadNonce\(value => value \+ 1\); \}/);
  assertJsMatch(page,/onCreate=\{\(\) => \{startNewUpload\(\);setAdminTab\("upload"\);\}\}/);
  assertJsMatch(page,/onUpload=\{\(\) => \{startNewUpload\(\);setBuyerTab\("upload"\);\}\}/);
  assertJsMatch(page,/if\(tab==="upload"\) startNewUpload\(\); setBuyerTab\(tab\)/);
  assertJsMatch(page,/key=\{`upload-\$\{selectedId \|\| "new"\}-\$\{uploadNonce\}`\}/);
  assertJsMatch(page,/if\(!editing\)\{setSelectedId\(""\);setUploadNonce\(value=>value\+1\);\}/);
  assertJsMatch(page,/className="purchase-form" autoComplete="off"/);
});

test("order lists show purchase logistics while outbound logistics stay administrator-only",async()=>{
  const [page,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assertJsMatch(page,/function PurchaseCourierList/);
  assertJsMatch(page,/<span>采购快递信息<\/span>/);
  assertJsMatch(page,/item\.purchaseCourierCompany/);
  assertJsMatch(page,/value=\{item\.purchaseCourierNo\} label="采购快递单号"/);
  assertJsMatch(page,/\$\{item\.purchaseCourierCompany\}\$\{item\.purchaseCourierNo\}/);
  assertJsMatch(page,/showOutbound&&\(readyToShip\(order\.status\)\|\|order\.status==="已发货"\)&&<OutboundOrderInfo order=\{order\}\/>/);
  assertJsMatch(page,/order\.status!=="已发货"\)return <div className=\{`order-courier outbound/);
  assertJsMatch(page,/<span>发货进度<\/span>/);
  assertJsMatch(page,/件已发货<\/span>/);
  assertJsMatch(page,/function BuyerOrderCard/);
  assertJsMatch(page,/<OrderCard order=\{order\} onOpen=\{onOpen\} showOutbound=\{false\} normalizeStatus=\{false\} actions=/);
  assertJsMatch(page,/<b>\{count\("已入库"\)\}<\/b><span>已入库<\/span>/);
  assertJsMatch(page,/\$\{item\.outboundCourier\?\?""\}/);
  assertJsNotMatch(page,/\$\{o\.outboundCourier\?\?""\}/);
  assertCssMatch(styles,/\.order-courier\{/);
  assertCssMatch(styles,/\.order-courier\.outbound\{/);
});

test("one purchase order supports separate purchase logistics for multiple items",async()=>{
  const [page,appRoute,schema,migration,exportRoute,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../db/schema.ts",import.meta.url),"utf8"),
    readFile(new URL("../drizzle/0007_item_purchase_logistics.sql",import.meta.url),"utf8"),
    readFile(new URL("../app/api/export/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assertJsMatch(page,/type OrderItemDraft = \{[^}]+purchaseCourierCompany:string[^}]+purchaseCourierNo:string\}/);
  assertJsMatch(page,/className="item-purchase-logistics"/);
  assertJsMatch(page,/每个商品可设置不同的采购快递公司与单号/);
  assertJsMatch(page,/items\.some\(item=>item\.purchaseCourierNo\.includes\(value\)\)/);
  assert.match(appRoute,/purchaseCourierCompany:string\(record\.purchaseCourierCompany\)/);
  assert.match(appRoute,/purchaseCourierNo:string\(record\.purchaseCourierNo\)/);
  assert.match(appRoute,/purchaseCourierCompany:item\.purchaseCourierCompany,purchaseCourierNo:item\.purchaseCourierNo/);
  assert.match(schema,/purchaseCourierCompany: text\("purchase_courier_company"\)/);
  assert.match(schema,/purchaseCourierNo: text\("purchase_courier_no"\)/);
  assert.match(migration,/UPDATE "order_items" AS item[\s\S]+orders\."courier_company"[\s\S]+orders\."courier_no"/);
  assert.match(exportRoute,/item\.purchaseCourierCompany\|\|order\.courierCompany,item\.purchaseCourierNo\|\|order\.courierNo/);
  assertCssMatch(styles,/\.item-purchase-logistics\{/);
  assertCssMatch(styles,/\.purchase-courier-list\{/);
});

test("shipped admin order cards show copyable outbound tracking and shipped time",async()=>{
  const [page,appRoute,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assertJsMatch(page,/shippedAt\?: string/);
  assertJsMatch(page,/function OutboundOrderInfo/);
  assertJsMatch(page,/item\.outboundCourier\?<CopyNumber value=\{item\.outboundCourier\} label="发货运单号"\/>/);
  assertJsMatch(page,/<span>发货时间<\/span><time>\{dateTime\(item\.shippedAt\)\}<\/time>/);
  assert.match(appRoute,/shippedAt:item\.shippedAt\?\?undefined/);
  assertCssMatch(styles,/\.order-shipment-summary\{/);
  assertCssMatch(styles,/\.order-shipment-product\{/);
  assertCssMatch(styles,/\.order-shipment-detail\{/);
  assertCssMatch(styles,/grid-template-columns:58px minmax\(0,1fr\)/);
});

test("displayed order and courier numbers provide direct copy actions",async()=>{
  const [page,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assertJsMatch(page,/async function copyText\(value:string\)/);
  assertJsMatch(page,/navigator\.clipboard\.writeText\(value\)/);
  assertJsMatch(page,/function CopyButton/);
  assertJsMatch(page,/function CopyNumber/);
  assertJsMatch(page,/label="平台订单号"/);
  assertJsMatch(page,/label="采购快递单号"/);
  assertJsMatch(page,/label="发货运单号"/);
  assertJsMatch(page,/subtitleCopyValue=\{order\.id\}/);
  assertJsMatch(page,/<CopyButton value=\{item\.outboundCourier\} label="发货运单号"\/>/);
  assertCssMatch(styles,/\.copy-button\{/);
  assertCssMatch(styles,/\.copy-button\.copied\{/);
});

test("displayed product SKUs provide direct copy actions",async()=>{
  const [page,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assertJsMatch(page,/function SkuList/);
  assertJsMatch(page,/value=\{item\.sku\} label="商品货号"/);
  assertJsMatch(page,/className="sku-title"/);
  assertJsMatch(page,/className="item-sku-meta"/);
  assert.ok(compactJs(page).includes(compactJs("<SkuList items={match.items}/>")));
  assert.ok(compactJs(page).includes(compactJs("<SkuList items={order.items}/>")));
  assertCssMatch(styles,/\.sku-copy-list\{/);
  assertCssMatch(styles,/\.item-sku-meta\{/);
});

test("order lists provide a floating smooth scroll-to-top action",async()=>{
  const [page,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assertJsMatch(page,/function ScrollToTopButton/);
  assertJsMatch(page,/window\.scrollTo\(\{top:0,behavior:"smooth"\}\)/);
  assert.equal(compactJs(page).match(/<ScrollToTopButton\/>/g)?.length,1);
  assertJsMatch(page,/adminTab === "orders"/);
  assertJsMatch(page,/buyerTab === "mine"/);
  assertCssMatch(styles,/\.scroll-top-button\{/);
  assertCssMatch(styles,/position:fixed/);
  assertCssMatch(styles,/width:52px;height:52px/);
  assertCssMatch(styles,/opacity:\.32/);
  assertCssMatch(styles,/backdrop-filter:blur\(4px\)/);
  assertCssMatch(styles,/touch-action:manipulation/);
  assertCssMatch(styles,/\.scroll-top-button:active\{transform:translateY\(-50%\) scale\(\.92\)/);
});

test("all signed-in roles have a persistent logout entry",async()=>{
  const [page,logoutRoute]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/auth/logout/route.ts",import.meta.url),"utf8"),
  ]);
  assertJsMatch(page,/className="identity-logout" href="\/api\/auth\/logout">退出<\/a>/);
  assert.match(logoutRoute,/location:"\/login"/);
  assert.match(logoutRoute,/clearSessionCookie\(\)/);
});

test("buyer snapshots show shipment status but hide outbound logistics",async()=>{
  const [page,appRoute]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
  ]);
  assertJsMatch(page,/showLocation=\{role === "admin"\}/);
  assertJsMatch(page,/canManage=\{role === "admin"\}/);
  assertJsMatch(page,/showLocation && order\.location && <KeyValue label="库位"/);
  assertJsMatch(page,/showLocation && order\.location && <li>/);
  assertJsMatch(page,/!showLocation&&order\.status==="已入库"&&<li><b>已入库<\/b><span>仓库已完成入库<\/span><\/li>/);
  assertJsMatch(page,/normalizeStatus\?statusLabel\(order\.status\):order\.status/);
  assertJsMatch(page,/canManage\?statusLabel\(order\.status\):order\.status/);
  assertJsMatch(page,/canManage&&item\.shipped&&<div className="item-ship-block">/);
  assertJsMatch(page,/canManage&&readyToShip\(order\.status\)&&!item\.shipped&&<button className="item-ship-button"/);
  assertJsMatch(page,/canManage && order\.status === "待审核"/);
  assertJsMatch(page,/\["全部","待审核","在途","已入库","已发货","已驳回"\]/);
  assertJsNotMatch(page,/\["全部","待审核","在途","待发货","已发货"\]/);
  for(const overlay of ["receipt","scan","manual-receive","reject","ship"]){
    assertJsMatch(page,new RegExp(`role === "admin" && overlay === "${overlay}"`));
  }
  assert.match(appRoute,/!isAdmin&&derived==="待发货"\?"已入库":derived/);
  assert.match(appRoute,/\.\.\.\(isAdmin\?\{/);
  assert.match(appRoute,/outboundCompany:item\.outboundCompany\?\?undefined,outboundCourier:item\.outboundCourierNo\?\?undefined/);
  assert.doesNotMatch(appRoute,/location:row\.location\?\?undefined/);
});

test("administrator ships each order item individually with resale details",async()=>{
  const [page,appRoute,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assertJsMatch(page,/const readyToShip = \(status:OrderStatus\) => status === "已入库" \|\| status === "待发货"/);
  assertJsMatch(page,/className="shipping-guide"/);
  assertJsMatch(page,/更新发货信息/);
  assertJsMatch(page,/readyToShip\(order\.status\) \? <button[^\n]+🚚 去发货<\/button>/);
  assertJsMatch(page,/title=\{editingShipping\?"编辑发货信息":"更新发货信息"\}/);
  assertJsMatch(page,/保存发货信息并扣减库存/);
  assertJsMatch(page,/value=\{resalePlatform\} onChange=\{e=>setResalePlatform\(e\.target\.value\)\}/);
  assertJsMatch(page,/<span>二级平台<\/span>/);
  assertJsMatch(page,/<span>二级平台单号（选填）<\/span>/);
  assertJsMatch(page,/<span>预估售价（选填）<\/span>/);
  assertJsMatch(page,/disabled=\{!courier\.trim\(\)\|\|!resolvedCompany\}/);
  assertJsNotMatch(page,/disabled=\{!price/);
  assertJsNotMatch(page,/二手平台/);
  assertJsMatch(page,/item\.outboundCourier\?\?""/);
  assertJsMatch(page,/onSubmit\(item\.id,Boolean\(item\.shipped\),resale,Number\(price\|\|0\),courier\.trim\(\),resolvedCompany,resalePlatform\)/);
  assertJsMatch(page,/onShipItem=\{\(itemId\)/);
  assert.match(appRoute,/resalePlatform:item\.resalePlatform\?\?undefined/);
  assert.match(appRoute,/outboundCompany:item\.outboundCompany\?\?undefined/);
  assert.match(appRoute,/if\(!order\|\|order\.status!=="已入库"\)throw conflict\("订单未入库，不能发货"\)/);
  assert.match(appRoute,/if\(!itemId\|\|!courier\|\|!company\)/);
  assert.match(appRoute,/if\(item\.shippedAt\)throw conflict\("该商品已发货，请勿重复操作"\)/);
  assert.match(appRoute,/resaleOrderNo:resaleNo\|\|null/);
  assert.match(appRoute,/salePriceCents:sale>0\?sale:null/);
  assertCssMatch(styles,/\.shipping-guide\{/);
});

test("administrator can edit shipped logistics and batch ship ready orders atomically",async()=>{
  const [page,appRoute,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assertJsMatch(page,/"update-shipping":"ship"/);
  assertJsMatch(page,/order\.status === "已发货" \? <button[^\n]+编辑发货信息<\/button>/);
  assertJsMatch(page,/function BatchShipSheet/);
  assertJsMatch(page,/统一物流公司，逐笔填写运单号/);
  assertJsMatch(page,/onBatchShip=\{batchShip\}/);
  assertJsMatch(page,/className="batch-ship-button"/);
  assert.match(appRoute,/if\(action==="update-shipping"\)/);
  assert.match(appRoute,/if\(!item\.shippedAt\)throw conflict\("只有已发货商品可以修改发货物流"\)/);
  assert.match(appRoute,/action:"update_shipping"/);
  assert.match(appRoute,/salePriceCents:sale>0\?sale:null,outboundCompany:company/);
  assert.match(appRoute,/before:\{salePriceCents:item\.salePriceCents/);
  assertJsMatch(page,/保存预估售价与发货物流/);
  assert.match(appRoute,/if\(action==="batch-ship"\)/);
  assert.match(appRoute,/await db\.transaction\(async tx=>\{/);
  assert.match(appRoute,/action:"batch_ship"/);
  assert.match(appRoute,/shippedCount:shipments\.length/);
  assertCssMatch(styles,/\.batch-shipment-list\{/);
  assertCssMatch(styles,/\.shipping-edit-action/);
});

test("purchase courier companies are selectable, persisted, and support custom values",async()=>{
  const [page,schema,appRoute,exportRoute,migration]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../db/schema.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/api/export/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../drizzle/0002_add_purchase_courier_company.sql",import.meta.url),"utf8"),
  ]);
  assertJsMatch(page,/const courierCompanies = \["顺丰速运","京东物流","中通快递"/);
  assertJsMatch(page,/<span>采购快递公司 \*<\/span>/);
  assertJsMatch(page,/<option>其他<\/option>/);
  assertJsMatch(page,/<span>其他快递公司/);
  assertJsMatch(page,/purchaseCourierCompany:item\.purchaseCourierCompany/);
  assert.match(schema,/courierCompany: text\("courier_company"\)/);
  assert.match(appRoute,/courierCompany:row\.courierCompany/);
  assert.match(appRoute,/采购快递公司与采购快递单号/);
  assert.match(exportRoute,/"采购快递公司"/);
  assert.match(migration,/ADD COLUMN "courier_company" text DEFAULT '' NOT NULL/);
  assert.match(migration,/采购包裹快递公司/);
});

test("administrator can reset member passwords from the profile page",async()=>{
  const [page,appRoute,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assertJsMatch(page,/function ResetPasswordSheet/);
  assertJsMatch(page,/onResetPassword=\{resetPassword\}/);
  assertJsMatch(page,/mutate\("reset-user-password"/);
  assertJsMatch(page,/>改密<\/button>/);
  assertJsMatch(page,/重置成员密码/);
  assertJsMatch(page,/确认重置密码/);
  assertJsMatch(page,/两次输入不一致/);
  assert.match(appRoute,/if\(action==="reset-user-password"\)/);
  assert.match(appRoute,/password\.length<8/);
  assert.match(appRoute,/passwordHash:await hash\(password,12\)/);
  assert.match(appRoute,/action:"reset_password"/);
  assertCssMatch(styles,/\.field-error/);
});

test("platform order number is optional while purchase courier number is required",async()=>{
  const [page,appRoute,schema,migration,auth]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../db/schema.ts",import.meta.url),"utf8"),
    readFile(new URL("../drizzle/0003_platform_order_no_optional.sql",import.meta.url),"utf8"),
    readFile(new URL("../lib/auth.ts",import.meta.url),"utf8"),
  ]);
  assertJsMatch(page,/平台订单号（选填）/);
  assertJsMatch(page,/className="long-no-input"/);
  assertJsMatch(page,/<span>采购快递单号 \*<\/span>/);
  assertJsMatch(page,/item\.purchaseCourierNo\.trim\(\)/);
  assertJsMatch(page,/平台订单号选填；每个商品需分别填写采购快递公司与快递单号/);
  assertJsMatch(page,/order\.platformNo\|\|"未填写"/);
  assert.match(appRoute,/if\(!platform\)return Response\.json\(\{error:"请填写采购渠道"\}/);
  assert.doesNotMatch(appRoute,/!platformNo/);
  assert.match(appRoute,/if\(platformNo\)\{/);
  assert.match(schema,/uniqueIndex\("idx_orders_platform_order_no"\)\.on\(table\.platform, table\.platformOrderNo\)\.where/);
  assert.match(migration,/CREATE UNIQUE INDEX "idx_orders_platform_order_no"[\s\S]*WHERE "platform_order_no" <> ''/);
  assert.match(auth,/dbError\.code\?\?dbError\.cause\?\.code/);
});

test("one purchase order carries multiple item rows with per-item shipping",async()=>{
  const [page,appRoute,schema,migration,exportRoute]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../db/schema.ts",import.meta.url),"utf8"),
    readFile(new URL("../drizzle/0004_order_items_multi_goods.sql",import.meta.url),"utf8"),
    readFile(new URL("../app/api/export/route.ts",import.meta.url),"utf8"),
  ]);
  assert.match(schema,/export const orderItems = pgTable\("order_items"/);
  assert.match(schema,/orderId: text\("order_id"\)\.notNull\(\)\.references\(\(\) => purchaseOrders\.id\)/);
  assert.match(schema,/itemId: text\("item_id"\)\.primaryKey\(\)\.references\(\(\) => orderItems\.id\)/);
  assert.equal(schema.match(/amountCents: integer\("amount_cents"\)/g)?.length,1);
  assert.match(migration,/CREATE TABLE "order_items"/);
  assert.match(migration,/INSERT INTO "order_items"[\s\S]*FROM "purchase_orders"/);
  assert.match(migration,/ALTER TABLE "purchase_orders" DROP COLUMN "title"/);
  assert.match(migration,/UPDATE "purchase_orders" SET "status" = '已入库' WHERE "status" IN \('待发货','已发货'\)/);
  assert.match(appRoute,/const parseItems=/);
  assert.match(appRoute,/await tx\.insert\(orderItems\)\.values\(items\.map/);
  assert.match(appRoute,/const allShipped=rawItems\.length>0&&rawItems\.every\(item=>item\.shippedAt\)/);
  assert.match(appRoute,/for\(const item of items\)\{[\s\S]*?inventoryLots\)\.values\(\{itemId:item\.id/);
  assert.match(appRoute,/eq\(inventoryLots\.itemId,itemId\)/);
  assertJsMatch(page,/type OrderItem =/);
  assertJsMatch(page,/className="items-editor"/);
  assertJsMatch(page,/className="item-add-button"/);
  assertJsMatch(page,/<b>添加商品<\/b>/);
  assertJsMatch(page,/`商品 \$\{index\+1\}`/);
  assertJsMatch(page,/className="items-total"/);
  assertJsMatch(page,/<h3>商品清单<\/h3>/);
  assertJsMatch(page,/\$\{order\.title\} 等\$\{order\.itemCount\}件商品/);
  assert.match(exportRoute,/itemsByOrder/);
  assert.match(exportRoute,/order\.status==="已入库"\?\(item\.shippedAt\?"已发货":"待发货"\):order\.status/);
});

test("search boxes remember up to ten recent keywords per list in local storage",async()=>{
  const [page,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assertJsMatch(page,/const searchHistoryLimit=10;/);
  assertJsMatch(page,/window\.localStorage\.getItem\(`junjun\.search\.\$\{key\}`\)/);
  assertJsMatch(page,/function Search\(\{ value,onChange,placeholder,historyKey \}/);
  assertJsMatch(page,/\[trimmed,\.\.\.current\.filter\(item=>item!==trimmed\)\]\.slice\(0,searchHistoryLimit\)/);
  assertJsMatch(page,/onBlur=\{\(\)=>\{remember\(value\);window\.setTimeout\(\(\)=>setFocused\(false\),120\);\}\}/);
  assertJsMatch(page,/if\(e\.key==="Enter"\)\{e\.preventDefault\(\);remember\(value\);e\.currentTarget\.blur\(\);\}/);
  assertJsMatch(page,/className="search-history" aria-label="搜索记录"/);
  assertJsMatch(page,/>清空记录<\/button>/);
  assertJsMatch(page,/className="search-history-pick" onMouseDown=\{keepFocus\} onClick=\{\(\)=>\{onChange\(term\);remember\(term\);setFocused\(false\);\}\}/);
  assertJsMatch(page,/aria-label=\{`删除记录 \$\{term\}`\}/);
  for(const key of ["admin-orders","buyer-orders","stock"])assertJsMatch(page,new RegExp(`historyKey="${key}"`));
  assertCssMatch(styles,/\.search-history\{position:absolute/);
  assertCssMatch(styles,/\.search-history-remove\{/);
});

test("order list headers summarize both order count and total item quantity",async()=>{
  const page=await readFile(new URL("../app/page.tsx",import.meta.url),"utf8");
  assertJsMatch(page,/const orderListSummary = \(list:PurchaseOrder\[\]\) => `\$\{list\.length\} 笔 · \$\{list\.reduce\(\(sum,order\)=>sum\+order\.items\.reduce\(\(qty,item\)=>qty\+item\.qty,0\),0\)\} 件`/);
  assertJsMatch(page,/<SectionHead title="采购订单" note=\{orderListSummary\(visible\)\} \/>/);
  assertJsMatch(page,/<SectionHead title="我的采购订单" note=\{orderListSummary\(visible\)\} \/>/);
  assertJsNotMatch(page,/note=\{`\$\{visible\.length\} 笔`\}/);
});

test("multi-product order card titles show styles and total quantity",async()=>{
  const page=await readFile(new URL("../app/page.tsx",import.meta.url),"utf8");
  assertJsMatch(page,/const totalQuantity=order\.items\.reduce\(\(sum,item\)=>sum\+item\.qty,0\)/);
  assertJsMatch(page,/const listTitle=order\.itemCount>1/);
  assertJsMatch(page,/等\$\{order\.itemCount\}款 · 共\$\{totalQuantity\}件/);
  assertJsMatch(page,/<h4 title=\{listTitle\}>\{listTitle\}<\/h4>/);
});

test("admin batch selection summarizes selected orders and item quantity",async()=>{
  const page=await readFile(new URL("../app/page.tsx",import.meta.url),"utf8");
  assertJsMatch(page,/selectedItemQuantity=selectedOrders\.reduce\(\(sum,order\)=>sum\+order\.items\.reduce\(\(qty,item\)=>qty\+item\.qty,0\),0\)/);
  assertJsMatch(page,/已选择 \$\{selectedIds\.length\} 笔 · 共 \$\{selectedItemQuantity\} 件/);
});

test("order entry recognizes screenshots through a vision model and prefills the form",async()=>{
  const [page,vision,route,styles,envExample,compose]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../lib/vision.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/api/orders/recognize/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
    readFile(new URL("../.env.example",import.meta.url),"utf8"),
    readFile(new URL("../compose.yaml",import.meta.url),"utf8"),
  ]);
  assert.match(vision,/export function extractJson/);
  assert.match(vision,/export function normalizePlatform/);
  assert.match(vision,/export function normalizeCourierCompany/);
  assert.match(vision,/export function normalizeRecognition/);
  assert.match(vision,/export async function recognizeOrderImages/);
  assert.match(vision,/export async function recognizeOrderImage/);
  assert.match(vision,/\$\{base\}\/chat\/completions/);
  assert.match(vision,/type: "image_url", image_url: \{ url: dataUrl \}/);
  assert.match(vision,/AbortSignal\.timeout\(/);
  assert.match(vision,/files\.length > 1 \? 75000 : 45000/);
  assert.match(vision,/一张或多张电商平台/);
  assert.match(vision,/items 必须输出空数组，不要编造商品/);
  assert.match(route,/requireAppUser\(request\)/);
  assert.match(route,/!data\.courierCompany && !data\.courierNo/);
  assert.doesNotMatch(route,/requireAdmin/);
  assert.match(route,/if \(!visionConfigured\(\)\) return Response\.json\(\{ error: "尚未配置智能识图服务，请手动填写订单信息" \}, \{ status: 501 \}\)/);
  assert.match(route,/form\.getAll\("images"\)/);
  assert.match(route,/file\.size > 8 \* 1024 \* 1024/);
  assert.match(route,/\.slice\(0, 3\)/);
  assertJsMatch(page,/type RecognizedOrder =/);
  assertJsMatch(page,/form\.append\("images",file\)/);
  assertJsMatch(page,/fetch\("\/api\/orders\/recognize",\{method:"POST",body:form\}\)/);
  assertJsMatch(page,/className=\{`recognize-zone \$\{recognizing\?"busy":""\}`\}/);
  assertJsMatch(page,/accept="image\/\*" multiple/);
  assertJsMatch(page,/智能识图：上传订单截图自动填写/);
  assertJsMatch(page,/最多 3 张，支持京东 \/ 拼多多 \/ 淘宝 \/ 唯品会 \/ 抖音；同一订单可分段截图/);
  assertJsMatch(page,/<em>此为辅助功能，识图后需核对！<\/em>/);
  assertCssMatch(styles,/\.purchase-form \.recognize-zone em\{/);
  assertJsMatch(page,/const applyRecognizedCourier =/);
  assertJsMatch(page,/if \(data\.courierCompany \|\| data\.courierNo\) setItems\(current => current\.map\(item => applyRecognizedCourier\(item, data\.courierCompany, data\.courierNo\)\)\)/);
  assertJsMatch(page,/const blank = current\.every\(item => !item\.title\.trim\(\) && !item\.sku\.trim\(\) && !item\.size\.trim\(\) && !item\.amount\.trim\(\)\)/);
  assertJsMatch(page,/Array\.from\(incoming \?\? \[\]\)\.filter\(file => file\.type\.startsWith\("image\/"\)\)\.slice\(0, 3\)/);
  assertJsMatch(page,/if \(next\.length >= 3\) break;/);
  assertJsMatch(page,/截图已加入订单附件/);
  assertJsMatch(page,/className="recognize-result failed"/);
  assertCssMatch(styles,/\.purchase-form \.recognize-zone\{/);
  assertCssMatch(styles,/\.recognize-result\.failed\{/);
  for(const key of ["VISION_API_BASE","VISION_API_KEY","VISION_MODEL"]){
    assert.match(envExample,new RegExp(`^${key}=`,"m"));
    assert.match(compose,new RegExp(`${key}: \\$\\{${key}:-\\}`));
  }
});

test("receipt photos use the vision model and look up purchase orders by tracking number",async()=>{
  const [page,vision,route]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../lib/vision.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/api/receipt/ocr/route.ts",import.meta.url),"utf8"),
  ]);
  assert.match(vision,/export const waybillPrompt/);
  assert.match(vision,/export async function recognizeWaybillImage/);
  assert.match(route,/recognizeWaybillImage/);
  assert.match(route,/lookupOrdersByCourierNo/);
  assert.match(route,/visionConfigured\(\)/);
  assert.match(route,/export async function GET/);
  assertJsMatch(page,/fetch\("\/api\/receipt\/ocr",\{method:"POST",body:form\}\)/);
  assertJsMatch(page,/\/api\/receipt\/ocr\?courierNo=/);
  assertJsMatch(page,/findOrdersByCourierNo\(orders, courier\)/);
  assertJsMatch(page,/图片发送到已配置的智能识图服务，识别后按运单号反查采购单/);
  assertJsMatch(page,/关联到 \{receivable\.length\} 笔在途采购订单/);
});

test("administrator can delete buyer accounts only, with confirmation and history protection",async()=>{
  const [page,appRoute,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(appRoute,/if\(action==="delete-user"\)/);
  assert.match(appRoute,/if\(targetId===user\.id\)return Response\.json\(\{error:"不能删除自己的账号"\},\{status:409\}\)/);
  assert.match(appRoute,/if\(target\.role!=="buyer"\)throw conflict\("只能删除采购员账号/);
  assert.match(appRoute,/from\(purchaseOrders\)\.where\(eq\(purchaseOrders\.purchaserId,targetId\)\)/);
  assert.match(appRoute,/from\(orderImages\)\.where\(eq\(orderImages\.uploadedBy,targetId\)\)/);
  assert.match(appRoute,/from\(auditLogs\)\.where\(eq\(auditLogs\.actorId,targetId\)\)/);
  assert.match(appRoute,/throw conflict\("该采购员已有订单或操作记录，无法删除；如需禁止登录请使用「停用」"\)/);
  assert.match(appRoute,/await tx\.delete\(users\)\.where\(eq\(users\.id,targetId\)\)/);
  assert.match(appRoute,/action:"delete_user"/);
  assertJsMatch(page,/mutate\("delete-user",\{userId\}\)/);
  assertJsMatch(page,/onDeleteUser=\{deleteUser\}/);
  assertJsMatch(page,/function DeleteUserSheet/);
  assertJsMatch(page,/className="member-role-select"/);
  assertJsMatch(page,/person\.role==="buyer"&&person\.id!==user\.id&&<button className="member-delete-button"/);
  assertJsMatch(page,/<DeleteUserSheet member=\{deleteTarget\}/);
  assertJsMatch(page,/确定删除该采购员账号？/);
  assertJsMatch(page,/确认删除/);
  assertCssMatch(styles,/\.member-delete-button\{/);
});

test("admin order list filters by multiple purchasers at once",async()=>{
  const [page,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assertJsMatch(page,/const \[buyers,setBuyers\] = useState<string\[\]>\(\[\]\)/);
  assertJsMatch(page,/\(buyers\.length === 0 \|\| buyers\.includes\(order\.purchaser\)\)/);
  assertJsMatch(page,/const toggleBuyer = \(name:string\) => setBuyers\(current => current\.includes\(name\) \? current\.filter\(item => item !== name\) : \[\.\.\.current, name\]\)/);
  assertJsMatch(page,/buyers\.length <= 2 \? buyers\.join\("、"\) : `\$\{buyers\[0\]\} 等 \$\{buyers\.length\} 人`/);
  assertJsMatch(page,/className=\{`buyer-filter-trigger \$\{buyers\.length \? "active" : ""\}/);
  assertJsMatch(page,/className="buyer-filter-panel" role="group"/);
  assertJsMatch(page,/<b>选择采购员<\/b>/);
  assertJsMatch(page,/className="buyer-filter-clear" onClick=\{\(\) => setBuyers\(\[\]\)\}/);
  assertJsMatch(page,/className="buyer-filter-done" onClick=\{\(\) => setBuyerOpen\(false\)\}/);
  assertJsMatch(page,/setStatuses\(\["待发货"\]\);setPlatform\("全部渠道"\);setBuyers\(\[\]\);/);
  assertJsNotMatch(page,/<option>全部采购员<\/option>/);
  assertCssMatch(styles,/\.buyer-filter-trigger\{/);
  assertCssMatch(styles,/\.buyer-filter-options button\.checked\{/);
});

test("admin and buyer order lists filter by multiple statuses at once",async()=>{
  const [page,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assertJsMatch(page,/const matchesStatusFilter = \(order:PurchaseOrder, statuses:string\[\]\) => !statuses\.length \|\| statuses\.some\(/);
  assertJsMatch(page,/const toggleStatusFilter = \(current:string\[\], value:string\) => value === "全部" \? \[\] : current\.includes\(value\)/);
  assertJsMatch(page,/function StatusFilter\(/);
  assertJsMatch(page,/aria-label="按状态筛选，可多选"/);
  assertJsMatch(page,/const \[statuses,setStatuses\] = useState<string\[\]>\(\[\]\)/);
  assertJsMatch(page,/matchesStatusFilter\(order, statuses\)/);
  assertJsMatch(page,/matchesStatusFilter\(o, statuses\)/);
  assertJsMatch(page,/<StatusFilter options=\{\["全部","待审核","在途","待发货","已发货","已驳回"\]\} value=\{statuses\} onChange=\{setStatuses\} \/>/);
  assertJsMatch(page,/<StatusFilter options=\{\["全部","待审核","在途","已入库","已发货","已驳回"\]\} value=\{statuses\} onChange=\{setStatuses\} \/>/);
  assertJsMatch(page,/className="status-filter-clear" onClick=\{\(\) => onChange\(\[\]\)\}/);
  assertJsMatch(page,/className="status-filter-summary" role="status" aria-live="polite"/);
  assertJsMatch(page,/className="status-filter-values" aria-label="已选择的状态"/);
  assertCssMatch(styles,/\.status-filter-clear\{/);
  assertCssMatch(styles,/\.status-filter-summary\{/);
  assertCssMatch(styles,/\.status-filter-copy em\{/);
  assertCssMatch(styles,/\.status-filter-values>span\{/);
});

test("manual receipt offers recently used locations as one-tap choices",async()=>{
  const [page,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assertJsMatch(page,/const recentLocations = useMemo\(/);
  assertJsMatch(page,/\.sort\(\(a, b\) => \(b\.receivedAt \?\? ""\)\.localeCompare\(a\.receivedAt \?\? ""\)\)/);
  assertJsMatch(page,/\.slice\(0, 12\), \[orders\]\)/);
  assertJsMatch(page,/<ManualReceiveSheet order=\{selected\} recentLocations=\{recentLocations\}/);
  assertJsMatch(page,/<ReceiptSheet orders=\{orders\} recentLocations=\{recentLocations\}/);
  assertJsMatch(page,/<ScanSheet orders=\{orders\} recentLocations=\{recentLocations\}/);
  assertJsMatch(page,/function LocationPicker\(\{ location, recentLocations, onChange \}/);
  assertJsMatch(page,/function ManualReceiveSheet\(\{order,recentLocations,onClose,onSubmit\}/);
  assertJsMatch(page,/recentLocations\.length>0&&<div className="location-history">/);
  assertJsMatch(page,/<div className="location-history-head"><i>📍<\/i><b>历史库位<\/b>/);
  assertJsMatch(page,/className=\{item===activeLocation\?"active":""\} aria-pressed=\{item===activeLocation\} onClick=\{\(\)=>onChange\(item\)\}>\{index===0&&<em>最近<\/em>\}<span>\{item\}<\/span>/);
  assertJsMatch(page,/<LocationPicker location=\{location\} recentLocations=\{recentLocations\} onChange=\{setLocation\}\/>/);
  assertCssMatch(styles,/\.location-history\{/);
  assertCssMatch(styles,/\.location-history-head\{/);
  assertCssMatch(styles,/\.location-chips button:before\{/);
  assertCssMatch(styles,/\.location-chips button\.active\{/);
});

test("administrator can revert a received order back to in-transit and roll back inventory",async()=>{
  const [page,appRoute,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(appRoute,/if\(action==="revert-receive"\)/);
  assert.match(appRoute,/requireAdmin\(user\);const id=string\(body\.orderId\)/);
  assert.match(appRoute,/if\(order\.status!=="已入库"\)throw conflict\("只有已入库订单可以退回在途"\)/);
  assert.match(appRoute,/if\(items\.some\(item=>item\.shippedAt\)\)throw conflict\("订单内已有商品发货，无法退回在途"\)/);
  assert.match(appRoute,/greatest\(0,\$\{inventory\.quantity\}-\$\{lot\.qty\}\)/);
  assert.match(appRoute,/changeQty:-lot\.qty,type:"adjust"/);
  assert.match(appRoute,/tx\.delete\(inventoryLots\)\.where\(eq\(inventoryLots\.orderId,id\)\)/);
  assert.match(appRoute,/status:"在途",receivedAt:null,location:null/);
  assert.match(appRoute,/action:"revert_receive"/);
  assertJsMatch(page,/type Overlay = [^;]+"revert-receive"/);
  assertJsMatch(page,/mutate\("revert-receive",\{orderId:id\}\)/);
  assertJsMatch(page,/订单已退回在途，库存已回滚/);
  assertJsMatch(page,/function RevertReceiveSheet/);
  assertJsMatch(page,/role === "admin" && overlay === "revert-receive"/);
  assertJsMatch(page,/canManage && !order\.settled && readyToShip\(order\.status\) && !order\.items\.some\(item=>item\.shipped\) && <button className="revert-receive-button"/);
  assertJsMatch(page,/确认退回在途/);
  assertCssMatch(styles,/\.revert-receive-button\{/);
  assertCssMatch(styles,/\.revert-warning\{/);
});

test("purchase settlement records a manual or recognized amount, supports an optional proof, and stays independent from shipping",async()=>{
  const [page,appRoute,settlementRoute,proofRoute,recognizeRoute,vision,schema,migration,proofMigration,amountMigration,exportRoute,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/api/settlements/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/api/settlements/proof/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/api/settlements/recognize/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../lib/vision.ts",import.meta.url),"utf8"),
    readFile(new URL("../db/schema.ts",import.meta.url),"utf8"),
    readFile(new URL("../drizzle/0009_purchase_order_settlement.sql",import.meta.url),"utf8"),
    readFile(new URL("../drizzle/0010_settlement_proof_image.sql",import.meta.url),"utf8"),
    readFile(new URL("../drizzle/0011_settlement_amount.sql",import.meta.url),"utf8"),
    readFile(new URL("../app/api/export/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(schema,/settled: boolean\("settled"\)\.notNull\(\)\.default\(false\)/);
  assert.match(schema,/settledAt: timestamp\("settled_at"/);
  assert.match(schema,/settledBy: text\("settled_by"\)\.references\(\(\) => users\.id\)/);
  assert.match(migration,/ADD COLUMN "settled" boolean DEFAULT false NOT NULL/);
  assert.match(migration,/采购款结算状态，独立于发货状态/);
  assert.match(schema,/settledAmountCents: integer\("settled_amount_cents"\)/);
  assert.match(amountMigration,/ADD COLUMN "settled_amount_cents" integer/);
  assert.match(amountMigration,/CHECK \("settled_amount_cents" IS NULL OR "settled_amount_cents" > 0\)/);
  assert.match(appRoute,/settled:row\.settled,settledAt:row\.settledAt\?\?undefined,settledAmount:row\.settledAmountCents==null\?undefined:row\.settledAmountCents\/100,receivedAt:row\.receivedAt\?\?undefined/);
  assert.match(appRoute,/if\(action==="settle-order"\)/);
  assert.match(appRoute,/if\(!order\.receivedAt\)throw conflict\("采购单尚未入库，不能结款"\)/);
  assert.match(appRoute,/set\(\{settled:true,settledAt:timestamp,settledBy:user\.id,settledAmountCents,updatedAt:timestamp\}\)/);
  assert.match(appRoute,/action:"settle"/);
  assert.match(appRoute,/if\(order\.settled\)throw conflict\("订单已结款，不能再驳回"\)/);
  assert.match(appRoute,/if\(order\.settled\)throw conflict\("订单已结款，不能撤销入库"\)/);
  assert.match(schema,/kind: text\("kind", \{ enum: \["order", "settlement"\] \}\)\.notNull\(\)\.default\("order"\)/);
  assert.match(proofMigration,/ADD COLUMN "kind" text DEFAULT 'order' NOT NULL/);
  assert.match(proofMigration,/CHECK \("kind" IN \('order', 'settlement'\)\)/);
  assert.match(appRoute,/settlementProofs:imageRows\.filter\(image=>image\.orderId===row\.id&&image\.kind==="settlement"\)/);
  const settleBlock=appRoute.slice(appRoute.indexOf('if(action==="settle-order")'),appRoute.indexOf('if(action==="revert-receive")'));
  assert.doesNotMatch(settleBlock,/set\(\{[^}]*status:/);
  const shipBlock=appRoute.slice(appRoute.indexOf('if(action==="ship")'),appRoute.indexOf('if(action==="update-shipping")'));
  assert.doesNotMatch(shipBlock,/settled|settledAt|settledBy/);
  assertJsMatch(page,/type Overlay = [^;]+"settle"/);
  assertJsMatch(page,/fetch\("\/api\/settlements",\{method:"POST",body:form\}\)/);
  assertJsMatch(page,/form\.set\("amount",String\(amount\)\)/);
  assertJsMatch(page,/form\.set\("proofSelected","true"\)/);
  assertJsMatch(page,/form\.append\("proof",proof,proof\.name\)/);
  assertJsMatch(page,/function SettlementStatus/);
  assertJsMatch(page,/order\.receivedAt&&!order\.settled&&<button className="settlement-action"/);
  assertJsMatch(page,/function SettlementSheet/);
  assertJsMatch(page,/结款状态独立记录，不会发货、扣减库存或改变当前发货状态/);
  assertJsMatch(page,/上传结款截图（选填）/);
  assertJsMatch(page,/实际结款金额 <em>必填<\/em>/);
  assertJsMatch(page,/fetch\("\/api\/settlements\/recognize",\{method:"POST",body:form\}\)/);
  assertJsMatch(page,/正在识别结款金额/);
  assertJsMatch(page,/order\.settled&&<OrderImages images=\{order\.settlementProofs\} title="结款截图" variant="settlement"/);
  assertJsMatch(page,/emptyText="本次结款未上传截图"/);
  assertJsMatch(page,/canManage&&order\.receivedAt&&!order\.settled&&<button className="primary-button settlement-confirm-button"/);
  assert.match(settlementRoute,/requireAdmin\(user\)/);
  assert.match(settlementRoute,/form\.get\("proof"\)/);
  assert.match(settlementRoute,/form\.get\("proofSelected"\) === "true" && !proof/);
  assert.match(settlementRoute,/form\.get\("amount"\)/);
  assert.match(settlementRoute,/settledAmountCents: amountCents/);
  assert.match(settlementRoute,/proof\.size > 5 \* 1024 \* 1024/);
  assert.match(settlementRoute,/kind: "settlement"/);
  assert.match(settlementRoute,/if \(!order\.receivedAt\) throw conflict\("采购单尚未入库，不能结款"\)/);
  assert.match(settlementRoute,/proofImageId: image\?\.id \?\? null/);
  assert.match(recognizeRoute,/requireAdmin\(user\)/);
  assert.match(recognizeRoute,/recognizeSettlementImage\(image\)/);
  assert.match(vision,/export const settlementPrompt/);
  assert.match(vision,/不要把账户余额、优惠金额、商品原价/);
  assert.match(vision,/export function normalizeSettlementAmount/);
  assert.match(vision,/export async function recognizeSettlementImage/);
  assert.match(settlementRoute,/if \(storedFile\) await unlink\(storedFile\)/);
  assert.match(proofRoute,/if \(!order\.settled\) throw conflict\("订单尚未结款，不能单独上传结款截图"\)/);
  assert.match(proofRoute,/eq\(orderImages\.kind, "settlement"\)/);
  assert.match(proofRoute,/oldImages\.length \? "replace_settlement_proof" : "add_settlement_proof"/);
  assertJsMatch(page,/type Overlay = [^;]+"settlement-proof"/);
  assertJsMatch(page,/fetch\("\/api\/settlements\/proof",\{method:"POST",body:form\}\)/);
  assertJsMatch(page,/function SettlementProofSheet/);
  assertJsMatch(page,/order\.settlementProofs\.length\?"更换截图":"补传截图"/);
  const proofSettleBlock=settlementRoute.slice(settlementRoute.indexOf("await db.transaction"),settlementRoute.indexOf("storedFile = null"));
  assert.doesNotMatch(proofSettleBlock,/update\(purchaseOrders\)\.set\(\{[^}]*status:/);
  assert.match(exportRoute,/"结款状态","实际结款金额","结款时间"/);
  assert.match(exportRoute,/order\.settled\?"已结款":"未结款"/);
  assertCssMatch(styles,/\.order-settlement\{/);
  assertCssMatch(styles,/\.order-settlement\.settled\{/);
  assertCssMatch(styles,/\.settlement-confirm-card\{/);
  assertCssMatch(styles,/\.settlement-amount-field\{/);
  assertCssMatch(styles,/\.settlement-recognition\.success\{/);
  assertCssMatch(styles,/\.settlement-proof-upload\{/);
  assertCssMatch(styles,/\.settlement-proof-clear\{/);
  assertCssMatch(styles,/\.settlement-proof-gallery\{/);
  assertCssMatch(styles,/\.order-images-empty\{/);
});

test("multi-item entry and detail views carry dedicated visual styles",async()=>{
  const styles=await readFile(new URL("../app/globals.css",import.meta.url),"utf8");
  for(const rule of [".items-editor{",".items-editor-head{",".item-card{",".item-card-head i{",".item-remove{",".item-add-button{",".items-total{",".items-card-head{",".item-row{",".item-index{",".item-row-top{",".item-ship-button{",".item-edit-button{",".item-ship-block{",".item-ship-line{"]){
    assert.ok(compactCss(styles).includes(rule),`missing style rule ${rule}`);
  }
  assertCssMatch(styles,/\.item-row\.shipped \.item-index\{/);
  assertCssMatch(styles,/\.purchase-form input\.long-no-input\{font-size:5px/);
  assertCssMatch(styles,/\.items-editor input\.long-no-input\{font-size:4\.5px/);
  assert.doesNotMatch(compactCss(styles),/\.item-row-main b\{font-size:11\.5px\}/);
});

test("purchase channels are consistent across entry form, admin and buyer order filters",async()=>{
  const page=await readFile(new URL("../app/page.tsx",import.meta.url),"utf8");
  assertJsMatch(page,/const purchaseChannels = \["京东","淘宝","抖音","唯品会","拼多多","其他"\]/);
  assert.equal(compactJs(page).match(/purchaseChannels\.map\(channel=>/g)?.length,2);
  assertJsMatch(page,/\["全部渠道",\.\.\.purchaseChannels\]/);
  assertJsMatch(page,/\(platform === "全部渠道" \|\| o\.platform === platform\)/);
});

test("uses secondary-platform terminology across UI, export, and product documentation",async()=>{
  const files=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/export/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../docs/产品原型文档.html",import.meta.url),"utf8"),
  ]);
  for(const file of files){
    assert.match(file,/二级平台/);
    assert.doesNotMatch(file,/二手平台|二手单号|二手\/潮品平台/);
  }
});

test("visitors can apply for buyer accounts and administrators approve them before login",async()=>{
  const [page,loginPage,registerPage,registerRoute,loginRoute,appRoute,schema,migration,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/login/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/register/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/auth/register/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/api/auth/login/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../db/schema.ts",import.meta.url),"utf8"),
    readFile(new URL("../drizzle/0005_buyer_account_approval.sql",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(loginPage,/className="register-entry" href="\/register"/);
  assert.match(loginPage,/<b>申请采购员账号<\/b>/);
  assert.match(loginPage,/填写资料，管理员审批后即可登录/);
  assert.match(registerPage,/申请采购员账号/);
  assert.match(registerPage,/name="phone" type="tel" required/);
  assert.match(registerPage,/提交申请/);
  assert.match(registerRoute,/approvalStatus:"pending"/);
  assert.match(registerRoute,/active:false/);
  assert.match(registerRoute,/\/\^1\[3-9\]\\d\{9\}\$\//);
  assert.match(loginRoute,/user\.approvalStatus==="pending"/);
  assert.match(loginRoute,/等待管理员审批/);
  assert.match(appRoute,/if\(action==="review-user-application"\)/);
  assert.match(appRoute,/approve_user_application/);
  assert.match(appRoute,/reject_user_application/);
  assertJsMatch(page,/<SectionHead title="采购员申请"/);
  assertJsMatch(page,/onReview=\{\(userId,decision\)=>void run\("review-user-application"/);
  assertJsMatch(page,/\?"通过":"重新通过"/);
  assertJsMatch(page,/name="phone" type="tel" required/);
  assert.match(schema,/phone: text\("phone"\)/);
  assert.match(schema,/approvalStatus: text\("approval_status"/);
  assert.match(migration,/ADD COLUMN "approval_status" text DEFAULT 'approved' NOT NULL/);
  assert.match(migration,/CREATE UNIQUE INDEX "idx_users_phone"/);
  assertCssMatch(styles,/\.application-list\{/);
  assertCssMatch(styles,/\.register-success\{/);
  assertCssMatch(styles,/\.login-apply\{/);
  assertCssMatch(styles,/\.register-entry>i\{/);
});

test("wechat ID replaces email as the account login identifier",async()=>{
  const [loginPage,registerPage,loginRoute,registerRoute,appRoute,schema,migration,bootstrap,compose,envExample]=await Promise.all([
    readFile(new URL("../app/login/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/register/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/auth/login/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/api/auth/register/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../db/schema.ts",import.meta.url),"utf8"),
    readFile(new URL("../drizzle/0006_login_wechat_id.sql",import.meta.url),"utf8"),
    readFile(new URL("../scripts/bootstrap.mjs",import.meta.url),"utf8"),
    readFile(new URL("../compose.yaml",import.meta.url),"utf8"),
    readFile(new URL("../.env.example",import.meta.url),"utf8"),
  ]);
  assert.match(loginPage,/<span>微信号<\/span><input name="wechatId"/);
  assert.doesNotMatch(loginPage,/name="email"|type="email"/);
  assert.match(registerPage,/<span>微信号<\/span><input name="wechatId"/);
  assert.doesNotMatch(registerPage,/登录邮箱|name="email"/);
  assert.match(loginRoute,/users\.wechatId/);
  assert.match(registerRoute,/wechatId=string\(body\.wechatId\)\.toLowerCase\(\)/);
  assert.match(registerRoute,/\^\[a-z\]\[a-z0-9_-\]\{5,19\}\$/);
  assert.match(appRoute,/wechatId:person\.wechatId/);
  assert.match(schema,/wechatId: text\("wechat_id"\)/);
  assert.match(schema,/idx_users_wechat_id/);
  assert.match(migration,/RENAME COLUMN "email" TO "wechat_id"/);
  assert.match(migration,/RENAME TO "idx_users_wechat_id"/);
  assert.match(bootstrap,/process\.env\.ADMIN_WECHAT_ID\|\|process\.env\.ADMIN_EMAIL/);
  assert.match(compose,/ADMIN_WECHAT_ID/);
  assert.match(envExample,/ADMIN_WECHAT_ID=junjun_admin/);
});

test("administrator order views show copyable purchaser phone and wechat ID",async()=>{
  const [page,appRoute,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(appRoute,/purchaserPhone:phones\.get\(row\.purchaserId\)/);
  assert.match(appRoute,/purchaserWechatId:wechatIds\.get\(row\.purchaserId\)/);
  assert.match(appRoute,/\.\.\.\(isAdmin\?\{purchaserPhone:/);
  assertJsMatch(page,/showPurchaserContact/);
  assertJsMatch(page,/<span>采购员联系方式<\/span>/);
  assertJsMatch(page,/label="采购员微信号"/);
  assertJsMatch(page,/label="采购员手机号"/);
  assertJsMatch(page,/<KeyValue label="采购员微信号"[^>]+copyValue=\{order\.purchaserWechatId\}/);
  assertJsMatch(page,/<KeyValue label="采购员手机号"[^>]+copyValue=\{order\.purchaserPhone\}/);
  assertJsMatch(page,/canManage&&order\.purchaserWechatId/);
  assertCssMatch(styles,/\.order-contact\{/);
});
