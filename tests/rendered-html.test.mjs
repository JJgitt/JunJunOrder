import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

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
