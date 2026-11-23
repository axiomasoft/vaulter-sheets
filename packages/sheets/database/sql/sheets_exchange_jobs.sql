CREATE TABLE v_sheets_exchange_jobs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    document_id uuid NOT NULL REFERENCES v_documents(id) ON DELETE CASCADE,
    tenant_id bigint NOT NULL,
    project_scope text NOT NULL CHECK (octet_length(project_scope) BETWEEN 1 AND 255),
    subject_type text NOT NULL CHECK (octet_length(subject_type) BETWEEN 1 AND 120),
    subject_id bigint NOT NULL,
    request_key text NOT NULL CHECK (octet_length(request_key) BETWEEN 1 AND 255),
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    kind text NOT NULL CHECK (kind IN ('import','export')),
    format text NOT NULL CHECK (format IN ('csv','xlsx')),
    generation bigint NOT NULL CHECK (generation >= 0),
    source_position bigint NOT NULL CHECK (source_position >= 0),
    options jsonb NOT NULL CHECK (jsonb_typeof(options) = 'object'),
    state text NOT NULL CHECK (state IN ('queued','running','succeeded','failed')),
    result_receipt_id uuid,
    source_blob_id uuid NOT NULL REFERENCES v_blobs(id) ON DELETE RESTRICT,
    output_blob_id uuid REFERENCES v_blobs(id) ON DELETE RESTRICT,
    report jsonb,
    error_code text,
    worker_token uuid,
    lease_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    keep_until timestamptz NOT NULL,
    UNIQUE (tenant_id, project_scope, subject_type, subject_id, document_id, request_key),
    FOREIGN KEY (document_id, generation, result_receipt_id)
        REFERENCES v_sheets_commands(document_id, generation, receipt_id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE,
    CHECK ((kind = 'import' AND state = 'succeeded') = (result_receipt_id IS NOT NULL)),
    CHECK (kind <> 'export' OR state <> 'succeeded' OR output_blob_id IS NOT NULL),
    CHECK ((worker_token IS NULL) = (lease_until IS NULL)),
    CHECK ((state = 'running') = (worker_token IS NOT NULL)),
    CHECK ((state IN ('succeeded','failed')) = (finished_at IS NOT NULL)),
    CHECK ((state = 'failed') = (error_code IS NOT NULL)),
    CHECK (keep_until >= created_at)
);
CREATE INDEX v_sheets_exchange_work_idx ON v_sheets_exchange_jobs (state, lease_until, created_at) WHERE state IN ('queued','running');
CREATE INDEX v_sheets_exchange_gc_idx ON v_sheets_exchange_jobs (keep_until) WHERE state IN ('succeeded','failed');
CREATE INDEX v_sheets_exchange_jobs_doc_fk_idx ON v_sheets_exchange_jobs (document_id, created_at DESC);
CREATE INDEX v_sheets_exchange_jobs_receipt_fk_idx ON v_sheets_exchange_jobs (document_id, generation, result_receipt_id);
CREATE INDEX v_sheets_exchange_jobs_source_blob_fk_idx ON v_sheets_exchange_jobs (source_blob_id);
CREATE INDEX v_sheets_exchange_jobs_output_blob_fk_idx ON v_sheets_exchange_jobs (output_blob_id);
