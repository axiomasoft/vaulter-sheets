-- Every foreign key must have a valid, ready, non-partial index whose leading
-- columns match pg_constraint.conkey. Run this after migrations, not on an empty database.
DO $$
DECLARE
    missing text;
BEGIN
    WITH fks AS (
        SELECT
            c.conrelid,
            c.conname,
            c.conkey
        FROM pg_catalog.pg_constraint c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace
        WHERE c.contype = 'f'
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ),
    valid_indexes AS (
        SELECT
            i.indrelid,
            (string_to_array(i.indkey::text, ' '))::smallint[] AS indkey_arr
        FROM pg_catalog.pg_index i
        WHERE i.indisvalid
          AND i.indisready
          AND i.indpred IS NULL
    )
    SELECT string_agg(fk.conrelid::regclass::text || '.' || fk.conname, ', ' ORDER BY fk.conrelid::regclass::text, fk.conname)
    INTO missing
    FROM fks fk
    LEFT JOIN valid_indexes idx
      ON idx.indrelid = fk.conrelid
     AND idx.indkey_arr[1:cardinality(fk.conkey)] = fk.conkey
    WHERE idx.indrelid IS NULL;

    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'Unindexed foreign keys detected: %', missing;
    END IF;
END $$;
