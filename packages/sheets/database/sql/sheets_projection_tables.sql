CREATE TABLE v_sheets_projection_tables (
    build_id uuid NOT NULL,
    sheet_id text NOT NULL,
    table_id text NOT NULL CHECK (octet_length(table_id) BETWEEN 1 AND 255),
    title text NOT NULL,
    PRIMARY KEY (build_id, table_id),
    FOREIGN KEY (build_id, sheet_id) REFERENCES v_sheets_projection_sheets(build_id, sheet_id) ON DELETE CASCADE
);
CREATE INDEX v_sheets_table_sheet_idx ON v_sheets_projection_tables (build_id, sheet_id, table_id);
