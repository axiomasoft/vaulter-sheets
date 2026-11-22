import { createApp, h, ref } from 'vue'
import { VaulterSpreadsheet } from '../../packages/vue/dist/vaulter-sheets-vue.js'
import '../../packages/vue/dist/vaulter-sheets-vue.css'

const id = new URLSearchParams(location.search).get('node')
const visible = ref(true)
const saved = ref(false)
createApp({
  setup() {
    return () => h('div', [
      h('button', {onClick: () => { visible.value = !visible.value }}, visible.value ? 'Close workbook' : 'Open workbook'),
      saved.value ? h('output', 'Workbook saved') : null,
      visible.value ? h(VaulterSpreadsheet, {node: {id, abilities: {edit: true}}, onSave: () => { saved.value = true }}) : null,
    ])
  },
}).mount('#app')
