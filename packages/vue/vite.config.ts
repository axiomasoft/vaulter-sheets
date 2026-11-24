import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import dts from 'vite-plugin-dts'

// Library build: type-check + emit declarations, externalize Vue and @vaulter/vue.
export default defineConfig({
  plugins: [
    vue(),
    dts({ tsconfigPath: './tsconfig.json', include: ['src'], exclude: ['tests'] }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      name: 'VaulterSheetsVue',
      fileName: 'vaulter-sheets-vue',
      formats: ['es'],
    },
    rollupOptions: {
      external: ['vue', '@vaulter/vue', /^@univerjs\//],
      output: {
        exports: 'named',
      },
    },
  },
  test: {
    environment: 'happy-dom',
  },
})
