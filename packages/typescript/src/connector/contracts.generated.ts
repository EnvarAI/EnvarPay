// Generated from the canonical Envar Agent Work v1 JSON Schema. Do not edit.
// Source: EnvarAI/EnvarAI server/contracts/agent-work/v1/schema.json
export const WORK_SCHEMA_SHA256 = 'a23da2d5992ea8942456b640c43ec742fae20c0786f37abfdef156a50244422c';

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
