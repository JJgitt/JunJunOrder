CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_audit_entity_created` ON `audit_logs` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `inventory` (
	`sku` text NOT NULL,
	`size` text NOT NULL,
	`title` text NOT NULL,
	`quantity` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`sku`, `size`)
);
--> statement-breakpoint
CREATE TABLE `inventory_lots` (
	`order_id` text PRIMARY KEY NOT NULL,
	`sku` text NOT NULL,
	`size` text NOT NULL,
	`qty` integer NOT NULL,
	`location` text NOT NULL,
	`received_at` text NOT NULL,
	`shipped_at` text,
	FOREIGN KEY (`order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_inventory_lots_sku_size` ON `inventory_lots` (`sku`,`size`);--> statement-breakpoint
CREATE TABLE `inventory_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`sku` text NOT NULL,
	`size` text NOT NULL,
	`change_qty` integer NOT NULL,
	`type` text NOT NULL,
	`location` text,
	`actor_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_movements_sku_size_created` ON `inventory_movements` (`sku`,`size`,`created_at`);--> statement-breakpoint
CREATE TABLE `order_images` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`object_key` text NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_order_images_order_id` ON `order_images` (`order_id`);--> statement-breakpoint
CREATE TABLE `purchase_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`platform_order_no` text NOT NULL,
	`title` text NOT NULL,
	`sku` text NOT NULL,
	`size` text NOT NULL,
	`qty` integer DEFAULT 1 NOT NULL,
	`amount_cents` integer NOT NULL,
	`courier_no` text DEFAULT '' NOT NULL,
	`status` text DEFAULT '待审核' NOT NULL,
	`reject_reason` text,
	`purchaser_id` text NOT NULL,
	`auditor_id` text,
	`received_at` text,
	`location` text,
	`resale_platform` text,
	`resale_order_no` text,
	`sale_price_cents` integer,
	`outbound_company` text,
	`outbound_courier_no` text,
	`shipped_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`purchaser_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`auditor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_orders_platform_order_no` ON `purchase_orders` (`platform`,`platform_order_no`);--> statement-breakpoint
CREATE INDEX `idx_orders_status_created` ON `purchase_orders` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_orders_purchaser_created` ON `purchase_orders` (`purchaser_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_orders_courier_no` ON `purchase_orders` (`courier_no`);--> statement-breakpoint
CREATE INDEX `idx_orders_sku_size` ON `purchase_orders` (`sku`,`size`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'buyer' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_email` ON `users` (`email`);--> statement-breakpoint
PRAGMA optimize;
