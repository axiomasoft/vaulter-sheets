import {WorkbookRoomClient, type WorkbookRoomSession} from '../../packages/realtime/src/client.ts';

declare global {
    interface Window {
        connectWorkbook(node: string, actor: number, endpoint?: string): WorkbookRoomClient;
        workbookClient?: WorkbookRoomClient;
        receipts: Record<string, string>;
        conflicts: Record<string, string>;
    }
}

window.receipts = {};
window.conflicts = {};
window.connectWorkbook = (node, actor, endpoint) => {
    window.workbookClient?.close();
    const client = new WorkbookRoomClient({
        async session(): Promise<WorkbookRoomSession> {
            const response = await fetch(`/api/vaulter-sheets/v1/workbooks/${node}/realtime/session`, {
                method: 'POST', headers: {'X-Fixture-Actor': String(actor)},
            });
            if (!response.ok) throw new Error('Room session unavailable');
            const {data} = await response.json();
            if (endpoint) data.endpoint = new URL(new URL(data.endpoint).pathname, endpoint).href;
            return data;
        },
        onState(state) {
            const output = document.getElementById('room')!;
            output.dataset.seq = String(state.seq);
            output.dataset.generation = String(state.generation);
            output.textContent = JSON.stringify(state.workbook);
        },
        onReceipt(receipt) { window.receipts[receipt.command_id] = receipt.receipt_id; },
        onConflict(intent, code) { window.conflicts[intent.command_id] = code; },
        onConnection(state) { document.getElementById('room')!.dataset.connection = state; },
    });
    client.connect();
    window.workbookClient = client;
    return client;
};
