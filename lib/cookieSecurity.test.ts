import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shouldUseSecureCookies } from "./cookieSecurity";

const ENV_KEYS = [
  "COOKIE_SECURE_MODE",
  "AUTH_SECURE_COOKIES",
  "SECURE_COOKIES",
  "NODE_ENV",
] as const;

// process.env types NODE_ENV as a readonly literal; go through an untyped
// view for this generic save/restore instead of narrowing each key by hand.
const env = process.env as Record<string, string | undefined>;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = env[key];
    delete env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete env[key];
    else env[key] = savedEnv[key];
  }
});

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/", { headers });
}

describe("shouldUseSecureCookies - explicit mode overrides", () => {
  it("COOKIE_SECURE_MODE=always forces secure regardless of the request", () => {
    process.env.COOKIE_SECURE_MODE = "always";
    expect(shouldUseSecureCookies(requestWithHeaders({}))).toBe(true);
    expect(shouldUseSecureCookies(undefined)).toBe(true);
  });

  it("COOKIE_SECURE_MODE=never forces insecure even behind HTTPS", () => {
    process.env.COOKIE_SECURE_MODE = "never";
    expect(
      shouldUseSecureCookies(
        requestWithHeaders({ "x-forwarded-proto": "https" })
      )
    ).toBe(false);
  });

  it("AUTH_SECURE_COOKIES is a legacy boolean-like fallback", () => {
    process.env.AUTH_SECURE_COOKIES = "true";
    expect(shouldUseSecureCookies(undefined)).toBe(true);

    process.env.AUTH_SECURE_COOKIES = "0";
    expect(
      shouldUseSecureCookies(
        requestWithHeaders({ "x-forwarded-proto": "https" })
      )
    ).toBe(false);
  });

  it("an explicit COOKIE_SECURE_MODE wins over the legacy env vars", () => {
    process.env.COOKIE_SECURE_MODE = "always";
    process.env.AUTH_SECURE_COOKIES = "false";
    expect(shouldUseSecureCookies(undefined)).toBe(true);
  });
});

describe("shouldUseSecureCookies - auto mode (default), detecting HTTPS from headers", () => {
  it("is insecure by default with no request and no headers", () => {
    expect(shouldUseSecureCookies(undefined)).toBe(false);
    expect(shouldUseSecureCookies(requestWithHeaders({}))).toBe(false);
  });

  it("trusts x-forwarded-proto: https", () => {
    expect(
      shouldUseSecureCookies(
        requestWithHeaders({ "x-forwarded-proto": "https" })
      )
    ).toBe(true);
  });

  it("trusts the RFC 7239 Forwarded header's proto param", () => {
    expect(
      shouldUseSecureCookies(
        requestWithHeaders({ forwarded: "for=1.2.3.4;proto=https;by=9.9.9.9" })
      )
    ).toBe(true);
    expect(
      shouldUseSecureCookies(requestWithHeaders({ forwarded: "proto=http" }))
    ).toBe(false);
  });

  it("trusts x-forwarded-ssl: on", () => {
    expect(
      shouldUseSecureCookies(requestWithHeaders({ "x-forwarded-ssl": "on" }))
    ).toBe(true);
  });

  it("trusts front-end-https: on (some IIS/Azure proxies)", () => {
    expect(
      shouldUseSecureCookies(requestWithHeaders({ "front-end-https": "on" }))
    ).toBe(true);
  });

  it("trusts x-forwarded-port: 443", () => {
    expect(
      shouldUseSecureCookies(requestWithHeaders({ "x-forwarded-port": "443" }))
    ).toBe(true);
    expect(
      shouldUseSecureCookies(requestWithHeaders({ "x-forwarded-port": "80" }))
    ).toBe(false);
  });

  it("falls back to the request URL's own protocol with no proxy headers", () => {
    expect(shouldUseSecureCookies(new Request("https://example.com/"))).toBe(
      true
    );
    expect(shouldUseSecureCookies(new Request("http://example.com/"))).toBe(
      false
    );
  });

  it("the Forwarded header takes priority over x-forwarded-proto", () => {
    expect(
      shouldUseSecureCookies(
        requestWithHeaders({
          forwarded: "proto=https",
          "x-forwarded-proto": "http",
        })
      )
    ).toBe(true);
  });
});
