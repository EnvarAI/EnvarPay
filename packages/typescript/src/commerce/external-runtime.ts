import { ExternalAgentOAuth } from "./external-oauth.js";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { join, dirname, resolve } from "node:path";
import {
  readFileSync,
  lstatSync,
  chmodSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { CommerceStore } from "./store.js";
import { CommerceServer, bearerAuthenticator } from "./server.js";
import { loadCommerceConfig } from "./config.js";
import { ExternalAgentExecutor } from "./external-agent.js";
import { ExternalAgentEvents } from "./external-events.js";
import { ExternalAgentMcp, externalAgentSkill } from "./external-mcp.js";
import { CredentialVault } from "./vault.js";
import { CommerceError } from "./types.js";
export function setupExternalAgent(directory: string, origin: string) {
  directory = resolve(directory);
  const u = new URL(origin);
  if (u.protocol !== "https:" || u.origin !== origin)
    throw new CommerceError(
      "external_origin",
      "Provide the exact public HTTPS origin",
    );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const config = {
    configVersion: 1,
    agent: { id: "external-agent", name: "External Agent" },
    paymentProfiles: {},
    services: [
      {
        id: "text-answer",
        name: "Bounded text answer",
        revision: 1,
        execution: { type: "a2a", cardUrl: origin + "/agent-card.json" },
        contract: {
          inputSchema: {
            type: "object",
            properties: {
              request: { type: "string", minLength: 1, maxLength: 2000 },
            },
            required: ["request"],
            additionalProperties: false,
          },
          deliverables: ["external-agent-result.txt"],
          targetDurationSeconds: 600,
          includedRevisions: 0,
        },
        offers: [
          {
            id: "free",
            pricing: { kind: "free" },
            collection: { kind: "none" },
          },
        ],
      },
    ],
  };
  loadCommerceConfig(config);
  const agentToken = randomBytes(32).toString("base64url"),
    buyerToken = randomBytes(32).toString("base64url");
  const credentials = {
    principal: "external-agent",
    services: ["text-answer"],
    agentTokens: { [agentToken]: "external-agent" },
    callers: { [buyerToken]: "owner" },
    vaultKeyFile: join(directory, "events.key"),
  };
  for (const [name, value] of Object.entries({
    "seller.json": JSON.stringify(config, null, 2),
    "credentials.json": JSON.stringify(credentials, null, 2),
    "events.key": randomBytes(32),
    "agent.token": agentToken,
    "pairing.key": randomBytes(32).toString("base64url"),
    "buyer.token": buyerToken,
    "SKILL.md": externalAgentSkill,
    "connection.json": JSON.stringify({
      url: origin + "/services/text-answer/v1/offers/free/agent-card.json",
      authToken: buyerToken,
      mcpUrl: origin + "/mcp",
    }),
  }))
    writeFileSync(join(directory, name), value, { mode: 0o600, flag: "wx" });
  return {
    directory,
    cardUrl: origin + "/services/text-answer/v1/offers/free/agent-card.json",
    mcpUrl: origin + "/mcp",
    credentialsFile: join(directory, "credentials.json"),
    paymentsEnabled: false,
  };
}
export function serveExternalAgent(options: {
  configFile: string;
  credentialsFile: string;
  stateFile: string;
  origin: string;
  host: string;
  port: number;
}) {
  const privateBytes = (path: string) => {
    const s = lstatSync(path);
    if (!s.isFile() || s.isSymbolicLink() || s.mode & 0o077 || s.size > 65536)
      throw new CommerceError(
        "external_private_file",
        "Use private regular config/credential files",
      );
    return readFileSync(path);
  };
  const privateJson = (path: string) =>
    JSON.parse(privateBytes(path).toString("utf8"));
  const config = loadCommerceConfig(privateJson(options.configFile)),
    secret = privateJson(options.credentialsFile) as {
      principal: string;
      services: string[];
      agentTokens: Record<string, string>;
      callers: Record<string, string>;
      vaultKeyFile: string;
    };
  if (
    config.services.some(
      (s) =>
        s.execution.type !== "a2a" ||
        s.offers.some((o) => o.pricing.kind !== "free"),
    ) ||
    Object.keys(config.paymentProfiles).length
  )
    throw new CommerceError(
      "external_free_only",
      "External setup currently supports explicit free task acceptance only",
    );
  if (
    Object.keys(secret.agentTokens).some((token) =>
      Object.hasOwn(secret.callers, token),
    )
  )
    throw new CommerceError(
      "external_token_scope",
      "External Agent tokens must differ from buyer credentials",
    );
  const store = new CommerceStore(options.stateFile),
    executor = new ExternalAgentExecutor(
      store,
      secret.principal,
      secret.services,
    ),
    vault = new CredentialVault(
      join(dirname(options.stateFile), "event-secrets"),
      privateBytes(secret.vaultKeyFile),
    );
  const pairingFile = join(dirname(options.credentialsFile), "pairing.key"),
    oauth = new ExternalAgentOAuth(
      options.stateFile + ".oauth.sqlite3",
      options.origin,
      secret.principal,
      privateBytes(pairingFile).toString("utf8").trim(),
    );
  const agentAuth = bearerAuthenticator(secret.agentTokens);
  const eventsPath = options.stateFile + ".events.sqlite3",
    events = new ExternalAgentEvents(eventsPath, executor, vault);
  chmodSync(eventsPath, 0o600);
  const mcp = new ExternalAgentMcp(
    executor,
    events,
    async (r) => oauth.authenticate(r) ?? (await agentAuth(r)),
  );
  const server = new CommerceServer({
    config,
    store,
    origin: options.origin,
    authenticate: bearerAuthenticator(secret.callers),
    execute: executor.execute,
  });
  const expected = new URL(options.origin).host;
  const http = createServer(async (req, res) => {
    try {
      if (req.headers.host !== expected) {
        res.writeHead(421);
        res.end();
        return;
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(",") : v);
      const request = new Request(new URL(req.url ?? "/", options.origin), {
        method: req.method,
        headers,
        ...(!["GET", "HEAD"].includes(req.method ?? "GET")
          ? { body: Readable.toWeb(req), duplex: "half" }
          : {}),
      } as RequestInit);
      let response = await oauth.handle(request);
      if (!response)
        response =
          new URL(request.url).pathname === "/mcp"
            ? await mcp.handle(request)
            : await server.handle(request);
      if (response.status === 401 && new URL(request.url).pathname === "/mcp")
        response = new Response(response.body, {
          status: 401,
          headers: {
            ...Object.fromEntries(response.headers),
            "WWW-Authenticate": oauth.challenge(),
          },
        });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body)
        Readable.fromWeb(
          response.body as Parameters<typeof Readable.fromWeb>[0],
        ).pipe(res);
      else res.end();
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end('{"error":"request_failed"}');
    }
  });
  http.requestTimeout = 30000;
  http.headersTimeout = 15000;
  http.listen(options.port, options.host);
  events.start();
  return {
    http,
    store,
    events,
    server,
    close: async () => {
      oauth.close();
      await events.close();
      server.stop();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      while (server.isRunning) await new Promise((r) => setTimeout(r, 10));
      store.close();
    },
  };
}
