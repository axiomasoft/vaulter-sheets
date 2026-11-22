CREATE TABLE v_sheets_projection_rows (
    build_id uuid NOT NULL,
    table_id text NOT NULL,
    row_id text NOT NULL CHECK (octet_length(row_id) BETWEEN 1 AND 255),
    row_no integer NOT NULL CHECK (row_no >= 1),
    PRIMARY KEY (build_id, table_id, row_id),
    UNIQUE (build_id, table_id, row_no),
    FOREIGN KEY (build_id, table_id) REFERENCES v_sheets_projection_tables(build_id, table_id) ON DELETE CASCADE
);
