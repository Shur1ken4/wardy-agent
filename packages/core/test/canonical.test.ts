import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.js";

describe("canonicalJson", () => {
  it("sorts keys", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts keys at every depth", () => {
    expect(canonicalJson({ z: { y: 1, x: [{ b: 1, a: 2 }] } })).toBe('{"z":{"x":[{"a":2,"b":1}],"y":1}}');
  });

  it("gives the same bytes whatever order the keys were added", () => {
    const first = { amount: "2", payee: "a.near", nested: { one: 1, two: 2 } };
    const second = { nested: { two: 2, one: 1 }, payee: "a.near", amount: "2" };
    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  it("keeps array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("has no whitespace outside strings", () => {
    expect(canonicalJson({ a: [1, 2], b: "x y" })).toBe('{"a":[1,2],"b":"x y"}');
  });

  it("leaves out undefined fields but keeps null", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("matches a value that went through JSON, so a stored verdict still verifies", () => {
    const value = { a: undefined, b: { c: undefined, d: 1 } };
    expect(canonicalJson(JSON.parse(JSON.stringify(value)))).toBe(canonicalJson(value));
  });

  it("escapes strings the way JSON does", () => {
    expect(canonicalJson({ a: 'he said "hi"\n' })).toBe('{"a":"he said \\"hi\\"\\n"}');
  });

  it("keeps non-ASCII text intact", () => {
    expect(canonicalJson({ a: "héllo ✓" })).toBe('{"a":"héllo ✓"}');
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a bigint", 1n],
    ["a function", () => 1],
    ["a symbol", Symbol("x")],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["top-level undefined", undefined],
  ])("refuses %s rather than changing it silently", (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  it("refuses a bad value nested deep inside", () => {
    expect(() => canonicalJson({ a: [{ b: Number.NaN }] })).toThrow(TypeError);
  });
});
