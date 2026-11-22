import {defineConfig} from '@playwright/test';

export default defineConfig({
    testDir: '.',
    testMatch: 'workbook.spec.ts',
    workers: 1,
    timeout: 90_000,
    use: {
        baseURL: process.env.SHEETS_BROWSER_URL ?? 'http://127.0.0.1:15173',
        channel: process.env.SHEETS_CHROMIUM_EXECUTABLE ? undefined : "chromium",
        launchOptions: {executablePath: process.env.SHEETS_CHROMIUM_EXECUTABLE},
    },
    outputDir: '../../build/workbook-browser',
});
