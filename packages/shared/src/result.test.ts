import { describe, expect, it } from "vitest";
import { err, isErr, isOk, map, mapErr, ok } from "./result.js";

describe("Result", () => {
  it("wraps success and failure", () => {
    const success = ok(3);
    const failure = err("nope");

    expect(isOk(success)).toBe(true);
    expect(isErr(failure)).toBe(true);
    expect(map(success, (n) => n * 2)).toEqual(ok(6));
    expect(mapErr(failure, (e) => e.toUpperCase())).toEqual(err("NOPE"));
  });
});
