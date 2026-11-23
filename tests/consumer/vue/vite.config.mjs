import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  root: fileURLToPath(new URL('./', import.meta.url)),
  plugins: [vue()],
  server: {
    fs: {allow: [fileURLToPath(new URL('../../../', import.meta.url))]},
    proxy: {
      '/api': process.env.SHEETS_OWNER_URL ?? 'http://127.0.0.1:18087',
      '/office': process.env.SHEETS_OWNER_URL ?? 'http://127.0.0.1:18087',
    },
  },
})
