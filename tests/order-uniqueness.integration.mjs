import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

// Run with: node --env-file=.env.local tests/order-uniqueness.integration.mjs
// All fixtures are rolled back, including after a failed assertion.
const sql=postgres(process.env.DATABASE_URL,{max:1});
const rollback=new Error("ROLLBACK_TEST_FIXTURES");
let checks=0;
try {
  await sql.begin(async tx=>{
    const suffix=randomUUID();
    const userId="unique_test_"+suffix;
    await tx.unsafe("INSERT INTO users(id,wechat_id,name,password_hash) VALUES ($1,$2,$3,$4)",[userId,userId,"唯一性测试","not-a-login-hash"]);
    const insert=async (platform,no,status="待审核")=>{
      const id=randomUUID();
      await tx.unsafe("INSERT INTO purchase_orders(id,platform,platform_order_no,purchaser_id,status) VALUES ($1,$2,$3,$4,$5)",[id,platform,no,userId,status]);
      return id;
    };
    const duplicate=async fn=>{
      await assert.rejects(tx.savepoint(fn),error=>error.code==="23505"&&error.constraint_name==="idx_orders_platform_order_no");
      checks++;
    };
    const first=await insert("淘宝",suffix);
    await duplicate(()=>insert("淘宝",suffix)); // Same channel and number.
    await insert("京东",suffix); checks++; // Different channels are independent.
    await insert("淘宝",""); await insert("淘宝",""); checks++; // Optional empty numbers.
    await tx.unsafe("UPDATE purchase_orders SET status=$1 WHERE id=$2",["已驳回",first]);
    const replacement=await insert("淘宝",suffix); checks++;
    await duplicate(()=>insert("淘宝",suffix)); // Only one active replacement.
    await duplicate(()=>tx.unsafe("UPDATE purchase_orders SET status=$1 WHERE id=$2",["待审核",first]));
    await tx.unsafe("UPDATE purchase_orders SET status=$1 WHERE id=$2",["已驳回",replacement]);
    await tx.unsafe("UPDATE purchase_orders SET status=$1 WHERE id=$2",["待审核",first]); checks++;
    const other=await insert("淘宝",suffix+"-other");
    await duplicate(()=>tx.unsafe("UPDATE purchase_orders SET platform_order_no=$1 WHERE id=$2",[suffix,other]));
    for(const status of ["在途","已入库","待发货","已发货"]){
      await tx.unsafe("UPDATE purchase_orders SET status=$1 WHERE id=$2",[status,first]);
      await duplicate(()=>insert("淘宝",suffix));
    }
    throw rollback;
  });
} catch(error) {
  if(error!==rollback)throw error;
  console.log(checks+" database uniqueness checks passed; fixtures rolled back.");
} finally {
  await sql.end();
}
