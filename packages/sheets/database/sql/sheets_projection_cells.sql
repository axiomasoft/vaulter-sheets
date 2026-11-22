CREATE TABLE v_sheets_projection_cells (
    build_id uuid NOT NULL,
    sheet_id text NOT NULL,
    row_no integer NOT NULL CHECK (row_no >= 1),
    column_no integer NOT NULL CHECK (column_no >= 1),
    kind text NOT NULL CHECK (kind IN ('blank','literal','formula')),
    literal jsonb,
    formula text,
    calculated jsonb,
    calc_error text,
    number_format text,
    display_text text,
    PRIMARY KEY (build_id, sheet_id, row_no, column_no),
    FOREIGN KEY (build_id, sheet_id) REFERENCES v_sheets_projection_sheets(build_id, sheet_id) ON DELETE CASCADE,
    CHECK (
        (kind = 'blank' AND literal IS NULL AND formula IS NULL) OR
        (kind = 'literal' AND literal IS NOT NULL AND jsonb_typeof(literal) IN ('boolean','number','string') AND formula IS NULL) OR
        (kind = 'formula' AND literal IS NULL AND formula IS NOT NULL AND left(formula,1) = '=')
    ),
    CHECK (kind = 'formula' OR (calculated IS NULL AND calc_error IS NULL)),
    CHECK (calculated IS NULL OR (jsonb_typeof(calculated) IN ('null','boolean','number','string') AND calc_error IS NULL))
);
