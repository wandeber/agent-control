import { describe, expect, it } from "vitest";
import { costLabel, euroCostLabel } from "./costs";

describe("USD presentation", () => {
  it("distinguishes unknown, zero, tiny costs and partial sums", () => {
    expect(costLabel()).toBe("—");
    expect(costLabel({ usd: null, partial: true })).toBe("—");
    expect(costLabel({ usd: 0, partial: false })).toBe("$0.00");
    expect(costLabel({ usd: .000003, partial: false })).toBe("<$0.01");
    expect(costLabel({ usd: .009, partial: false })).toBe("<$0.01");
    expect(costLabel({ usd: .01, partial: false })).toBe("$0.01");
    expect(costLabel({ usd: 1.23456, partial: true })).toBe("$1.23+");
    expect(costLabel({ usd: 1234.5678, partial: false })).toBe("$1,234.57");
    expect(costLabel({ usd: NaN, partial: false })).toBe("—");
  });
});

describe("EUR equivalents", () => {
  const exchange = { usd_per_eur: 1.1622, source: null, updated_at: null };
  it("divides unrounded dollars by the ECB dollars-per-euro quote and keeps two decimals", () => {
    expect(euroCostLabel({ usd: 3.55, partial: false }, exchange)).toBe("€3.05");
    expect(euroCostLabel({ usd: 1.1622, partial: true }, exchange)).toBe("€1.00+");
    expect(euroCostLabel({ usd: .017, partial: false }, exchange)).toBe("€0.01");
    expect(euroCostLabel({ usd: .002, partial: false }, exchange)).toBe("<€0.01");
    expect(euroCostLabel({ usd: 0, partial: false }, exchange)).toBe("€0.00");
  });
  it("does not invent a conversion for missing costs or invalid exchange quotes", () => {
    expect(euroCostLabel(null, exchange)).toBe("—");
    expect(euroCostLabel({ usd: null, partial: true }, exchange)).toBe("—");
    expect(euroCostLabel({ usd: 1, partial: false })).toBe("—");
    for (const rate of [0, -1, NaN, Infinity]) expect(euroCostLabel({ usd: 1, partial: false }, { ...exchange, usd_per_eur: rate })).toBe("—");
  });
});
