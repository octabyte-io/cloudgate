-- What the Infrastructure state login may do (ADR-0036): read and write
-- OpenTofu's `states` table in the `infrastructure_state` schema, and nothing
-- else. `tofu` connects as it (PG_CONN_STR); Cloudgate's own tables are never
-- granted to it, so a Cloud run cannot read a secret column, and it may create
-- nothing: the schema, table, index and sequence are made by Cloudgate's
-- migration (0114_infrastructure-state.sql), and every definition tells the
-- `pg` backend to skip making them.
--
-- deploy/install.sh creates the role and runs this as postgres in the
-- `cloudgate` database after `db:migrate`, on every install and upgrade; it is
-- idempotent. backend/test/cloud-accounts/infrastructure-state.e2e-spec.ts runs
-- this same file, so what the test proves is what an install grants.
GRANT CONNECT ON DATABASE cloudgate TO cloudgate_state;
GRANT USAGE ON SCHEMA infrastructure_state TO cloudgate_state;
GRANT SELECT, INSERT, UPDATE, DELETE ON infrastructure_state.states TO cloudgate_state;
GRANT USAGE ON SEQUENCE infrastructure_state.global_states_id_seq TO cloudgate_state;
