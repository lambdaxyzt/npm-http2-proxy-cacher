import { describe, it, expect, vi } from "vitest";
import { SingleFlight } from "@src/lib/singleFlight";

describe("SingleFlight", () => {
  it("runs the work once for concurrent callers with the same key", async () => {
    const sf = new SingleFlight<number>();
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    });

    const a = sf.run("k", fn);
    const b = sf.run("k", fn);

    expect(a.leader).toBe(true);
    expect(b.leader).toBe(false);
    expect(a.promise).toBe(b.promise);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await a.promise).toBe(42);
    expect(await b.promise).toBe(42);
  });

  it("exposes the in-flight promise via peek and clears it once settled", async () => {
    const sf = new SingleFlight<string>();
    expect(sf.peek("k")).toBeUndefined();

    const { promise } = sf.run("k", async () => "done");
    expect(sf.peek("k")).toBe(promise);

    await promise;
    expect(sf.peek("k")).toBeUndefined();
  });

  it("allows a fresh run after a rejection clears the entry", async () => {
    const sf = new SingleFlight<void>();

    const first = sf.run("k", async () => {
      throw new Error("boom");
    });
    await expect(first.promise).rejects.toThrow("boom");
    expect(sf.peek("k")).toBeUndefined();

    const second = sf.run("k", async () => {});
    expect(second.leader).toBe(true);
    await second.promise;
  });
});
