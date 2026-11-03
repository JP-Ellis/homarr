CREATE TABLE "integration_viewer_mapping" (
	"integration_id" varchar(64) NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"external_user_id" text NOT NULL,
	CONSTRAINT "integration_viewer_mapping_integration_id_user_id_pk" PRIMARY KEY("integration_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "integration" ADD COLUMN "viewer_scoping" varchar(16) DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_viewer_mapping" ADD CONSTRAINT "integration_viewer_mapping_integration_id_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integration"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_viewer_mapping" ADD CONSTRAINT "integration_viewer_mapping_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;