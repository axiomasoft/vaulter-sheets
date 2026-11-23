CREATE TABLE v_sheets_realtime_links (
    document_id uuid NOT NULL,
    generation bigint NOT NULL CHECK (generation >= 0),
    seq bigint NOT NULL CHECK (seq >= 1),
    source_position bigint NOT NULL CHECK (source_position >= 0),
    receipt_id uuid,
    fence bigint NOT NULL CHECK (fence >= 1),
    committed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (document_id, generation, seq),
    FOREIGN KEY (document_id, generation, seq)
        REFERENCES v_collaboration_updates(document_id, generation, seq) ON DELETE CASCADE,
    FOREIGN KEY (document_id, generation, receipt_id)
        REFERENCES v_sheets_commands(document_id, generation, receipt_id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX v_sheets_rt_links_receipt_idx
    ON v_sheets_realtime_links (receipt_id) WHERE receipt_id IS NOT NULL;
CREATE INDEX v_sheets_rt_links_receipt_fk_idx
    ON v_sheets_realtime_links (document_id, generation, receipt_id);
