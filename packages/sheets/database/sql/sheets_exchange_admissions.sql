CREATE TABLE v_sheets_exchange_admissions (
    tenant_id bigint NOT NULL,
    project_scope text NOT NULL,
    subject_type text NOT NULL,
    subject_id bigint NOT NULL,
    job_id uuid REFERENCES v_sheets_exchange_jobs(id) ON DELETE CASCADE,
    PRIMARY KEY (tenant_id, project_scope, subject_type, subject_id)
);
CREATE INDEX v_sheets_exchange_admissions_job_idx ON v_sheets_exchange_admissions (job_id);
