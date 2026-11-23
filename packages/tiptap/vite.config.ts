import {fileURLToPath, URL} from 'node:url'
import {defineConfig} from 'vite'
import vue from '@vitejs/plugin-vue'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [
    vue(),
    dts({tsconfigPath: './tsconfig.json', include: ['src'], exclude: ['tests']}),
  ],
  build: {
    lib: {
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      name: 'VaulterSheetsTiptap',
      fileName: 'vaulter-sheets-tiptap',
      formats: ['es'],
    },
    rollupOptions: {
      external: [
        'vue',
        '@tiptap/core',
        '@tiptap/extension-link',
        '@tiptap/pm',
        '@tiptap/vue-3',
        /^@tiptap\/pm\//,
      ],
    },
  },
  test: {
    environment: 'happy-dom',
  },
})
