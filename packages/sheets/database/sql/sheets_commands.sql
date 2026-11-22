CREATE TABLE v_sheets_commands (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    document_id uuid NOT NULL REFERENCES v_documents(id) ON DELETE CASCADE,
    tenant_id bigint NOT NULL,
    project_scope text NOT NULL CHECK (octet_length(project_scope) BETWEEN 1 AND 255),
    subject_type text NOT NULL CHECK (octet_length(subject_type) BETWEEN 1 AND 120),
    subject_id bigint NOT NULL,
    command_id text NOT NULL CHECK (octet_length(command_id) BETWEEN 1 AND 255),
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    generation bigint NOT NULL CHECK (generation >= 0),
    base_position bigint NOT NULL CHECK (base_position >= 0),
    state text NOT NULL CHECK (state IN ('running','committed','rejected','expired')),
    intent jsonb,
    worker_token uuid,
    lease_until timestamptz,
    receipt_id uuid UNIQUE,
    committed_position bigint CHECK (committed_position >= 0),
    error_code text,
    evidence jsonb,
    evidence_blob_id uuid REFERENCES v_blobs(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    evidence_until timestamptz,
    replay_until timestamptz NOT NULL,
    UNIQUE (tenant_id, project_scope, subject_type, subject_id, document_id, command_id),
    UNIQUE (document_id, generation, receipt_id),
    CHECK ((worker_token IS NULL) = (lease_until IS NULL)),
    CHECK (state = 'running' OR worker_token IS NULL),
    CHECK (replay_until >= created_at),
    CHECK (
        (state = 'running' AND intent IS NOT NULL AND receipt_id IS NULL AND committed_position IS NULL AND error_code IS NULL AND finished_at IS NULL) OR
        (state = 'committed' AND receipt_id IS NOT NULL AND committed_position IS NOT NULL AND committed_position >= base_position AND error_code IS NULL AND finished_at IS NOT NULL) OR
        (state = 'rejected' AND receipt_id IS NULL AND committed_position IS NULL AND error_code IS NOT NULL AND finished_at IS NOT NULL) OR
        (state = 'expired' AND intent IS NULL AND evidence IS NULL AND evidence_blob_id IS NULL AND error_code IS NULL AND finished_at IS NOT NULL)
    ),
    CHECK ((evidence IS NULL AND evidence_blob_id IS NULL) OR (state = 'committed' AND evidence_until IS NOT NULL))
);
CREATE INDEX v_sheets_commands_reclaim_idx ON v_sheets_commands (lease_until, created_at) WHERE state = 'running';
CREATE INDEX v_sheets_commands_expiry_idx ON v_sheets_commands (replay_until) WHERE state IN ('committed','rejected');
CREATE INDEX v_sheets_commands_evidence_blob_fk_idx ON v_sheets_commands (evidence_blob_id);
CREATE INDEX v_sheets_commands_versions_idx ON v_sheets_commands (document_id, generation, committed_position);
