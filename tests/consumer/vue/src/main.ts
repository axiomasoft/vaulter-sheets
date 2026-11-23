import {createApp} from 'vue'
import WorkbookReferenceFixture from './WorkbookReferenceFixture.vue'

const params = new URLSearchParams(location.search)
createApp(WorkbookReferenceFixture, {
  actor: params.get('actor') ?? '1',
  nodeId: params.get('node') ?? '',
  sheetId: params.get('sheet') ?? 'detail',
  range: params.get('range') ?? 'D2:D4',
  extension: params.get('extension') !== '0',
  insert: params.get('insert') === '1',
}).mount('#app')
