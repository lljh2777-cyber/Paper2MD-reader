import { describe, expect, it } from "vitest";
import { requestedPackageId } from "../apps/web/src/main";

describe("Reader package deep links", () => {
  it("accepts only one opaque package ID path segment", () => {
    expect(requestedPackageId("/reader/6f2277af-7a90-4f67-89ce-f0356951c587")).toBe("6f2277af-7a90-4f67-89ce-f0356951c587");
    expect(requestedPackageId("/reader/../secret")).toBeUndefined();
    expect(requestedPackageId("/reader/id/extra")).toBeUndefined();
  });
});
