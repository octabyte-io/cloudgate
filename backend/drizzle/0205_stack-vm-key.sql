CREATE TABLE "stack_vm_key" (
	"compose_id" text PRIMARY KEY NOT NULL,
	"private_key" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stack_vm_key" ADD CONSTRAINT "stack_vm_key_compose_id_compose_compose_id_fk" FOREIGN KEY ("compose_id") REFERENCES "public"."compose"("compose_id") ON DELETE cascade ON UPDATE no action;