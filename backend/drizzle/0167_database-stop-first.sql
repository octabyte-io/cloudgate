-- A database updates and rolls back stop-first whatever is stored, so a stored start-first is rewritten to what runs.
UPDATE "postgres" SET "update_config_swarm" = jsonb_set("update_config_swarm"::jsonb, '{Order}', '"stop-first"')::json WHERE "update_config_swarm"::jsonb ->> 'Order' = 'start-first';--> statement-breakpoint
UPDATE "postgres" SET "rollback_config_swarm" = jsonb_set("rollback_config_swarm"::jsonb, '{Order}', '"stop-first"')::json WHERE "rollback_config_swarm"::jsonb ->> 'Order' = 'start-first';--> statement-breakpoint
UPDATE "mysql" SET "update_config_swarm" = jsonb_set("update_config_swarm"::jsonb, '{Order}', '"stop-first"')::json WHERE "update_config_swarm"::jsonb ->> 'Order' = 'start-first';--> statement-breakpoint
UPDATE "mysql" SET "rollback_config_swarm" = jsonb_set("rollback_config_swarm"::jsonb, '{Order}', '"stop-first"')::json WHERE "rollback_config_swarm"::jsonb ->> 'Order' = 'start-first';--> statement-breakpoint
UPDATE "mariadb" SET "update_config_swarm" = jsonb_set("update_config_swarm"::jsonb, '{Order}', '"stop-first"')::json WHERE "update_config_swarm"::jsonb ->> 'Order' = 'start-first';--> statement-breakpoint
UPDATE "mariadb" SET "rollback_config_swarm" = jsonb_set("rollback_config_swarm"::jsonb, '{Order}', '"stop-first"')::json WHERE "rollback_config_swarm"::jsonb ->> 'Order' = 'start-first';--> statement-breakpoint
UPDATE "mongo" SET "update_config_swarm" = jsonb_set("update_config_swarm"::jsonb, '{Order}', '"stop-first"')::json WHERE "update_config_swarm"::jsonb ->> 'Order' = 'start-first';--> statement-breakpoint
UPDATE "mongo" SET "rollback_config_swarm" = jsonb_set("rollback_config_swarm"::jsonb, '{Order}', '"stop-first"')::json WHERE "rollback_config_swarm"::jsonb ->> 'Order' = 'start-first';--> statement-breakpoint
UPDATE "redis" SET "update_config_swarm" = jsonb_set("update_config_swarm"::jsonb, '{Order}', '"stop-first"')::json WHERE "update_config_swarm"::jsonb ->> 'Order' = 'start-first';--> statement-breakpoint
UPDATE "redis" SET "rollback_config_swarm" = jsonb_set("rollback_config_swarm"::jsonb, '{Order}', '"stop-first"')::json WHERE "rollback_config_swarm"::jsonb ->> 'Order' = 'start-first';--> statement-breakpoint
UPDATE "libsql" SET "update_config_swarm" = jsonb_set("update_config_swarm"::jsonb, '{Order}', '"stop-first"')::json WHERE "update_config_swarm"::jsonb ->> 'Order' = 'start-first';--> statement-breakpoint
UPDATE "libsql" SET "rollback_config_swarm" = jsonb_set("rollback_config_swarm"::jsonb, '{Order}', '"stop-first"')::json WHERE "rollback_config_swarm"::jsonb ->> 'Order' = 'start-first';
