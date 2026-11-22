import {copyFile, mkdir} from 'node:fs/promises';

const target = new URL('./contracts/', import.meta.url);
await mkdir(target, {recursive: true});
for (const contract of ['runtime-v1.schema.json', 'workbook-v2.schema.json']) {
    await copyFile(new URL(`../../contracts/${contract}`, import.meta.url), new URL(contract, target));
}
