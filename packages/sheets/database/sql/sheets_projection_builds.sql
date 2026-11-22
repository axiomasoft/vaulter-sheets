CREATE TABLE v_sheets_projection_builds (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    document_id uuid NOT NULL REFERENCES v_documents(id) ON DELETE CASCADE,
    generation bigint NOT NULL CHECK (generation >= 0),
    source_position bigint NOT NULL CHECK (source_position >= 0),
    source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
    projector_version integer NOT NULL CHECK (projector_version > 0),
    profile_id text NOT NULL CHECK (octet_length(profile_id) BETWEEN 1 AND 255),
    locale text NOT NULL CHECK (locale <> ''),
    state text NOT NULL CHECK (state IN ('building','ready')),
    calculated_position bigint CHECK (calculated_position >= 0 AND calculated_position <= source_position),
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE (document_id, id, state),
    CHECK ((state = 'ready') = (completed_at IS NOT NULL))
);
CREATE INDEX v_sheets_build_source_idx ON v_sheets_projection_builds (document_id, generation, source_position);
CREATE INDEX v_sheets_build_gc_idx ON v_sheets_projection_builds (created_at, id);
