/** Single-user OAuth pairing for an owner-operated external Agent. PKCE, exact redirects and audience. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { CommerceError } from "./types.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const random = () => randomBytes(32).toString("base64url");
export class ExternalAgentOAuth {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    readonly origin: string,
    private readonly principal: string,
    private readonly pairingKey: string,
  ) {
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY,redirects TEXT NOT NULL);CREATE TABLE IF NOT EXISTS consent(id TEXT PRIMARY KEY,request_json TEXT NOT NULL,expires INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS codes(hash TEXT PRIMARY KEY,request_json TEXT NOT NULL,expires INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY,principal TEXT NOT NULL,expires INTEGER NOT NULL)",
    );
    if (pairingKey.length < 32)
      throw new CommerceError("pairing_key", "Use an owner-only pairing key");
  }
  challenge() {
    return (
      'Bearer resource_metadata="' +
      this.origin +
      '/.well-known/oauth-protected-resource/mcp", scope="envar:tasks"'
    );
  }
  authenticate(request: Request) {
    const token =
      request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
    const row = this.db
      .prepare("SELECT principal,expires FROM tokens WHERE hash=?")
      .get(hash(token));
    return row && Number(row.expires) > Date.now()
      ? String(row.principal)
      : null;
  }
  private validRedirect(value: string) {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.hash)
      throw new CommerceError(
        "oauth_redirect",
        "Use an exact registered HTTPS callback",
      );
    return u.href;
  }
  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url),
      path = url.pathname;
    const json = (v: unknown, status = 200) =>
      Response.json(v, { status, headers: { "Cache-Control": "no-store" } });
    if (path.startsWith("/.well-known/oauth-protected-resource"))
      return json({
        resource: this.origin + "/mcp",
        authorization_servers: [this.origin],
        scopes_supported: ["envar:tasks"],
        bearer_methods_supported: ["header"],
      });
    if (
      path.startsWith("/.well-known/oauth-authorization-server") ||
      path.startsWith("/.well-known/openid-configuration")
    )
      return json({
        issuer: this.origin,
        authorization_endpoint: this.origin + "/authorize",
        token_endpoint: this.origin + "/token",
        registration_endpoint: this.origin + "/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["envar:tasks"],
      });
    if (!["/register", "/authorize", "/token"].includes(path)) return undefined;
    try {
      if (path === "/register" && request.method === "POST") {
        const text = await request.text();
        if (Buffer.byteLength(text) > 8192) throw Error();
        const v = JSON.parse(text);
        if (
          !Array.isArray(v.redirect_uris) ||
          !v.redirect_uris.length ||
          v.redirect_uris.length > 5 ||
          (v.token_endpoint_auth_method &&
            v.token_endpoint_auth_method !== "none")
        )
          throw Error();
        const redirects = v.redirect_uris.map((u: string) =>
            this.validRedirect(u),
          ),
          id = "client_" + random();
        this.db
          .prepare("INSERT INTO clients VALUES (?,?)")
          .run(id, JSON.stringify(redirects));
        return json(
          {
            client_id: id,
            redirect_uris: redirects,
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code"],
            response_types: ["code"],
          },
          201,
        );
      }
      if (path === "/authorize" && request.method === "GET") {
        const v = Object.fromEntries(url.searchParams),
          client = this.db
            .prepare("SELECT redirects FROM clients WHERE id=?")
            .get(v.client_id ?? "");
        if (
          !client ||
          !JSON.parse(String(client.redirects)).includes(v.redirect_uri) ||
          v.response_type !== "code" ||
          v.code_challenge_method !== "S256" ||
          !v.code_challenge ||
          !/^[A-Za-z0-9_-]{43}$/.test(v.code_challenge) ||
          (v.scope && v.scope !== "envar:tasks") ||
          (v.resource && v.resource !== this.origin + "/mcp")
        )
          throw Error();
        const id = random();
        this.db
          .prepare("INSERT INTO consent VALUES (?,?,?)")
          .run(id, JSON.stringify(v), Date.now() + 600000);
        const body =
          '<!doctype html><meta name="viewport" content="width=device-width"><title>Connect Germey to Envar</title><main style="font:18px/1.6 system-ui;max-width:600px;margin:60px auto"><h1>Connect this external Agent</h1><p>Scope: claim and return bounded free text tasks for <b>' +
          escape(this.principal) +
          '</b>.</p><p>No payment, wallet, other Agent, or unrelated account access.</p><form method="post" action="/authorize"><input type="hidden" name="consent" value="' +
          id +
          '"><label>Owner pairing key <input type="password" name="pairing_key" required autocomplete="off"></label><p><button>Allow this task connection</button></p></form></main>';
        return new Response(body, {
          headers: {
            "Content-Type": "text/html",
            "Cache-Control": "no-store",
            "Set-Cookie":
              "envar_pair_csrf=" +
              id +
              "; Secure; HttpOnly; SameSite=Strict; Path=/authorize; Max-Age=600",
            "Content-Security-Policy":
              "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' " +
              new URL(v.redirect_uri).origin +
              new URL(v.redirect_uri).pathname +
              "; frame-ancestors 'none'",
          },
        });
      }
      if (path === "/authorize" && request.method === "POST") {
        if (request.headers.get("Origin") !== this.origin) throw Error();
        const text = await request.text();
        if (Buffer.byteLength(text) > 4096) throw Error();
        const form = new URLSearchParams(text),
          id = form.get("consent") ?? "",
          cookie = request.headers.get("Cookie") ?? "";
        if (
          !cookie.split(";").some((c) => c.trim() === "envar_pair_csrf=" + id)
        )
          throw Error();
        const provided = form.get("pairing_key") ?? "";
        if (
          provided.length !== this.pairingKey.length ||
          !timingSafeEqual(Buffer.from(provided), Buffer.from(this.pairingKey))
        )
          throw Error();
        const row = this.db
          .prepare("SELECT request_json,expires FROM consent WHERE id=?")
          .get(id);
        if (!row || Number(row.expires) < Date.now()) throw Error();
        const v = JSON.parse(String(row.request_json)),
          code = random();
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.prepare("DELETE FROM consent WHERE id=?").run(id);
          this.db
            .prepare("INSERT INTO codes VALUES (?,?,?)")
            .run(hash(code), JSON.stringify(v), Date.now() + 120000);
          this.db.exec("COMMIT");
        } catch (e) {
          this.db.exec("ROLLBACK");
          throw e;
        }
        const callback = new URL(v.redirect_uri);
        callback.searchParams.set("code", code);
        if (v.state) callback.searchParams.set("state", v.state);
        return new Response(null, {
          status: 302,
          headers: {
            Location: callback.href,
            "Cache-Control": "no-store",
            "Set-Cookie":
              "envar_pair_csrf=; Secure; HttpOnly; SameSite=Strict; Path=/authorize; Max-Age=0",
          },
        });
      }
      if (path === "/token" && request.method === "POST") {
        const text = await request.text();
        if (Buffer.byteLength(text) > 8192) throw Error();
        const v = request.headers
          .get("Content-Type")
          ?.includes("application/json")
          ? JSON.parse(text)
          : Object.fromEntries(new URLSearchParams(text));
        if (v.grant_type !== "authorization_code") throw Error();
        const row = this.db
          .prepare("SELECT request_json,expires FROM codes WHERE hash=?")
          .get(hash(v.code ?? ""));
        if (!row || Number(row.expires) < Date.now()) throw Error();
        const saved = JSON.parse(String(row.request_json));
        if (
          v.client_id !== saved.client_id ||
          v.redirect_uri !== saved.redirect_uri ||
          (v.resource && v.resource !== this.origin + "/mcp") ||
          typeof v.code_verifier !== "string" ||
          v.code_verifier.length < 43 ||
          v.code_verifier.length > 128 ||
          createHash("sha256").update(v.code_verifier).digest("base64url") !==
            saved.code_challenge
        )
          throw Error();
        const token = random();
        this.db.exec("BEGIN IMMEDIATE");
        try {
          if (
            !this.db.prepare("DELETE FROM codes WHERE hash=?").run(hash(v.code))
              .changes
          )
            throw Error();
          this.db
            .prepare("INSERT INTO tokens VALUES (?,?,?)")
            .run(hash(token), this.principal, Date.now() + 86400000);
          this.db.exec("COMMIT");
        } catch (e) {
          this.db.exec("ROLLBACK");
          throw e;
        }
        return json({
          access_token: token,
          token_type: "Bearer",
          expires_in: 86400,
          scope: "envar:tasks",
        });
      }
      return json({ error: "method_not_allowed" }, 405);
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
  }
  close() {
    this.db.close();
  }
}
