import { vi } from "vitest";

async function filesUpstreamFor(env: Record<string, string>) {
  vi.resetModules();
  Object.assign(process.env, { PORT: "1", SERVER_URL: "http://x", NPM_UPSTREAM: "https://r" });
  delete process.env.PYPI_UPSTREAM;
  delete process.env.PYPI_FILES_UPSTREAM;
  Object.assign(process.env, env);
  return (await import("@src/config")).PYPI_FILES_UPSTREAM;
}

describe("PYPI_FILES_UPSTREAM default", () => {
  it("uses pypi.org's file host for pypi.org", async () => {
    expect(await filesUpstreamFor({})).toBe("https://files.pythonhosted.org");
    expect(await filesUpstreamFor({ PYPI_UPSTREAM: "https://pypi.org/simple" })).toBe(
      "https://files.pythonhosted.org",
    );
  });

  it("uses PYPI_UPSTREAM + /files for another proxy", async () => {
    expect(await filesUpstreamFor({ PYPI_UPSTREAM: "https://pypi.telemex.ir" })).toBe(
      "https://pypi.telemex.ir/files",
    );
    expect(await filesUpstreamFor({ PYPI_UPSTREAM: "https://npm.telemex.ir/pypi/" })).toBe(
      "https://npm.telemex.ir/pypi/files",
    );
  });

  it("keeps an explicit value", async () => {
    expect(
      await filesUpstreamFor({
        PYPI_UPSTREAM: "https://m/repository/pypi",
        PYPI_FILES_UPSTREAM: "https://m/repository/pypi/",
      }),
    ).toBe("https://m/repository/pypi");
  });
});
