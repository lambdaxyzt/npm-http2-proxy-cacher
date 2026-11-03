import path from "node:path";
import { parsePypiRequest, rewritePypiLinks, PypiLinkRewriteTransform } from "@src/lib/pypi";
import { hash } from "@src/util";

describe("parsePypiRequest", () => {
  it("normalizes index names", () => {
    const r = parsePypiRequest("/Foo_Bar.baz")!;
    expect(r.kind).toBe("index");
    expect(r.upstreamPath).toBe("/simple/foo-bar-baz/");
    const shard = hash("foo-bar-baz").slice(-2);
    expect(r.paths.packageJSON.endsWith(path.join("python", "simple", shard, "foo-bar-baz", "index.html"))).toBe(true);
  });

  it("accepts index requests with or without /simple", () => {
    expect(parsePypiRequest("/six/")!.upstreamPath).toBe("/simple/six/");
    expect(parsePypiRequest("/simple/six/")!.upstreamPath).toBe("/simple/six/");
    expect(parsePypiRequest("/simple/simple/")!.upstreamPath).toBe("/simple/simple/");
    expect(parsePypiRequest("/simple/")).toBeNull();
  });

  it("maps files under the cache", () => {
    const r = parsePypiRequest("/files/packages/ab/cd/x/pkg-1.0-py3-none-any.whl")!;
    expect(r.kind).toBe("file");
    expect(r.upstreamPath).toBe("/packages/ab/cd/x/pkg-1.0-py3-none-any.whl");
    expect(r.paths.tarball!.endsWith("pkg-1.0-py3-none-any.whl")).toBe(true);
  });

  it("rejects traversal and unknown routes", () => {
    expect(parsePypiRequest("/files/../../etc/passwd")).toBeNull();
    expect(parsePypiRequest("/files/%2e%2e/%2e%2e/x")).toBeNull();
    expect(parsePypiRequest("/files/%E0%A4%A")).toBeNull();
    expect(parsePypiRequest("/")).toBeNull();
    expect(parsePypiRequest("/a/b/")).toBeNull();
  });
});

describe("rewritePypiLinks", () => {
  const PROXY = "http://localhost:4873/pip/files";

  it("rewrites absolute links to the files host", () => {
    const html = '<a href="https://files.pythonhosted.org/packages/ab/six.whl#sha256=1">six</a>';
    expect(
      rewritePypiLinks(html, "https://pypi.org/simple/six/", "https://files.pythonhosted.org", PROXY),
    ).toBe(`<a href="${PROXY}/packages/ab/six.whl#sha256=1">six</a>`);
  });

  it("resolves relative links against the page (Nexus style)", () => {
    const html = "<a href='../../packages/six/1.0/six.whl#sha256=1'>six</a>";
    expect(
      rewritePypiLinks(
        html,
        "https://nexus.example/repository/pypi/simple/six/",
        "https://nexus.example/repository/pypi",
        PROXY,
      ),
    ).toBe(`<a href='${PROXY}/packages/six/1.0/six.whl#sha256=1'>six</a>`);
  });

  it("leaves links outside the files upstream alone", () => {
    const html = '<a href="https://example.com/x.whl">x</a>';
    expect(
      rewritePypiLinks(html, "https://pypi.org/simple/x/", "https://files.pythonhosted.org", PROXY),
    ).toBe(html);
  });
});

describe("PypiLinkRewriteTransform", () => {
  it("matches the whole-page rewrite when fed one byte at a time", async () => {
    const page = "https://pypi.org/simple/six/";
    const files = "https://files.pythonhosted.org";
    const proxy = "http://localhost:4873/pip/files";
    const html =
      '<html><body><h1>Links for six — ✓</h1>\n' +
      '<a href="https://files.pythonhosted.org/packages/ab/six-1.whl#sha256=1">six-1.whl</a><br/>\n' +
      '<a href="../../other.whl">other</a> a < b\n</body></html>';
    const t = new PypiLinkRewriteTransform(page, files, proxy);
    const out: Buffer[] = [];
    t.on("data", (c) => out.push(c));
    const done = new Promise((r) => t.on("end", r));
    for (const byte of Buffer.from(html)) t.write(Buffer.from([byte]));
    t.end();
    await done;
    expect(Buffer.concat(out).toString()).toBe(rewritePypiLinks(html, page, files, proxy));
    expect(Buffer.concat(out).toString()).toContain(`${proxy}/packages/ab/six-1.whl`);
  });
});
