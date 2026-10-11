import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ExternalAgentOAuth } from "../dist/commerce/external-oauth.js";
test("owner pairing, exact redirect, PKCE, audience and single-use codes gate the scoped OAuth token", async () => {
  const d = mkdtempSync(join(tmpdir(), "envar-oauth-")),
    origin = "https://external.example",
    key = "x".repeat(43),
    o = new ExternalAgentOAuth(join(d, "oauth.sqlite"), origin, "germey", key);
  const req = (path, method = "GET", data, headers = {}) =>
    new Request(origin + path, {
      method,
      headers,
      ...(data ? { body: data } : {}),
    });
  try {
    const reg = await o.handle(
      req(
        "/register",
        "POST",
        JSON.stringify({
          redirect_uris: [
            "https://chatgpt.com/connector_platform/oauth/callback",
          ],
          token_endpoint_auth_method: "none",
        }),
        { "Content-Type": "application/json" },
      ),
    );
    const client = await reg.json();
    assert.equal(reg.status, 201);
    const verifier = "v".repeat(64),
      challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "stable",
      resource: origin + "/mcp",
      scope: "envar:tasks",
    });
    assert.equal(
      (
        await o.handle(
          req(
            "/authorize?" +
              params
                .toString()
                .replace(
                  encodeURIComponent(client.redirect_uris[0]),
                  encodeURIComponent("https://attacker.example"),
                ),
          ),
        )
      ).status,
      400,
    );
    const consent = await o.handle(req("/authorize?" + params));
    assert.match(
      consent.headers.get("Content-Security-Policy"),
      /form-action 'self' https:\/\/chatgpt.com\/connector_platform\/oauth\/callback/,
    );
    const body = await consent.text(),
      id = body.match(/name="consent" value="([^"]+)"/)[1],
      cookie = "envar_pair_csrf=" + id;
    const post = (k) =>
      req(
        "/authorize",
        "POST",
        new URLSearchParams({ consent: id, pairing_key: k }).toString(),
        {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: origin,
          Cookie: cookie,
        },
      );
    assert.equal((await o.handle(post("wrong"))).status, 400);
    const allowed = await o.handle(post(key));
    assert.equal(allowed.status, 302);
    const url = new URL(allowed.headers.get("Location"));
    assert.equal(url.searchParams.get("state"), "stable");
    const code = url.searchParams.get("code");
    const tokenReq = (v, r = origin + "/mcp") =>
      req(
        "/token",
        "POST",
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          redirect_uri: client.redirect_uris[0],
          code,
          code_verifier: v,
          resource: r,
        }).toString(),
        { "Content-Type": "application/x-www-form-urlencoded" },
      );
    assert.equal((await o.handle(tokenReq("wrong"))).status, 400);
    assert.equal(
      (await o.handle(tokenReq(verifier, "https://attacker.example/mcp")))
        .status,
      400,
    );
    const token = await (await o.handle(tokenReq(verifier))).json();
    assert.equal(
      o.authenticate(
        new Request(origin + "/mcp", {
          headers: { Authorization: "Bearer " + token.access_token },
        }),
      ),
      "germey",
    );
    assert.equal((await o.handle(tokenReq(verifier))).status, 400);
    assert.equal(
      o.authenticate(
        new Request(origin + "/mcp", {
          headers: { Authorization: "Bearer wrong" },
        }),
      ),
      null,
    );
  } finally {
    o.close();
    rmSync(d, { recursive: true, force: true });
  }
});
