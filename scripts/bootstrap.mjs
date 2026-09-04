import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "bcryptjs";
import postgres from "postgres";

const databaseUrl=process.env.DATABASE_URL;
if(!databaseUrl)throw new Error("DATABASE_URL is required");
const migrationDirectory=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..","drizzle");

async function connect(){
  for(let attempt=1;attempt<=30;attempt++){
    const sql=postgres(databaseUrl,{max:1,connect_timeout:5});
    try{await sql`select 1`;return sql;}
    catch(error){await sql.end({timeout:0});if(attempt===30)throw error;await new Promise(resolve=>setTimeout(resolve,2000));}
  }
  throw new Error("Database connection failed");
}

const sql=await connect();
try{
  await sql`create table if not exists _junjun_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const files=(await readdir(migrationDirectory)).filter(name=>name.endsWith(".sql")).sort();
  for(const name of files){
    const [applied]=await sql`select name from _junjun_migrations where name=${name}`;
    if(applied)continue;
    const migration=await readFile(path.join(migrationDirectory,name),"utf8");
    await sql.begin(async tx=>{await tx.unsafe(migration);await tx`insert into _junjun_migrations (name) values (${name})`;});
    console.log(`Applied migration ${name}`);
  }

  const [{count}]=await sql`select count(*)::int as count from users`;
  if(count===0){
    const wechatId=(process.env.ADMIN_WECHAT_ID||process.env.ADMIN_EMAIL)?.trim().toLowerCase(),password=process.env.ADMIN_PASSWORD,name=process.env.ADMIN_NAME?.trim()||"系统管理员";
    if(!wechatId||!password||password.length<8)throw new Error("ADMIN_WECHAT_ID and an ADMIN_PASSWORD of at least 8 characters are required for first startup");
    const passwordHash=await hash(password,12),id=`usr_${randomUUID()}`;
    await sql`insert into users (id,wechat_id,name,password_hash,role,active) values (${id},${wechatId},${name},${passwordHash},'admin',true)`;
    console.log(`Created initial administrator ${wechatId}`);
  }
}finally{await sql.end({timeout:5});}
