CREATE TABLE "monthly_gross_profits" (
  "month" text PRIMARY KEY NOT NULL,
  "gross_profit_cents" integer NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "monthly_gross_profits_month_check" CHECK (
    char_length("month") = 7 AND "month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND substring("month", 1, 4) <> '0000'
  ),
  CONSTRAINT "monthly_gross_profits_amount_check" CHECK ("gross_profit_cents" BETWEEN -2147483648 AND 2147483647),
  CONSTRAINT "monthly_gross_profits_note_check" CHECK (char_length("note") <= 500)
);

COMMENT ON TABLE "monthly_gross_profits" IS '管理员共享的月度毛利记账本，每个自然月仅保存一条手工记录';
COMMENT ON COLUMN "monthly_gross_profits"."month" IS '记账月份，格式 YYYY-MM，年份为 0001 至 9999';
COMMENT ON COLUMN "monthly_gross_profits"."gross_profit_cents" IS '管理员手工记录的月毛利，整数分，可为正数、负数或零';
COMMENT ON COLUMN "monthly_gross_profits"."note" IS '记账备注，选填，最多 500 字';
COMMENT ON COLUMN "monthly_gross_profits"."created_by" IS '首次记录的管理员 ID，账号删除后置空';
COMMENT ON COLUMN "monthly_gross_profits"."updated_by" IS '最后修改的管理员 ID，账号删除后置空';
COMMENT ON COLUMN "monthly_gross_profits"."created_at" IS '首次记录时间，后续编辑保留';
COMMENT ON COLUMN "monthly_gross_profits"."updated_at" IS '最后修改时间';
