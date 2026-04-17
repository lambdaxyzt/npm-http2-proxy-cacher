import {StreamingReplaceTransform, StreamingReplaceURLTransform} from "@src/lib/replaceDomainJSONFile";
import fs from "node:fs";
import path from "node:path";
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// "tarball":\s*"https?:\/\/.*?(?=\/types-registry)
describe('test Streaming String Replace function', () => {
    test('test types-registry StreamingReplaceTransform', async () => {
        const packageName ="types-registry"
        const transform = new StreamingReplaceTransform("http://mirror2.chabokan.net:443/npm", "")
        await new Promise((resolve, reject) => {
            fs.createReadStream(path.resolve(__dirname, `./${packageName}/test.json`))
                .pipe(transform)
                .pipe(fs.createWriteStream(path.resolve(__dirname, `./${packageName}/test.temp.json`)))
                .on("finish", resolve)
                .on("error", reject);
        });
        expect(
            await fs.promises.readFile(path.resolve(__dirname, `./${packageName}/test.temp.json`),"utf-8")
        ).toEqual(
            await fs.promises.readFile(path.resolve(__dirname, `./${packageName}/test-correct.json`),"utf-8")
        );
    })
    test('test types-registry StreamingReplaceURLTransform', async () => {
        const packageName ="types-registry"
        const transform = new StreamingReplaceURLTransform(packageName)
        await new Promise((resolve, reject) => {
            fs.createReadStream(path.resolve(__dirname, `./${packageName}/test.json`))
                .pipe(transform)
                .pipe(fs.createWriteStream(path.resolve(__dirname, `./${packageName}/test.temp.json`)))
                .on("finish", resolve)
                .on("error", reject);
        });
        expect(
            await fs.promises.readFile(path.resolve(__dirname, `./${packageName}/test.temp.json`),"utf-8")
        ).toEqual(
            await fs.promises.readFile(path.resolve(__dirname, `./${packageName}/test-correct.json`),"utf-8")
        );
    })
    test('test @dnd-kit-core StreamingReplaceURLTransform', async () => {
        const packageNameReal ="@dnd-kit/core"
        const packageName ="@dnd-kit-core"
        const transform = new StreamingReplaceURLTransform(packageNameReal)
        await new Promise((resolve, reject) => {
            fs.createReadStream(path.resolve(__dirname, `./${packageName}/test.json`))
                .pipe(transform)
                .pipe(fs.createWriteStream(path.resolve(__dirname, `./${packageName}/test.temp.json`)))
                .on("finish", resolve)
                .on("error", reject);
        });
        expect(
            await fs.promises.readFile(path.resolve(__dirname, `./${packageName}/test.temp.json`),"utf-8")
        ).toEqual(
            await fs.promises.readFile(path.resolve(__dirname, `./${packageName}/test-correct.json`),"utf-8")
        );
    })
})

