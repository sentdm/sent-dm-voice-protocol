// The frames this sample reads and sends, with the field names of schemas/frames/*.json. A frame can carry
// fields a reader does not know, so these types name only what the sample uses.

/** One end of a call: user, number, conference, agent or anonymous, and Sent may add kinds. */
export type Party = { kind: string; value?: string };

/** How to resume the session on a new connection: a one-time secret, and how long Sent keeps the session. */
export type Resume = { token: string; window_ms: number };

export type ErrorDetail = { code: string; message: string };

// Frames Sent sends.

export type ConnectionReady = {
  type: 'connection.ready';
  protocol_version: string;
  heartbeat_interval_ms: number;
  max_sessions: number;
};

export type ConnectionDraining = { type: 'connection.draining' };

export type Ping = { type: 'ping'; ts: number };

export type ErrorFrame = { type: 'error'; error: ErrorDetail; session_id?: string; frame_type?: string };

export type SessionStart = {
  type: 'session.start';
  session_id: string;
  call_id: string;
  agent_id: string;
  direction: 'inbound' | 'outbound';
  from: Party;
  to: Party;
  session_type: 'text' | 'audio';
  language?: string;
  audio?: { stream: number; sample_rate?: 8000 | 16000 | 24000 };
  max_duration_ms?: number;
  context?: Record<string, unknown>;
  resume?: Resume;
  started_at: string;
};

export type UserSaid = { type: 'user.said'; session_id: string; text: string; correction?: boolean };

export type ToolResult = {
  type: 'tool.result';
  session_id: string;
  call_ref: string;
  ok: boolean;
  error?: ErrorDetail;
};

export type SessionEnd = { type: 'session.end'; session_id: string; reason: string; duration_ms: number };

export type SessionResumed = {
  type: 'session.resumed';
  session_id: string;
  received: number;
  resume?: Resume;
  audio?: { stream: number };
};

export type SentFrame =
  | ConnectionReady
  | ConnectionDraining
  | Ping
  | ErrorFrame
  | SessionStart
  | UserSaid
  | ToolResult
  | SessionEnd
  | SessionResumed;

// Frames the agent sends.

export type Pong = { type: 'pong'; ts: number };

export type AgentSay = {
  type: 'agent.say';
  session_id: string;
  text: string;
  interruptible?: boolean;
  last?: boolean;
};

export type AgentClear = { type: 'agent.clear'; session_id: string };

export type ToolCall = {
  type: 'tool.call';
  session_id: string;
  call_ref: string;
  name: string;
  arguments?: Record<string, unknown>;
};

export type SessionResume = { type: 'session.resume'; session_id: string; token: string; received: number };

/** The agent's frames that count towards a resume's received: those for a session, except session.resume. */
export type SessionFrame = AgentSay | AgentClear | ToolCall;

export type AgentFrame = Pong | SessionFrame | SessionResume;

/** The answer to a ping: a pong with the same ts. */
export const pong = (ping: Ping): Pong => ({ type: 'pong', ts: ping.ts });
