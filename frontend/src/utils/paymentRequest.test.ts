import { describe, it, expect } from "vitest";
import {
  encodePaymentRequest,
  decodePaymentRequest,
  buildPaymentRequestUrl,
  decodePaymentRequestFromSearch,
  PAYMENT_REQUEST_PARAM,
  type PaymentRequestParams,
} from "./paymentRequest";

const request: PaymentRequestParams = {
  recipient: "GRECIPIENT0000000000000000000000000000000000000000000",
  token: "USDC",
  amount: "5000",
  durationSeconds: 30 * 24 * 60 * 60,
  cliffSeconds: 0,
  note: "Invoice #42 — March retainer ☕",
};

describe("encode / decode round-trip", () => {
  it("preserves all fields", () => {
    const decoded = decodePaymentRequest(encodePaymentRequest(request));
    expect(decoded).toEqual(request);
  });

  it("produces a URL-safe token (no +, /, or =)", () => {
    const token = encodePaymentRequest(request);
    expect(token).not.toMatch(/[+/=]/);
  });

  it("defaults optional fields when omitted", () => {
    const token = encodePaymentRequest({
      recipient: "GABC",
      token: "XLM",
      amount: "1",
      durationSeconds: 60,
    });
    expect(decodePaymentRequest(token)).toMatchObject({
      cliffSeconds: 0,
      note: "",
    });
  });
});

describe("decodePaymentRequest rejects bad input", () => {
  it("returns null for null/empty", () => {
    expect(decodePaymentRequest(null)).toBeNull();
    expect(decodePaymentRequest("")).toBeNull();
  });

  it("returns null for non-base64 / non-JSON garbage", () => {
    expect(decodePaymentRequest("!!!not-base64!!!")).toBeNull();
    expect(decodePaymentRequest(btoa("{not json"))).toBeNull();
  });

  it("returns null for an unknown schema version", () => {
    const token = btoa(JSON.stringify({ v: 2, recipient: "G", token: "T", amount: "1", durationSeconds: 1 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(decodePaymentRequest(token)).toBeNull();
  });

  it("returns null when a required field is missing or invalid", () => {
    const encodeWire = (wire: Record<string, unknown>) =>
      btoa(JSON.stringify(wire)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(decodePaymentRequest(encodeWire({ v: 1, token: "T", amount: "1", durationSeconds: 1 }))).toBeNull();
    expect(
      decodePaymentRequest(encodeWire({ v: 1, recipient: "G", token: "T", amount: "1", durationSeconds: 0 })),
    ).toBeNull();
  });
});

describe("URL helpers", () => {
  it("builds and re-parses a shareable link", () => {
    const url = buildPaymentRequestUrl(request);
    expect(url.startsWith(`/pay?${PAYMENT_REQUEST_PARAM}=`)).toBe(true);

    const search = url.slice(url.indexOf("?"));
    expect(decodePaymentRequestFromSearch(search)).toEqual(request);
  });

  it("returns null when the query has no request param", () => {
    expect(decodePaymentRequestFromSearch("?foo=bar")).toBeNull();
  });
});
