CREATE TABLE v_sheets_projection_heads (
    document_id uuid PRIMARY KEY REFERENCES v_documents(id) ON DELETE CASCADE,
    build_id uuid NOT NULL,
    build_state text NOT NULL DEFAULT 'ready' CHECK (build_state = 'ready'),
    published_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (document_id, build_id, build_state)
        REFERENCES v_sheets_projection_builds(document_id, id, state) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX v_sheets_projection_heads_build_fk_idx
    ON v_sheets_projection_heads (document_id, build_id, build_state);
