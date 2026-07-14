import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readPackageMeta,
  getEtagForRegistry,
  writePackageMeta,
} from "@src/lib/packageMeta";

const REG_A = "https://registry.npmjs.org";
const REG_B = "https://registry.example.com";

let dir: string;
let metaPath: string;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pkgmeta-"));
  metaPath = path.join(dir, "package.meta.json");
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe("packageMeta", () => {
  it("returns null / undefined when the file is missing", async () => {
    expect(await readPackageMeta(metaPath)).toBeNull();
    expect(getEtagForRegistry(null, REG_A)).toBeUndefined();
  });

  it("persists and reads back an ETag keyed by registry", async () => {
    await writePackageMeta(metaPath, {
      url: "http://localhost:4873",
      registryUrl: REG_A,
      etag: '"abc"',
    });

    const meta = await readPackageMeta(metaPath);
    expect(getEtagForRegistry(meta, REG_A)).toBe('"abc"');
    // A different registry has no ETag yet.
    expect(getEtagForRegistry(meta, REG_B)).toBeUndefined();
  });

  it("preserves ETags for other registries when writing", async () => {
    await writePackageMeta(metaPath, {
      url: "http://localhost:4873",
      registryUrl: REG_A,
      etag: '"a"',
    });
    await writePackageMeta(metaPath, {
      url: "http://localhost:4873",
      registryUrl: REG_B,
      etag: '"b"',
    });

    const meta = await readPackageMeta(metaPath);
    expect(getEtagForRegistry(meta, REG_A)).toBe('"a"');
    expect(getEtagForRegistry(meta, REG_B)).toBe('"b"');
  });

  it("overwrites the ETag for the same registry", async () => {
    await writePackageMeta(metaPath, {
      url: "http://localhost:4873",
      registryUrl: REG_A,
      etag: '"old"',
    });
    await writePackageMeta(metaPath, {
      url: "http://localhost:4873",
      registryUrl: REG_A,
      etag: '"new"',
    });

    expect(getEtagForRegistry(await readPackageMeta(metaPath), REG_A)).toBe(
      '"new"',
    );
  });

  it("falls back to the legacy single-ETag field", async () => {
    await fs.promises.writeFile(
      metaPath,
      JSON.stringify({ url: "http://localhost:4873", etag: '"legacy"' }),
      "utf-8",
    );

    const meta = await readPackageMeta(metaPath);
    expect(getEtagForRegistry(meta, REG_A)).toBe('"legacy"');
  });

  it("returns null on corrupt JSON", async () => {
    await fs.promises.writeFile(metaPath, "{not json", "utf-8");
    expect(await readPackageMeta(metaPath)).toBeNull();
  });
});
