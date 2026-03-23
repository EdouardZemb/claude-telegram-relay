/**
 * Unit Tests — src/result.ts
 *
 * Tests for the custom Result<T, E> type, constructors ok/err,
 * and type-guard helpers isOk/isErr.
 * V1-V4, V24 from SPEC-durcissement-standards-vague-3.
 */

import { describe, expect, it } from "bun:test";
import { err, isErr, isOk, ok, type Result } from "../../src/result.ts";

// ── V1: exports exist ────────────────────────────────────────

describe("result.ts exports", () => {
  it("exports ok, err, isOk, isErr", () => {
    expect(typeof ok).toBe("function");
    expect(typeof err).toBe("function");
    expect(typeof isOk).toBe("function");
    expect(typeof isErr).toBe("function");
  });
});

// ── V2: constructor shapes ───────────────────────────────────

describe("ok()", () => {
  it("returns { ok: true, value: 42 } for ok(42)", () => {
    const r = ok(42);
    expect(r).toEqual({ ok: true, value: 42 });
  });

  it("returns { ok: true, value: 'hello' } for ok('hello')", () => {
    const r = ok("hello");
    expect(r).toEqual({ ok: true, value: "hello" });
  });

  it("returns { ok: true, value: null } for ok(null)", () => {
    const r = ok(null);
    expect(r).toEqual({ ok: true, value: null });
  });

  it("works with object values", () => {
    const r = ok({ id: 1, name: "test" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ id: 1, name: "test" });
    }
  });
});

describe("err()", () => {
  it("returns { ok: false, error: Error } for err(new Error('x'))", () => {
    const e = new Error("x");
    const r = err(e);
    expect(r).toEqual({ ok: false, error: e });
  });

  it("returns { ok: false, error: 'message' } for err('message')", () => {
    const r = err("message");
    expect(r).toEqual({ ok: false, error: "message" });
  });

  it("works with number errors", () => {
    const r = err(42);
    expect(r).toEqual({ ok: false, error: 42 });
  });
});

// ── V3: discriminant type narrowing ─────────────────────────

describe("Result<T, E> type discriminant", () => {
  it("narrows to Ok when ok === true", () => {
    const r: Result<number, Error> = ok(10);
    if (r.ok === true) {
      // TypeScript should allow r.value here
      expect(r.value).toBe(10);
    } else {
      throw new Error("Should have been ok");
    }
  });

  it("narrows to Err when ok === false", () => {
    const e = new Error("fail");
    const r: Result<number, Error> = err(e);
    if (r.ok === false) {
      // TypeScript should allow r.error here
      expect(r.error).toBe(e);
    } else {
      throw new Error("Should have been err");
    }
  });

  it("ok is false for err results", () => {
    const r = err("oops");
    expect(r.ok).toBe(false);
  });

  it("ok is true for ok results", () => {
    const r = ok("yay");
    expect(r.ok).toBe(true);
  });
});

// ── V4: type-guard helpers ───────────────────────────────────

describe("isOk()", () => {
  it("returns true for ok result", () => {
    expect(isOk(ok(1))).toBe(true);
  });

  it("returns false for err result", () => {
    expect(isOk(err("x"))).toBe(false);
  });

  it("returns false for err(null)", () => {
    expect(isOk(err(null))).toBe(false);
  });

  it("narrows type when used as type guard", () => {
    const r: Result<string, Error> = ok("hello");
    if (isOk(r)) {
      // TypeScript should allow r.value
      expect(r.value).toBe("hello");
    }
  });
});

describe("isErr()", () => {
  it("returns true for err result", () => {
    expect(isErr(err("x"))).toBe(true);
  });

  it("returns false for ok result", () => {
    expect(isErr(ok(42))).toBe(false);
  });

  it("returns true for err(new Error)", () => {
    expect(isErr(err(new Error("fail")))).toBe(true);
  });

  it("narrows type when used as type guard", () => {
    const r: Result<string, string> = err("oops");
    if (isErr(r)) {
      // TypeScript should allow r.error
      expect(r.error).toBe("oops");
    }
  });
});

// ── Cross-method consistency ─────────────────────────────────

describe("isOk and isErr consistency", () => {
  it("isOk and isErr are mutually exclusive for ok", () => {
    const r = ok(99);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
  });

  it("isOk and isErr are mutually exclusive for err", () => {
    const r = err("e");
    expect(isOk(r)).toBe(false);
    expect(isErr(r)).toBe(true);
  });
});

// ── Practical usage pattern ───────────────────────────────────

describe("Result pattern usage", () => {
  function divide(a: number, b: number): Result<number, string> {
    if (b === 0) return err("Division par zero");
    return ok(a / b);
  }

  it("returns ok for valid division", () => {
    const r = divide(10, 2);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBe(5);
  });

  it("returns err for division by zero", () => {
    const r = divide(10, 0);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error).toBe("Division par zero");
  });
});
