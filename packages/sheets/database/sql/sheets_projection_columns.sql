CREATE TABLE v_sheets_projection_columns (
    build_id uuid NOT NULL,
    table_id text NOT NULL,
    column_id text NOT NULL CHECK (octet_length(column_id) BETWEEN 1 AND 255),
    title text NOT NULL,
    column_no integer NOT NULL CHECK (column_no >= 1),
    PRIMARY KEY (build_id, table_id, column_id),
    UNIQUE (build_id, table_id, column_no),
    FOREIGN KEY (build_id, table_id) REFERENCES v_sheets_projection_tables(build_id, table_id) ON DELETE CASCADE
);
