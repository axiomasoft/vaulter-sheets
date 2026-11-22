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
    },
    rollupOptions: {
      external: ['vue', '@vaulter/vue'],
      output: {
        exports: 'named',
        globals: {
          'vue': 'Vue',
          '@vaulter/vue': 'VaulterVue',
        },
      },
    },
  },
  test: {
    environment: 'happy-dom',
  },
})
