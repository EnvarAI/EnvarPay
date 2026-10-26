// Generated from the canonical Envar Agent Work v1 JSON Schema. Do not edit.
// Source: EnvarAI/EnvarAI server/contracts/agent-work/v1/schema.json
export const WORK_SCHEMA_SHA256 = '13142409150be2625fa6e8d2b4943a6714eeb7f17eb0d423e82140851051f290';

export type Claim = {
  "id": string;
  "fence": number;
};

export type ExecutionRef = {
  "key": string;
};

export type Submit = {
  "target_agent_id": string;
  "connection_id"?: string;
  "context_id"?: string;
  "message": string;
};

export type Start = {
  "claim": Claim;
  "execution_ref": ExecutionRef;
};

export type Lease = {
  "claim": Claim;
};

export type Report = {
  "claim": Claim;
  "event_id": string;
  "kind": "progress" | "input_required" | "completed" | "failed" | "cancel_confirmed" | "outcome_unknown";
  "text": string;
};

export type Input = {
  "text": string;
};

export type Empty = {

};

export type Recover = Start;

export type Work = {
  "id": string;
  "context_id": string;
  "caller_agent_id": string | null;
  "target_agent_id": string;
  "endpoint_id": string | null;
  "connection_id": string | null;
  "target_name": string;
  "target_handle": string;
  "status": "queued" | "dispatching" | "working" | "input_required" | "payment_required" | "completed" | "failed" | "unknown" | "canceled";
  "request": {
  "message": string;
  "tool": string;
  "arguments": Record<string, unknown>;
};
  "result": Record<string, unknown>;
  "error_code": string;
  "remote_task_id": string;
  "cancel_requested_at": string | null;
  "deadline_at": string | null;
  "created_at": string;
  "updated_at": string;
};

export type Delivery = {
  "id": number;
  "kind": "work" | "result" | "input" | "cancel" | "input_required";
  "work": Work;
  "event": Record<string, unknown>;
};

export type Inbox = {
  "items": Array<Delivery>;
  "next_cursor": number | null;
};

export type ServiceQuoteRequest = {
  "payment_method": "free" | "envar_balance";
  "service_id": string;
  "offer_id": string;
  "revision_id"?: string;
  "input": Record<string, unknown>;
  "message_id": string;
};

export type ServiceConfirmation = {
  "message_id": string;
  "quote_token": string;
  "spending_grant_id"?: string;
};

export type OrderQuote = {
  "quote_token"?: string;
  "quote_id": string;
  "task_id": string;
  "amount": string;
  "currency": "usd";
  "recipient": string;
  "expires_at": string;
  "terms_digest": string;
  "input_digest": string;
};

export type Order = {
  "id": string;
  "message_id": string;
  "service_id": string;
  "offer_id": string;
  "seller_agent_id": string;
  "buyer_agent_id": string | null;
  "work_id": string | null;
  "spending_grant_id": string | null;
  "payment_method": "free" | "envar_balance";
  "state": string;
  "payment_state": string;
  "execution_state": string;
  "quote": OrderQuote;
  "result": Record<string, unknown>;
  "task": Record<string, unknown>;
  "input": Record<string, unknown> | null;
  "last_error": string;
};

export type ConfirmOrderResult = {
  "order": Order;
  "approval_required": boolean;
  "approval_url"?: string;
};
