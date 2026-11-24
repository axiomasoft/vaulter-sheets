-- Run on the reference database after the Sheets DDL; the optional realtime block auto-detects its schema.
BEGIN;
SET LOCAL plpgsql.check_asserts = on;

DO $check$
DECLARE
    drive uuid := uuidv7();
    folder uuid := uuidv7();
    node_a uuid := uuidv7();
    node_b uuid := uuidv7();
    doc_a uuid := uuidv7();
    doc_b uuid := uuidv7();
    build_a uuid := uuidv7();
    build_b uuid := uuidv7();
    receipt uuid := uuidv7();
    source_blob uuid := uuidv7();
    worker uuid := uuidv7();
    expired_worker uuid := uuidv7();
    command_row_id uuid;
    affected integer;
    saved v_sheets_commands%ROWTYPE;
BEGIN
    INSERT INTO v_drives(id,tenant_id,owner_type,owner_id,name)
    VALUES(drive,73,'sheets_schema_fixture',73,'Sheets fixture');
    INSERT INTO v_nodes(id,tenant_id,drive_id,kind,name,name_key)
    VALUES(folder,73,drive,'folder','Root','root');
    INSERT INTO v_nodes(id,tenant_id,drive_id,parent_id,kind,name,name_key) VALUES
        (node_a,73,drive,folder,'document','A','a'),
        (node_b,73,drive,folder,'document','B','b');
    INSERT INTO v_documents(id,tenant_id,node_id,type,schema_version) VALUES
        (doc_a,73,node_a,'vaulter/spreadsheet',2),
        (doc_b,73,node_b,'vaulter/spreadsheet',2);
    UPDATE v_documents SET collab_epoch=2, state_version=4 WHERE id=doc_a;
    IF to_regclass('v_sheets_realtime_links') IS NOT NULL THEN
        UPDATE v_documents SET write_mode='journal' WHERE id=doc_a;
        INSERT INTO v_collaboration_heads(document_id,generation,protocol,profile,owner_fence,owner_id,owner_expires_at,head_seq,checkpoint_seq,checkpoint_version)
        VALUES(doc_a,2,'univer-sheets/1','strict',1,worker,now()+interval '1 minute',0,0,4);
    END IF;
    INSERT INTO v_sheets_projection_builds(
        id,document_id,generation,source_position,source_sha256,projector_version,profile_id,locale,state,completed_at,calculated_position
    ) VALUES
        (build_a,doc_a,2,5,repeat('a',64),1,'fixture','en','ready',now(),5),
        (build_b,doc_b,1,0,repeat('b',64),1,'fixture','en','building',NULL,NULL);
    INSERT INTO v_sheets_projection_heads(document_id,build_id) VALUES(doc_a,build_a);
    INSERT INTO v_sheets_projection_sheets VALUES(build_a,'sheet','Sheet',1);
    INSERT INTO v_sheets_projection_tables VALUES(build_a,'sheet','costs','Costs');
    INSERT INTO v_sheets_projection_columns VALUES(build_a,'costs','delta','Delta',4);
    INSERT INTO v_sheets_projection_rows VALUES(build_a,'costs','r-travel',4);
    INSERT INTO v_sheets_projection_cells(build_id,sheet_id,row_no,column_no,kind,formula,calculated)
    VALUES(build_a,'sheet',4,4,'formula','=C4-B4','-20'::jsonb);
    ASSERT EXISTS (
        SELECT 1 FROM v_sheets_projection_heads h
        JOIN v_sheets_projection_rows r ON r.build_id=h.build_id
        JOIN v_sheets_projection_columns k ON k.build_id=h.build_id AND k.table_id=r.table_id
        JOIN v_sheets_projection_tables t ON t.build_id=h.build_id AND t.table_id=r.table_id
        JOIN v_sheets_projection_cells c ON c.build_id=h.build_id AND c.sheet_id=t.sheet_id AND c.row_no=r.row_no AND c.column_no=k.column_no
        WHERE h.document_id=doc_a AND r.row_id='r-travel' AND k.column_id='delta' AND c.formula='=C4-B4' AND c.calculated='-20'::jsonb
    ), 'stable IDs did not resolve to the published formula';
    BEGIN
        INSERT INTO v_sheets_projection_heads(document_id,build_id) VALUES(doc_b,build_b);
        SET CONSTRAINTS ALL IMMEDIATE;
        RAISE EXCEPTION 'building head accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    BEGIN
        INSERT INTO v_sheets_projection_heads(document_id,build_id) VALUES(doc_b,build_a);
        SET CONSTRAINTS ALL IMMEDIATE;
        RAISE EXCEPTION 'cross-document ready head accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    BEGIN
        DELETE FROM v_sheets_projection_builds WHERE id=build_a;
        SET CONSTRAINTS ALL IMMEDIATE;
        RAISE EXCEPTION 'active projection was removed';
    EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    BEGIN
        INSERT INTO v_sheets_projection_rows VALUES(build_a,'costs','r-other',4);
        RAISE EXCEPTION 'duplicate physical row accepted';
    EXCEPTION WHEN unique_violation THEN NULL; END;
    BEGIN
        INSERT INTO v_sheets_projection_cells(build_id,sheet_id,row_no,column_no,kind,literal,formula)
        VALUES (build_a,'sheet',4,5,'literal','3','=3');
        RAISE EXCEPTION 'mixed formula/literal accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN
        INSERT INTO v_sheets_commands(document_id,tenant_id,project_scope,subject_type,subject_id,command_id,fingerprint,generation,base_position,state,replay_until)
        VALUES(doc_a,73,'project','user',7,'invalid',repeat('a',64),2,4,'committed',now()+interval '1 day');
        RAISE EXCEPTION 'committed without receipt allowed';
    EXCEPTION WHEN check_violation THEN NULL; END;
    INSERT INTO v_sheets_commands(document_id,tenant_id,project_scope,subject_type,subject_id,command_id,fingerprint,generation,base_position,state,
        intent,worker_token,lease_until,replay_until)
    VALUES(doc_a,73,'project','user',7,'fill',repeat('a',64),2,4,'running','{}',expired_worker,
        clock_timestamp()-interval '1 second',now()+interval '1 day') RETURNING id INTO command_row_id;
    UPDATE v_sheets_commands SET state='rejected',error_code='old_attempt',finished_at=now(),worker_token=NULL,lease_until=NULL
    WHERE id=command_row_id AND state='running' AND worker_token=expired_worker AND lease_until>clock_timestamp();
    ASSERT NOT FOUND, 'expired worker rejected the command before takeover';
    UPDATE v_sheets_commands SET worker_token=worker,lease_until=clock_timestamp()+interval '1 minute'
    WHERE id=command_row_id AND state='running' AND lease_until<=clock_timestamp();
    ASSERT FOUND, 'new worker could not reclaim the expired lease';
    UPDATE v_sheets_commands SET state='rejected',error_code='old_attempt',finished_at=now(),worker_token=NULL,lease_until=NULL
    WHERE id=command_row_id AND state='running' AND worker_token=expired_worker AND lease_until>clock_timestamp();
    ASSERT NOT FOUND, 'former worker rejected the command under the new lease';
    UPDATE v_sheets_commands SET state='committed',committed_position=5,receipt_id=receipt,evidence='{"delta":-20}',
        evidence_until=now()+interval '12 hours',finished_at=now(),intent=NULL,worker_token=NULL,lease_until=NULL
    WHERE id=command_row_id AND state='running' AND worker_token=worker AND lease_until>clock_timestamp();
    GET DIAGNOSTICS affected = ROW_COUNT;
    ASSERT affected=1, 'owner failed to seal the command';
    UPDATE v_documents SET state_version=5 WHERE id=doc_a AND state_version=4 AND collab_epoch=2;
    ASSERT FOUND, 'owner did not advance the workbook on first commit';
    UPDATE v_sheets_commands SET receipt_id=uuidv7() WHERE document_id=doc_a AND command_id='fill' AND state='running' AND worker_token=worker;
    GET DIAGNOSTICS affected = ROW_COUNT;
    ASSERT affected=0, 'replay changed a sealed command';
    BEGIN
        INSERT INTO v_sheets_commands(document_id,tenant_id,project_scope,subject_type,subject_id,command_id,fingerprint,generation,base_position,state,intent,replay_until)
        VALUES(doc_a,73,'project','user',7,'fill',repeat('f',64),2,5,'running','{}',now()+interval '1 day');
        RAISE EXCEPTION 'same scoped command key was inserted twice';
    EXCEPTION WHEN unique_violation THEN NULL; END;
    INSERT INTO v_blobs(id,tenant_id,sha256,size_bytes,storage_key,scope_key)
    VALUES(source_blob,73,repeat('f',64),300,source_blob::text,'sheets-fixture');
    BEGIN
        INSERT INTO v_sheets_exchange_jobs(document_id,tenant_id,project_scope,subject_type,subject_id,request_key,fingerprint,kind,format,generation,source_position,
            options,state,source_blob_id,result_receipt_id,finished_at,keep_until)
        VALUES(doc_b,73,'project','user',7,'import',repeat('a',64),'import','xlsx',2,4,'{}','succeeded',source_blob,receipt,now(),now()+interval '1 day');
        SET CONSTRAINTS ALL IMMEDIATE;
        RAISE EXCEPTION 'exchange job bound to another workbook receipt';
    EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    IF to_regclass('v_sheets_realtime_links') IS NOT NULL THEN
        UPDATE v_collaboration_heads SET head_seq=1
        WHERE document_id=doc_a AND generation=2 AND protocol='univer-sheets/1' AND owner_fence=1 AND owner_id=worker AND head_seq=0;
        GET DIAGNOSTICS affected = ROW_COUNT;
        ASSERT affected=1, 'current writer lost its head';
        INSERT INTO v_collaboration_updates(document_id,generation,seq,update_id,payload,sha256)
        VALUES(doc_a,2,1,'00000000-0000-7000-8000-000000000001',decode('ac','hex'),repeat('a',64));
        INSERT INTO v_sheets_realtime_links(document_id,generation,seq,source_position,receipt_id,fence)
        VALUES(doc_a,2,1,5,receipt,1);
        UPDATE v_collaboration_heads SET owner_fence=2,owner_id=uuidv7()
        WHERE document_id=doc_a AND generation=2 AND protocol='univer-sheets/1' AND owner_fence=1;
        UPDATE v_collaboration_heads SET head_seq=2
        WHERE document_id=doc_a AND generation=2 AND protocol='univer-sheets/1' AND owner_fence=1 AND owner_id=worker;
        GET DIAGNOSTICS affected = ROW_COUNT;
        ASSERT affected=0, 'old fence advanced the unified collaboration log';
        BEGIN
            INSERT INTO v_collaboration_updates(document_id,generation,seq,update_id,payload,sha256)
            VALUES(doc_a,2,2,'00000000-0000-7000-8000-000000000001',decode('ac','hex'),repeat('a',64));
            RAISE EXCEPTION 'physical replay was appended twice';
        EXCEPTION WHEN unique_violation THEN NULL; END;
    END IF;

    -- The previous HTTP response was lost. The current head has already moved to another generation.
    UPDATE v_documents SET write_mode='snapshot', collab_epoch=3, state_version=6 WHERE id=doc_a;
    ASSERT NOT EXISTS (SELECT 1 FROM v_documents WHERE id=doc_a AND collab_epoch=2 AND state_version=4),
        'fixture must make the original If-Match stale before redelivery';
    INSERT INTO v_sheets_commands(document_id,tenant_id,project_scope,subject_type,subject_id,command_id,fingerprint,generation,base_position,state,intent,replay_until)
    VALUES(doc_a,73,'project','user',7,'fill',repeat('a',64),2,4,'running','{}',now()+interval '1 day')
    ON CONFLICT (tenant_id,project_scope,subject_type,subject_id,document_id,command_id) DO NOTHING;
    ASSERT NOT FOUND, 'redelivery registered a second mutation';
    SELECT * INTO STRICT saved FROM v_sheets_commands
    WHERE tenant_id=73 AND project_scope='project' AND subject_type='user' AND subject_id=7 AND document_id=doc_a AND command_id='fill';
    ASSERT saved.fingerprint=repeat('a',64) AND saved.state='committed' AND saved.receipt_id=receipt
        AND saved.generation=2 AND saved.committed_position=5, 'redelivery lost the original marker';
    ASSERT EXISTS (SELECT 1 FROM v_documents WHERE id=doc_a AND collab_epoch=3 AND state_version=6),
        'redelivery advanced the current head';

    -- Keep a real incoming reference while compacting the result at the replay deadline.
    INSERT INTO v_sheets_exchange_jobs(document_id,tenant_id,project_scope,subject_type,subject_id,request_key,fingerprint,kind,format,generation,source_position,
        options,state,source_blob_id,result_receipt_id,finished_at,keep_until)
    VALUES(doc_a,73,'project','user',7,'import',repeat('a',64),'import','xlsx',2,4,'{}','succeeded',source_blob,receipt,now(),now()+interval '2 days');
    UPDATE v_sheets_commands SET state='expired', intent=NULL, evidence=NULL, evidence_blob_id=NULL, error_code=NULL
    WHERE id=saved.id AND state='committed' AND replay_until <= saved.replay_until;
    ASSERT FOUND, 'retention failed at exact replay deadline';
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    ASSERT EXISTS (SELECT 1 FROM v_sheets_commands WHERE id=saved.id AND state='expired'
        AND fingerprint=saved.fingerprint AND receipt_id=receipt AND evidence IS NULL), 'compaction lost the tombstone';
    BEGIN
        INSERT INTO v_sheets_commands(document_id,tenant_id,project_scope,subject_type,subject_id,command_id,fingerprint,generation,base_position,state,intent,replay_until)
        VALUES(doc_a,73,'project','user',7,'fill',repeat('a',64),3,6,'running','{}',now()+interval '1 day');
        RAISE EXCEPTION 'expired key accepted in the new generation';
    EXCEPTION WHEN unique_violation THEN NULL; END;
    DELETE FROM v_nodes WHERE id=node_a;
    SET CONSTRAINTS ALL IMMEDIATE;
    ASSERT NOT EXISTS (SELECT 1 FROM v_sheets_projection_cells WHERE build_id=build_a), 'orphaned cell after deleting workbook';
    ASSERT NOT EXISTS (SELECT 1 FROM v_sheets_commands WHERE document_id=doc_a), 'orphaned command after deleting workbook';
    ASSERT EXISTS (SELECT 1 FROM v_sheets_projection_builds WHERE id=build_b), 'deleting book A changed book B';
END $check$;
ROLLBACK;
