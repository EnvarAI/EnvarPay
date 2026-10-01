import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface PaidTools { peer: string; tools: Tool[] }
export interface AgentDiscovery {
  candidates: Record<string, unknown>[];
  payment_authorized: false;
}
export interface PaidCall {
  request_id: string;
  payment_made: boolean;
  payment: Record<string, unknown> | null;
  result: CallToolResult;
}
export interface PaymentStatus {
  id: string;
  status: string;
  amount: number;
  updated: number;
  transaction: string | null;
  payment_state: string | null;
  execution_state: string | null;
  invocation_id: string | null;
  report_pending: boolean;
}
export type RecoveryResult = PaidCall | ({ request_id: string } & Record<string, unknown>);
export interface WalletConnection { url: string | URL; token: string; timeoutMs?: number }

/** A wallet refusal or execution error, preserved from the MCP tool response. */
export class WalletToolError extends Error {
  constructor(readonly tool: string, readonly response: CallToolResult) {
    super(response.content.filter(c => c.type === 'text').map(c => c.text).join('\n') || 'Wallet tool failed');
    this.name = 'WalletToolError';
  }
}

/** The call may have reached the wallet. Inspect/recover this ID before another call. */
export class OperationUnknownError extends Error {
  constructor(readonly requestId: string, cause: unknown) {
    super(`Operation ${requestId} is unresolved; inspect paymentStatus or recoverPayment with this ID`, { cause });
    this.name = 'OperationUnknownError';
  }
}

function requestId(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) {
    throw new TypeError('requestId must be 1-100 letters, digits, underscores or hyphens');
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decode(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const texts = result.content.filter(c => c.type === 'text');
  if (texts.length !== 1) throw new TypeError('Expected a JSON wallet tool response');
  return JSON.parse(texts[0].text);
}

/** A remote wallet client. Signing, policy and durable recovery stay in the wallet. */
export class WalletClient {
  private constructor(private readonly client: Client, private readonly timeoutMs: number) {}

  static async connect(options: WalletConnection): Promise<WalletClient> {
    const url = new URL(options.url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.hash) {
      throw new TypeError('Wallet URL must use HTTPS or loopback HTTP, without credentials or a fragment');
    }
    if (!options.token || /[\r\n]/.test(options.token)) throw new TypeError('A wallet bearer token is required');
    const timeoutMs = options.timeoutMs ?? 300_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
    const client = new Client({ name: '@envarai/envarpay', version: '0.1.0-alpha.1' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${options.token}` }, redirect: 'error' },
    });
    try {
      await client.connect(transport, { timeout: timeoutMs });
      return new WalletClient(client, timeoutMs);
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await this.client.callTool({ name: tool, arguments: args }, undefined, { timeout: this.timeoutMs });
    if (response.isError) throw new WalletToolError(tool, response as CallToolResult);
    return decode(response as CallToolResult);
  }

  async listPaidTools(peer: string): Promise<PaidTools> {
    const value = await this.call('list_paid_tools', { peer });
    if (!object(value) || typeof value.peer !== 'string' || !Array.isArray(value.tools)) {
      throw new TypeError('Invalid paid tools response');
    }
    return value as unknown as PaidTools;
  }

  /** Requires an optional Envar connection in the wallet; discovery grants no payment authority. */
  async discoverAgents(query: string): Promise<AgentDiscovery> {
    const value = await this.call('discover_agents', { query });
    if (!object(value) || value.payment_authorized !== false || !Array.isArray(value.candidates) || value.candidates.some(candidate => !object(candidate))) {
      throw new TypeError('Invalid agent discovery response');
    }
    return value as unknown as AgentDiscovery;
  }

  /** Read a published profile without modifying the wallet's operator-owned peers. */
  async getAgent(handle: string): Promise<Record<string, unknown>> {
    const value = await this.call('get_agent', { handle });
    if (!object(value)) throw new TypeError('Invalid agent profile response');
    return value;
  }

  async callPaidTool(input: { peer: string; tool: string; arguments: Record<string, Json>; requestId: string }): Promise<PaidCall> {
    requestId(input.requestId);
    try {
      const value = await this.call('call_paid_tool', {
        peer: input.peer, tool: input.tool, arguments: input.arguments, request_id: input.requestId,
      });
      if (!object(value) || value.request_id !== input.requestId || typeof value.payment_made !== 'boolean' || !object(value.result)) {
        throw new TypeError('Invalid paid call response');
      }
      return value as unknown as PaidCall;
    } catch (error) {
      if (error instanceof WalletToolError) throw error;
      throw new OperationUnknownError(input.requestId, error);
    }
  }

  async paymentStatus(id: string): Promise<PaymentStatus[]> {
    requestId(id);
    const value = await this.call('payment_status', { request_id: id });
    // FastMCP wraps non-object return types under "result" in structuredContent.
    const rows = object(value) ? value.result : value;
    if (!Array.isArray(rows) || rows.some(row => !object(row) || typeof row.id !== 'string' || typeof row.status !== 'string')) {
      throw new TypeError('Invalid payment status response');
    }
    return rows as PaymentStatus[];
  }

  async recoverPayment(id: string): Promise<RecoveryResult> {
    requestId(id);
    const value = await this.call('recover_payment', { request_id: id });
    if (!object(value) || value.request_id !== id) throw new TypeError('Invalid recovery response');
    return value as RecoveryResult;
  }

  async close(): Promise<void> { await this.client.close(); }
}
