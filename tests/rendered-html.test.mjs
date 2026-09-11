import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("touch forms prevent small-font focus zoom without blocking pinch zoom", async () => {
  const css = await readFile(new URL("../app/touch-forms.css", import.meta.url), "utf8");
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /import "\.\/touch-forms\.css"/);
  assert.match(css, /@media \(any-pointer: coarse\)/);
  assert.match(css, /input:not\(/);
  assert.match(css, /textarea,\s*select\s*\{/);
  assert.match(css, /font-size: 16px !important/);
  assert.doesNotMatch(layout, /userScalable:\s*false|maximumScale:\s*1\b/);
});

test("form grids shrink and touch buyer filters match native select text", async () => {
  const css = await readFile(new URL("../app/touch-forms.css", import.meta.url), "utf8");
  assert.match(css, /\.field-grid\s*\{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.field-grid > label\s*\{\s*min-width: 0/);
  assert.match(css, /\.field-grid select\s*\{\s*width: 100%;\s*min-width: 0/);
  assert.match(css, /\.select-row \.buyer-filter-trigger\s*\{\s*font-size: 16px/);
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
  assert.match(page,/type AdminTab = [^;]+"upload"/);
  assert.match(page,/role === "admin" && adminTab === "upload"/);
  assert.match(page,/mode="admin"/);
  assert.match(page,/新增采购订单/);
  assert.match(appRoute,/if\(action==="create-order"\)/);
  assert.match(appRoute,/if\(action==="update-order"\)\{\s+requireAdmin\(user\)/);
});

test("administrator can manually receive in-transit orders from order management",async()=>{
  const page=await readFile(new URL("../app/page.tsx",import.meta.url),"utf8");
  assert.match(page,/type Overlay = [^;]+"manual-receive"/);
  assert.match(page,/order\.status === "在途" \? <button[^\n]+手动入库<\/button>/);
  assert.match(page,/function ManualReceiveSheet/);
  assert.match(page,/确认入库并增加库存/);
  assert.match(page,/onSubmit=\{receive\}/);
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
  assert.match(page,/type OrderImage =/);
  assert.match(page,/function OrderImages/);
  assert.match(page,/<OrderImages images=\{order\.images\}\/>/);
  assert.match(page,/入库截图（选填）/);
  assert.match(page,/onSubmit\(order\.id,location\.trim\(\),files\)/);
  assert.match(page,/uploadOrderFiles\(id,files\)/);
  assert.match(imageRoute,/user\.role!=="admin"&&order\.purchaserId!==user\.id/);
  assert.match(styles,/\.order-images-grid\{/);
  assert.match(styles,/\.receipt-upload\{/);
});

test("administrator can edit orders and batch delete with inventory-safe backend handling",async()=>{
  const [page,appRoute,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(page,/onDelete=\{deleteOrders\}/);
  assert.match(page,/editing=\{orders\.find\(item=>item\.id===selectedId\)\}/);
  assert.match(page,/currentUser\?\.role==="admin"\?"update-order":"resubmit-order"/);
  assert.match(page,/>编辑<\/button>/);
  assert.match(page,/全选当前结果/);
  assert.match(page,/批量删除/);
  assert.match(page,/function DeleteOrdersSheet/);
  assert.match(page,/此操作不可撤销/);
  assert.match(appRoute,/if\(action==="update-order"\)/);
  assert.match(appRoute,/if\(action==="delete-orders"\)/);
  assert.match(appRoute,/requireAdmin\(user\)/);
  assert.match(appRoute,/tx\.delete\(inventoryMovements\)/);
  assert.match(appRoute,/tx\.delete\(inventoryLots\)/);
  assert.match(appRoute,/tx\.delete\(orderImages\)/);
  assert.match(appRoute,/greatest\(0,\$\{inventory\.quantity\}-\$\{lot\.qty\}\)/);
  assert.match(appRoute,/action:"delete_batch"/);
  assert.match(styles,/\.batch-toolbar\{/);
  assert.match(styles,/\.order-card\.selected\{/);
  assert.match(styles,/\.delete-warning\{/);
});

test("buyers can edit their own purchase orders until receipt",async()=>{
  const [page,appRoute]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
  ]);
  assert.match(page,/const buyerCanEditOrder = \(status:OrderStatus\) => status === "待审核" \|\| status === "在途" \|\| status === "已驳回"/);
  assert.match(page,/<BuyerOrders orders=\{orders\} onOpen=\{openOrder\} onEdit=/);
  assert.match(page,/编辑采购单/);
  assert.match(page,/入库前均可修改并保存/);
  assert.match(appRoute,/const buyerEditableStatuses=\["待审核","在途","已驳回"\] as const/);
  assert.match(appRoute,/order\.purchaserId!==user\.id/);
  assert.match(appRoute,/订单已入库，采购员不能再修改/);
  assert.match(appRoute,/const nextStatus=order\.status==="已驳回"\?"待审核":order\.status/);
});

test("new purchase upload form remounts empty after each create",async()=>{
  const page=await readFile(new URL("../app/page.tsx",import.meta.url),"utf8");
  assert.match(page,/const \[uploadNonce, setUploadNonce\] = useState\(0\)/);
  assert.match(page,/const startNewUpload = \(\) => \{ setSelectedId\(""\); setUploadNonce\(value => value \+ 1\); \}/);
  assert.match(page,/onCreate=\{\(\) => \{startNewUpload\(\);setAdminTab\("upload"\);\}\}/);
  assert.match(page,/onUpload=\{\(\) => \{startNewUpload\(\);setBuyerTab\("upload"\);\}\}/);
  assert.match(page,/if\(tab==="upload"\) startNewUpload\(\); setBuyerTab\(tab\)/);
  assert.match(page,/key=\{`upload-\$\{selectedId \|\| "new"\}-\$\{uploadNonce\}`\}/);
  assert.match(page,/if\(!editing\)\{setSelectedId\(""\);setUploadNonce\(value=>value\+1\);\}/);
  assert.match(page,/className="purchase-form" autoComplete="off"/);
});

test("order lists show purchase logistics while outbound logistics stay administrator-only",async()=>{
  const [page,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(page,/function PurchaseCourierList/);
  assert.match(page,/<span>采购快递信息<\/span>/);
  assert.match(page,/item\.purchaseCourierCompany/);
  assert.match(page,/value=\{item\.purchaseCourierNo\} label="采购快递单号"/);
  assert.match(page,/\$\{item\.purchaseCourierCompany\}\$\{item\.purchaseCourierNo\}/);
  assert.match(page,/showOutbound&&\(readyToShip\(order\.status\)\|\|order\.status==="已发货"\)&&<OutboundOrderInfo order=\{order\}\/>/);
  assert.match(page,/order\.status!=="已发货"\)return <div className=\{`order-courier outbound/);
  assert.match(page,/<span>发货进度<\/span>/);
  assert.match(page,/件已发货<\/span>/);
  assert.match(page,/function BuyerOrderCard/);
  assert.match(page,/<OrderCard order=\{order\} onOpen=\{onOpen\} showOutbound=\{false\} normalizeStatus=\{false\} actions=/);
  assert.match(page,/<b>\{count\("已入库"\)\}<\/b><span>已入库<\/span>/);
  assert.match(page,/\$\{item\.outboundCourier\?\?""\}/);
  assert.doesNotMatch(page,/\$\{o\.outboundCourier\?\?""\}/);
  assert.match(styles,/\.order-courier\{/);
  assert.match(styles,/\.order-courier\.outbound\{/);
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
  assert.match(page,/type OrderItemDraft = \{[^}]+purchaseCourierCompany:string[^}]+purchaseCourierNo:string\}/);
  assert.match(page,/className="item-purchase-logistics"/);
  assert.match(page,/每个商品可设置不同的采购快递公司与单号/);
  assert.match(page,/items\.some\(item=>item\.purchaseCourierNo\.includes\(value\)\)/);
  assert.match(appRoute,/purchaseCourierCompany:string\(record\.purchaseCourierCompany\)/);
  assert.match(appRoute,/purchaseCourierNo:string\(record\.purchaseCourierNo\)/);
  assert.match(appRoute,/purchaseCourierCompany:item\.purchaseCourierCompany,purchaseCourierNo:item\.purchaseCourierNo/);
  assert.match(schema,/purchaseCourierCompany: text\("purchase_courier_company"\)/);
  assert.match(schema,/purchaseCourierNo: text\("purchase_courier_no"\)/);
  assert.match(migration,/UPDATE "order_items" AS item[\s\S]+orders\."courier_company"[\s\S]+orders\."courier_no"/);
  assert.match(exportRoute,/item\.purchaseCourierCompany\|\|order\.courierCompany,item\.purchaseCourierNo\|\|order\.courierNo/);
  assert.match(styles,/\.item-purchase-logistics\{/);
  assert.match(styles,/\.purchase-courier-list\{/);
});

test("shipped admin order cards show copyable outbound tracking and shipped time",async()=>{
  const [page,appRoute,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(page,/shippedAt\?: string/);
  assert.match(page,/function OutboundOrderInfo/);
  assert.match(page,/item\.outboundCourier\?<CopyNumber value=\{item\.outboundCourier\} label="发货运单号"\/>/);
  assert.match(page,/<span>发货时间<\/span><time>\{dateTime\(item\.shippedAt\)\}<\/time>/);
  assert.match(appRoute,/shippedAt:item\.shippedAt\?\?undefined/);
  assert.match(styles,/\.order-shipment-summary\{/);
  assert.match(styles,/\.order-shipment-product\{/);
  assert.match(styles,/\.order-shipment-detail\{/);
  assert.match(styles,/grid-template-columns:58px minmax\(0,1fr\)/);
});

test("displayed order and courier numbers provide direct copy actions",async()=>{
  const [page,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(page,/async function copyText\(value:string\)/);
  assert.match(page,/navigator\.clipboard\.writeText\(value\)/);
  assert.match(page,/function CopyButton/);
  assert.match(page,/function CopyNumber/);
  assert.match(page,/label="平台订单号"/);
  assert.match(page,/label="采购快递单号"/);
  assert.match(page,/label="发货运单号"/);
  assert.match(page,/subtitleCopyValue=\{order\.id\}/);
  assert.match(page,/<CopyButton value=\{item\.outboundCourier\} label="发货运单号"\/>/);
  assert.match(styles,/\.copy-button\{/);
  assert.match(styles,/\.copy-button\.copied\{/);
});

test("displayed product SKUs provide direct copy actions",async()=>{
  const [page,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(page,/function SkuList/);
  assert.match(page,/value=\{item\.sku\} label="商品货号"/);
  assert.match(page,/className="sku-title"/);
  assert.match(page,/className="item-sku-meta"/);
  assert.ok(page.includes("<SkuList items={match.items}/>"));
  assert.ok(page.includes("<SkuList items={order.items}/>"));
  assert.match(styles,/\.sku-copy-list\{/);
  assert.match(styles,/\.item-sku-meta\{/);
});

test("order lists provide a floating smooth scroll-to-top action",async()=>{
  const [page,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(page,/function ScrollToTopButton/);
  assert.match(page,/window\.scrollTo\(\{top:0,behavior:"smooth"\}\)/);
  assert.equal(page.match(/<ScrollToTopButton\/>/g)?.length,1);
  assert.match(page,/adminTab === "orders"/);
  assert.match(page,/buyerTab === "mine"/);
  assert.match(styles,/\.scroll-top-button\{/);
  assert.match(styles,/position:fixed/);
  assert.match(styles,/opacity:\.32/);
  assert.match(styles,/backdrop-filter:blur\(4px\)/);
});

test("all signed-in roles have a persistent logout entry",async()=>{
  const [page,logoutRoute]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/auth/logout/route.ts",import.meta.url),"utf8"),
  ]);
  assert.match(page,/className="identity-logout" href="\/api\/auth\/logout">退出<\/a>/);
  assert.match(logoutRoute,/location:"\/login"/);
  assert.match(logoutRoute,/clearSessionCookie\(\)/);
});

test("buyer snapshots show shipment status but hide outbound logistics",async()=>{
  const [page,appRoute]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
  ]);
  assert.match(page,/showLocation=\{role === "admin"\}/);
  assert.match(page,/canManage=\{role === "admin"\}/);
  assert.match(page,/showLocation && order\.location && <KeyValue label="库位"/);
  assert.match(page,/showLocation && order\.location && <li>/);
  assert.match(page,/!showLocation&&order\.status==="已入库"&&<li><b>已入库<\/b><span>仓库已完成入库<\/span><\/li>/);
  assert.match(page,/normalizeStatus\?statusLabel\(order\.status\):order\.status/);
  assert.match(page,/canManage\?statusLabel\(order\.status\):order\.status/);
  assert.match(page,/canManage&&item\.shipped&&<div className="item-ship-block">/);
  assert.match(page,/canManage&&readyToShip\(order\.status\)&&!item\.shipped&&<button className="item-ship-button"/);
  assert.match(page,/canManage && order\.status === "待审核"/);
  assert.match(page,/\["全部","待审核","在途","已入库","已发货","已驳回"\]/);
  assert.doesNotMatch(page,/\["全部","待审核","在途","待发货","已发货"\]/);
  for(const overlay of ["receipt","scan","manual-receive","reject","ship"]){
    assert.match(page,new RegExp(`role === "admin" && overlay === "${overlay}"`));
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
  assert.match(page,/const readyToShip = \(status:OrderStatus\) => status === "已入库" \|\| status === "待发货"/);
  assert.match(page,/className="shipping-guide"/);
  assert.match(page,/更新发货信息/);
  assert.match(page,/readyToShip\(order\.status\) \? <button[^\n]+🚚 去发货<\/button>/);
  assert.match(page,/title=\{editingShipping\?"编辑发货信息":"更新发货信息"\}/);
  assert.match(page,/保存发货信息并扣减库存/);
  assert.match(page,/value=\{resalePlatform\} onChange=\{e=>setResalePlatform\(e\.target\.value\)\}/);
  assert.match(page,/<span>二级平台<\/span>/);
  assert.match(page,/<span>二级平台单号（选填）<\/span>/);
  assert.match(page,/<span>预估售价（选填）<\/span>/);
  assert.match(page,/disabled=\{!courier\.trim\(\)\|\|!resolvedCompany\}/);
  assert.doesNotMatch(page,/disabled=\{!price/);
  assert.doesNotMatch(page,/二手平台/);
  assert.match(page,/item\.outboundCourier\?\?""/);
  assert.match(page,/onSubmit\(item\.id,Boolean\(item\.shipped\),resale,Number\(price\|\|0\),courier\.trim\(\),resolvedCompany,resalePlatform\)/);
  assert.match(page,/onShipItem=\{\(itemId\)/);
  assert.match(appRoute,/resalePlatform:item\.resalePlatform\?\?undefined/);
  assert.match(appRoute,/outboundCompany:item\.outboundCompany\?\?undefined/);
  assert.match(appRoute,/if\(!order\|\|order\.status!=="已入库"\)throw conflict\("订单未入库，不能发货"\)/);
  assert.match(appRoute,/if\(!itemId\|\|!courier\|\|!company\)/);
  assert.match(appRoute,/if\(item\.shippedAt\)throw conflict\("该商品已发货，请勿重复操作"\)/);
  assert.match(appRoute,/resaleOrderNo:resaleNo\|\|null/);
  assert.match(appRoute,/salePriceCents:sale>0\?sale:null/);
  assert.match(styles,/\.shipping-guide\{/);
});

test("administrator can edit shipped logistics and batch ship ready orders atomically",async()=>{
  const [page,appRoute,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(page,/"update-shipping":"ship"/);
  assert.match(page,/order\.status === "已发货" \? <button[^\n]+编辑发货信息<\/button>/);
  assert.match(page,/function BatchShipSheet/);
  assert.match(page,/统一物流公司，逐笔填写运单号/);
  assert.match(page,/onBatchShip=\{batchShip\}/);
  assert.match(page,/className="batch-ship-button"/);
  assert.match(appRoute,/if\(action==="update-shipping"\)/);
  assert.match(appRoute,/if\(!item\.shippedAt\)throw conflict\("只有已发货商品可以修改发货物流"\)/);
  assert.match(appRoute,/action:"update_shipping"/);
  assert.match(appRoute,/salePriceCents:sale>0\?sale:null,outboundCompany:company/);
  assert.match(appRoute,/before:\{salePriceCents:item\.salePriceCents/);
  assert.match(page,/保存预估售价与发货物流/);
  assert.match(appRoute,/if\(action==="batch-ship"\)/);
  assert.match(appRoute,/await db\.transaction\(async tx=>\{/);
  assert.match(appRoute,/action:"batch_ship"/);
  assert.match(appRoute,/shippedCount:shipments\.length/);
  assert.match(styles,/\.batch-shipment-list\{/);
  assert.match(styles,/\.shipping-edit-action/);
});

test("purchase courier companies are selectable, persisted, and support custom values",async()=>{
  const [page,schema,appRoute,exportRoute,migration]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../db/schema.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/api/export/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../drizzle/0002_add_purchase_courier_company.sql",import.meta.url),"utf8"),
  ]);
  assert.match(page,/const courierCompanies = \["顺丰速运","京东物流","中通快递"/);
  assert.match(page,/<span>采购快递公司 \*<\/span>/);
  assert.match(page,/<option>其他<\/option>/);
  assert.match(page,/<span>其他快递公司/);
  assert.match(page,/purchaseCourierCompany:item\.purchaseCourierCompany/);
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
  assert.match(page,/function ResetPasswordSheet/);
  assert.match(page,/onResetPassword=\{resetPassword\}/);
  assert.match(page,/mutate\("reset-user-password"/);
  assert.match(page,/>改密<\/button>/);
  assert.match(page,/重置成员密码/);
  assert.match(page,/确认重置密码/);
  assert.match(page,/两次输入不一致/);
  assert.match(appRoute,/if\(action==="reset-user-password"\)/);
  assert.match(appRoute,/password\.length<8/);
  assert.match(appRoute,/passwordHash:await hash\(password,12\)/);
  assert.match(appRoute,/action:"reset_password"/);
  assert.match(styles,/\.field-error/);
});

test("platform order number is optional while purchase courier number is required",async()=>{
  const [page,appRoute,schema,migration,auth]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/api/app/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../db/schema.ts",import.meta.url),"utf8"),
    readFile(new URL("../drizzle/0003_platform_order_no_optional.sql",import.meta.url),"utf8"),
    readFile(new URL("../lib/auth.ts",import.meta.url),"utf8"),
  ]);
  assert.match(page,/平台订单号（选填）/);
  assert.match(page,/<span>采购快递单号 \*<\/span>/);
  assert.match(page,/item\.purchaseCourierNo\.trim\(\)/);
  assert.match(page,/平台订单号选填；每个商品需分别填写采购快递公司与快递单号/);
  assert.match(page,/order\.platformNo\|\|"未填写"/);
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
  assert.match(page,/type OrderItem =/);
  assert.match(page,/className="items-editor"/);
  assert.match(page,/className="item-add-button"/);
  assert.match(page,/<b>添加商品<\/b>/);
  assert.match(page,/`商品 \$\{index\+1\}`/);
  assert.match(page,/className="items-total"/);
  assert.match(page,/<h3>商品清单<\/h3>/);
  assert.match(page,/\$\{order\.title\} 等\$\{order\.itemCount\}件商品/);
  assert.match(exportRoute,/itemsByOrder/);
  assert.match(exportRoute,/order\.status==="已入库"\?\(item\.shippedAt\?"已发货":"待发货"\):order\.status/);
});

test("search boxes remember up to ten recent keywords per list in local storage",async()=>{
  const [page,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(page,/const searchHistoryLimit=10;/);
  assert.match(page,/window\.localStorage\.getItem\(`junjun\.search\.\$\{key\}`\)/);
  assert.match(page,/function Search\(\{ value,onChange,placeholder,historyKey \}/);
  assert.match(page,/\[trimmed,\.\.\.current\.filter\(item=>item!==trimmed\)\]\.slice\(0,searchHistoryLimit\)/);
  assert.match(page,/onBlur=\{\(\)=>\{remember\(value\);window\.setTimeout\(\(\)=>setFocused\(false\),120\);\}\}/);
  assert.match(page,/if\(e\.key==="Enter"\)\{e\.preventDefault\(\);remember\(value\);e\.currentTarget\.blur\(\);\}/);
  assert.match(page,/className="search-history" aria-label="搜索记录"/);
  assert.match(page,/>清空记录<\/button>/);
  assert.match(page,/className="search-history-pick" onMouseDown=\{keepFocus\} onClick=\{\(\)=>\{onChange\(term\);remember\(term\);setFocused\(false\);\}\}/);
  assert.match(page,/aria-label=\{`删除记录 \$\{term\}`\}/);
  for(const key of ["admin-orders","buyer-orders","stock"])assert.match(page,new RegExp(`historyKey="${key}"`));
  assert.match(styles,/\.search-history\{position:absolute/);
  assert.match(styles,/\.search-history-remove\{/);
});

test("order list headers summarize both order count and total item quantity",async()=>{
  const page=await readFile(new URL("../app/page.tsx",import.meta.url),"utf8");
  assert.match(page,/const orderListSummary = \(list:PurchaseOrder\[\]\) => `\$\{list\.length\} 笔 · \$\{list\.reduce\(\(sum,order\)=>sum\+order\.items\.reduce\(\(qty,item\)=>qty\+item\.qty,0\),0\)\} 件`/);
  assert.match(page,/<SectionHead title="采购订单" note=\{orderListSummary\(visible\)\} \/>/);
  assert.match(page,/<SectionHead title="我的采购订单" note=\{orderListSummary\(visible\)\} \/>/);
  assert.doesNotMatch(page,/note=\{`\$\{visible\.length\} 笔`\}/);
});

test("multi-product order card titles show styles and total quantity",async()=>{
  const page=await readFile(new URL("../app/page.tsx",import.meta.url),"utf8");
  assert.match(page,/const totalQuantity=order\.items\.reduce\(\(sum,item\)=>sum\+item\.qty,0\)/);
  assert.match(page,/const listTitle=order\.itemCount>1/);
  assert.match(page,/等\$\{order\.itemCount\}款 · 共\$\{totalQuantity\}件/);
  assert.match(page,/<h4 title=\{listTitle\}>\{listTitle\}<\/h4>/);
});

test("admin batch selection summarizes selected orders and item quantity",async()=>{
  const page=await readFile(new URL("../app/page.tsx",import.meta.url),"utf8");
  assert.match(page,/selectedItemQuantity=selectedOrders\.reduce\(\(sum,order\)=>sum\+order\.items\.reduce\(\(qty,item\)=>qty\+item\.qty,0\),0\)/);
  assert.match(page,/已选择 \$\{selectedIds\.length\} 笔 · 共 \$\{selectedItemQuantity\} 件/);
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
  assert.match(vision,/export async function recognizeOrderImage/);
  assert.match(vision,/\$\{base\}\/chat\/completions/);
  assert.match(vision,/type: "image_url", image_url: \{ url: dataUrl \}/);
  assert.match(vision,/AbortSignal\.timeout\(/);
  assert.match(route,/requireAppUser\(request\)/);
  assert.doesNotMatch(route,/requireAdmin/);
  assert.match(route,/if \(!visionConfigured\(\)\) return Response\.json\(\{ error: "尚未配置智能识图服务，请手动填写订单信息" \}, \{ status: 501 \}\)/);
  assert.match(route,/image\.size > 8 \* 1024 \* 1024/);
  assert.match(page,/type RecognizedOrder =/);
  assert.match(page,/fetch\("\/api\/orders\/recognize",\{method:"POST",body:form\}\)/);
  assert.match(page,/className=\{`recognize-zone \$\{recognizing\?"busy":""\}`\}/);
  assert.match(page,/智能识图：上传订单截图自动填写/);
  assert.match(page,/<em>此为辅助功能，识图后需核对！<\/em>/);
  assert.match(styles,/\.purchase-form \.recognize-zone em\{/);
  assert.match(page,/setItems\(current=>current\.every\(item=>!item\.title\.trim\(\)&&!item\.sku\.trim\(\)&&!item\.size\.trim\(\)&&!item\.amount\.trim\(\)\)\?drafts:\[\.\.\.current,\.\.\.drafts\]\)/);
  assert.match(page,/setFiles\(current=>current\.length>=3\|\|current\.some\(existing=>existing\.name===file\.name&&existing\.size===file\.size\)\?current:\[\.\.\.current,file\]\)/);
  assert.match(page,/截图已加入订单附件/);
  assert.match(page,/className="recognize-result failed"/);
  assert.match(styles,/\.purchase-form \.recognize-zone\{/);
  assert.match(styles,/\.recognize-result\.failed\{/);
  for(const key of ["VISION_API_BASE","VISION_API_KEY","VISION_MODEL"]){
    assert.match(envExample,new RegExp(`^${key}=`,"m"));
    assert.match(compose,new RegExp(`${key}: \\$\\{${key}:-\\}`));
  }
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
  assert.match(page,/mutate\("delete-user",\{userId\}\)/);
  assert.match(page,/onDeleteUser=\{deleteUser\}/);
  assert.match(page,/function DeleteUserSheet/);
  assert.match(page,/person\.role==="buyer"&&person\.id!==user\.id&&<button className="member-delete-button"/);
  assert.match(page,/<DeleteUserSheet member=\{deleteTarget\}/);
  assert.match(page,/确定删除该采购员账号？/);
  assert.match(page,/确认删除/);
  assert.match(styles,/\.member-delete-button\{/);
});

test("admin order list filters by multiple purchasers at once",async()=>{
  const [page,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(page,/const \[buyers,setBuyers\] = useState<string\[\]>\(\[\]\)/);
  assert.match(page,/\(buyers\.length === 0 \|\| buyers\.includes\(order\.purchaser\)\)/);
  assert.match(page,/const toggleBuyer = \(name:string\) => setBuyers\(current => current\.includes\(name\) \? current\.filter\(item => item !== name\) : \[\.\.\.current, name\]\)/);
  assert.match(page,/buyers\.length <= 2 \? buyers\.join\("、"\) : `\$\{buyers\[0\]\} 等 \$\{buyers\.length\} 人`/);
  assert.match(page,/className=\{`buyer-filter-trigger \$\{buyers\.length \? "active" : ""\}/);
  assert.match(page,/className="buyer-filter-panel" role="group"/);
  assert.match(page,/<b>选择采购员<\/b>/);
  assert.match(page,/className="buyer-filter-clear" onClick=\{\(\) => setBuyers\(\[\]\)\}/);
  assert.match(page,/className="buyer-filter-done" onClick=\{\(\) => setBuyerOpen\(false\)\}/);
  assert.match(page,/setStatuses\(\["待发货"\]\);setPlatform\("全部渠道"\);setBuyers\(\[\]\);/);
  assert.doesNotMatch(page,/<option>全部采购员<\/option>/);
  assert.match(styles,/\.buyer-filter-trigger\{/);
  assert.match(styles,/\.buyer-filter-options button\.checked\{/);
});

test("admin and buyer order lists filter by multiple statuses at once",async()=>{
  const [page,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(page,/const matchesStatusFilter = \(order:PurchaseOrder, statuses:string\[\]\) => !statuses\.length \|\| statuses\.some\(/);
  assert.match(page,/const toggleStatusFilter = \(current:string\[\], value:string\) => value === "全部" \? \[\] : current\.includes\(value\)/);
  assert.match(page,/function StatusFilter\(/);
  assert.match(page,/aria-label="按状态筛选，可多选"/);
  assert.match(page,/const \[statuses,setStatuses\] = useState<string\[\]>\(\[\]\)/);
  assert.match(page,/matchesStatusFilter\(order, statuses\)/);
  assert.match(page,/matchesStatusFilter\(o, statuses\)/);
  assert.match(page,/<StatusFilter options=\{\["全部","待审核","在途","待发货","已发货","已驳回"\]\} value=\{statuses\} onChange=\{setStatuses\} \/>/);
  assert.match(page,/<StatusFilter options=\{\["全部","待审核","在途","已入库","已发货","已驳回"\]\} value=\{statuses\} onChange=\{setStatuses\} \/>/);
  assert.match(page,/className="status-filter-clear" onClick=\{\(\) => onChange\(\[\]\)\}/);
  assert.match(page,/className="status-filter-summary" role="status" aria-live="polite"/);
  assert.match(page,/className="status-filter-values" aria-label="已选择的状态"/);
  assert.match(styles,/\.status-filter-clear\{/);
  assert.match(styles,/\.status-filter-summary\{/);
  assert.match(styles,/\.status-filter-copy em\{/);
  assert.match(styles,/\.status-filter-values>span\{/);
});

test("manual receipt offers recently used locations as one-tap choices",async()=>{
  const [page,styles]=await Promise.all([
    readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(page,/const recentLocations = useMemo\(/);
  assert.match(page,/\.sort\(\(a, b\) => \(b\.receivedAt \?\? ""\)\.localeCompare\(a\.receivedAt \?\? ""\)\)/);
  assert.match(page,/\.slice\(0, 12\), \[orders\]\)/);
  assert.match(page,/<ManualReceiveSheet order=\{selected\} recentLocations=\{recentLocations\}/);
  assert.match(page,/function ManualReceiveSheet\(\{order,recentLocations,onClose,onSubmit\}/);
  assert.match(page,/recentLocations\.length>0&&<div className="location-history">/);
  assert.match(page,/<div className="location-history-head"><i>📍<\/i><b>历史库位<\/b>/);
  assert.match(page,/className=\{item===activeLocation\?"active":""\} aria-pressed=\{item===activeLocation\} onClick=\{\(\)=>setLocation\(item\)\}>\{index===0&&<em>最近<\/em>\}<span>\{item\}<\/span>/);
  assert.match(styles,/\.location-history\{/);
  assert.match(styles,/\.location-history-head\{/);
  assert.match(styles,/\.location-chips button:before\{/);
  assert.match(styles,/\.location-chips button\.active\{/);
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
  assert.match(page,/type Overlay = [^;]+"revert-receive"/);
  assert.match(page,/mutate\("revert-receive",\{orderId:id\}\)/);
  assert.match(page,/订单已退回在途，库存已回滚/);
  assert.match(page,/function RevertReceiveSheet/);
  assert.match(page,/role === "admin" && overlay === "revert-receive"/);
  assert.match(page,/canManage && readyToShip\(order\.status\) && !order\.items\.some\(item=>item\.shipped\) && <button className="revert-receive-button"/);
  assert.match(page,/确认退回在途/);
  assert.match(styles,/\.revert-receive-button\{/);
  assert.match(styles,/\.revert-warning\{/);
});

test("multi-item entry and detail views carry dedicated visual styles",async()=>{
  const styles=await readFile(new URL("../app/globals.css",import.meta.url),"utf8");
  for(const rule of [".items-editor{",".items-editor-head{",".item-card{",".item-card-head i{",".item-remove{",".item-add-button{",".items-total{",".items-card-head{",".item-row{",".item-index{",".item-row-top{",".item-ship-button{",".item-edit-button{",".item-ship-block{",".item-ship-line{"]){
    assert.ok(styles.includes(rule),`missing style rule ${rule}`);
  }
  assert.match(styles,/\.item-row\.shipped \.item-index\{/);
  assert.doesNotMatch(styles,/\.item-row-main b\{font-size:11\.5px\}/);
});

test("purchase channels are consistent across entry form, admin and buyer order filters",async()=>{
  const page=await readFile(new URL("../app/page.tsx",import.meta.url),"utf8");
  assert.match(page,/const purchaseChannels = \["京东","淘宝","抖音","唯品会","拼多多","其他"\]/);
  assert.equal(page.match(/\{purchaseChannels\.map\(channel=><option key=\{channel\}>\{channel\}<\/option>\)\}/g)?.length,2);
  assert.match(page,/\["全部渠道",\.\.\.purchaseChannels\]/);
  assert.match(page,/\(platform === "全部渠道" \|\| o\.platform === platform\)/);
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
  assert.match(page,/<SectionHead title="采购员申请"/);
  assert.match(page,/onReview=\{\(userId,decision\)=>void run\("review-user-application"/);
  assert.match(page,/\?"通过":"重新通过"/);
  assert.match(page,/name="phone" type="tel" required/);
  assert.match(schema,/phone: text\("phone"\)/);
  assert.match(schema,/approvalStatus: text\("approval_status"/);
  assert.match(migration,/ADD COLUMN "approval_status" text DEFAULT 'approved' NOT NULL/);
  assert.match(migration,/CREATE UNIQUE INDEX "idx_users_phone"/);
  assert.match(styles,/\.application-list\{/);
  assert.match(styles,/\.register-success\{/);
  assert.match(styles,/\.login-apply\{/);
  assert.match(styles,/\.register-entry>i\{/);
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
  assert.match(page,/showPurchaserContact/);
  assert.match(page,/<span>采购员联系方式<\/span>/);
  assert.match(page,/label="采购员微信号"/);
  assert.match(page,/label="采购员手机号"/);
  assert.match(page,/<KeyValue label="采购员微信号"[^>]+copyValue=\{order\.purchaserWechatId\}/);
  assert.match(page,/<KeyValue label="采购员手机号"[^>]+copyValue=\{order\.purchaserPhone\}/);
  assert.match(page,/canManage&&order\.purchaserWechatId/);
  assert.match(styles,/\.order-contact\{/);
});
