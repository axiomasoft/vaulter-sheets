CREATE TABLE v_sheets_projection_sheets (
    build_id uuid NOT NULL REFERENCES v_sheets_projection_builds(id) ON DELETE CASCADE,
    sheet_id text NOT NULL CHECK (octet_length(sheet_id) BETWEEN 1 AND 255),
    title text NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal >= 1),
    PRIMARY KEY (build_id, sheet_id),
    UNIQUE (build_id, ordinal)
);
