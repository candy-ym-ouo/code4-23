import { describe, expect, it } from "vitest";
import {
  addQuantities,
  compareQuantities,
  convertQuantity,
  moneyAmount,
  positiveQuantity,
  quantitiesAreCompatible,
  subtractQuantities
} from "../src/index.js";

describe("fixed decimal quantity operations", () => {
  it("converts kilograms to grams without floating point arithmetic", () => {
    expect(convertQuantity("1.5", "kg", "g")).toBe("1500.000000");
    expect(convertQuantity("0.000001", "kg", "g")).toBe("0.001000");
  });

  it("preserves six-decimal precision at large values", () => {
    expect(addQuantities("999999999999.999999", "0.000001")).toBe("1000000000000.000000");
    expect(subtractQuantities("1000.000000", "0.000001")).toBe("999.999999");
    expect(compareQuantities("0.000001", "0")).toBe(1);
  });

  it("rejects incompatible units", () => {
    expect(() => convertQuantity("1", "g", "ml")).toThrow("UNIT_INCOMPATIBLE");
    expect(quantitiesAreCompatible("cm", "m")).toBe(true);
  });

  it("rejects conversions that cannot be represented at six-decimal precision", () => {
    // 0.0001 g -> kg 需要 10 位小数，超出 numeric(18,6) 尺度，必须报错而非截断。
    expect(() => convertQuantity("0.0001", "g", "kg")).toThrow("QUANTITY_PRECISION_EXCEEDED");
    // 0.0001 ml -> l 需要 7 位小数，同样不可表示。
    expect(() => convertQuantity("0.0001", "ml", "l")).toThrow("QUANTITY_PRECISION_EXCEEDED");
    // 可整除的换算仍然精确接受。
    expect(convertQuantity("0.001", "g", "kg")).toBe("0.000001");
  });

  it("enforces positive quantities and two-decimal money", () => {
    expect(positiveQuantity.safeParse("0").success).toBe(false);
    expect(positiveQuantity.safeParse("0.000001").success).toBe(true);
    expect(moneyAmount.safeParse("12.34").success).toBe(true);
    expect(moneyAmount.safeParse("12.345").success).toBe(false);
  });
});
