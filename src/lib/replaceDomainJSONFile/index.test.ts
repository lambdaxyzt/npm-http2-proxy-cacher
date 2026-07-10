import { describe, it, expect } from "vitest";
import { StreamingReplaceURLTransform } from "./index";

async function run(pkgName: string, replaceURL: string, input: string, chunkSize = 8) {
  const transform = new StreamingReplaceURLTransform(pkgName, replaceURL);
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    transform.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    transform.on("end", () => resolve());
    transform.on("error", reject);
  });
  const buf = Buffer.from(input);
  for (let i = 0; i < buf.length; i += chunkSize) {
    transform.write(buf.subarray(i, i + chunkSize));
  }
  transform.end();
  await done;
  return Buffer.concat(chunks).toString();
}

describe("StreamingReplaceURLTransform", () => {
  it("rewrites a plain package tarball URL", async () => {
    const input = `{"dist":{"tarball":"https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz"}}`;
    const out = await run("lodash", "http://localhost:4873", input);
    expect(out).toContain(`"tarball": "http://localhost:4873/lodash/-/lodash-4.17.21.tgz"`);
    expect(out).not.toContain("registry.npmjs.org");
  });

  it("rewrites a scoped package tarball URL (keeps the literal slash)", async () => {
    const input = `{"dist":{"tarball":"https://registry.npmjs.org/@types/node/-/node-20.0.0.tgz"}}`;
    const out = await run("@types/node", "http://localhost:4873", input);
    expect(out).toContain(`"tarball": "http://localhost:4873/@types/node/-/node-20.0.0.tgz"`);
    expect(out).not.toContain("registry.npmjs.org");
  });

  it("rewrites correctly regardless of chunk boundaries", async () => {
    const input = `{"a":{"dist":{"tarball":"https://registry.npmjs.org/@babel/core/-/core-7.0.0.tgz"}},`
      + `"b":{"dist":{"tarball":"https://registry.npmjs.org/@babel/core/-/core-7.1.0.tgz"}}}`;
    const full = await run("@babel/core", "http://localhost:4873", input, 8192);
    for (const cs of [1, 3, 7, 16, 64]) {
      const out = await run("@babel/core", "http://localhost:4873", input, cs);
      expect(out).toBe(full);
    }
    expect((full.match(/http:\/\/localhost:4873\//g) || []).length).toBe(2);
  });

  it("leaves unrelated tarball URLs untouched", async () => {
    const input = `{"dist":{"tarball":"https://registry.npmjs.org/other-pkg/-/other-pkg-1.0.0.tgz"}}`;
    const out = await run("lodash", "http://localhost:4873", input);
    expect(out).toBe(input);
  });
});
