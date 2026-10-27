// What happens inside one session, with no socket in sight: the frames the agent sends in answer to Sent's,
// the count of Sent's frames it has read, and what it takes to move the session to another connection. The
// agent in agent.ts sends every frame a method here returns, in order, on the connection the session is on.
import type {
  AgentClear,
  AgentSay,
  SessionFrame,
  SessionResume,
  SessionResumed,
  SessionStart,
  ToolCall,
  UserSaid,
} from './frames.ts';

/**
 * How many of its latest counted frames each side keeps for each session, to send again on a resume:
 * x-sent-retained-frames in asyncapi.yaml.
 */
export const RETAINED_FRAMES = 32;

/**
 * Sent's frames that do not count towards received: the ones asyncapi.yaml marks x-sent-counted: false.
 * Every other frame with the session's session_id counts, also one of a type this sample does not know.
 */
const UNCOUNTED = new Set(['session.start', 'session.resumed', 'error']);

export const GREETING =
  "Hi, this is the Sent echo agent. I'll say back whatever you say. Say transfer, hold, resume, or goodbye to try a tool.";

/** What the caller says, once case and punctuation are dropped, to run a tool instead of hearing an echo. */
const COMMANDS: Record<string, 'transfer' | 'hold' | 'resume' | 'hangup'> = {
  transfer: 'transfer',
  hold: 'hold',
  resume: 'resume',
  'hang up': 'hangup',
  hangup: 'hangup',
  goodbye: 'hangup',
  bye: 'hangup',
};

export type SessionOptions = {
  /** The E.164 number the transfer command moves the call to. Without it, the command is refused in speech. */
  transferTo?: string;
};

/** The last line of a user.said: a correction carries the whole transcript so far, one utterance per line. */
export const latestLine = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? '';

const command = (line: string) =>
  COMMANDS[
    line
      .toLowerCase()
      .replace(/[^a-z ]/g, '')
      .replace(/ +/g, ' ')
      .trim()
  ];

export class Session {
  readonly id: string;
  readonly callId: string;
  readonly type: 'text' | 'audio';
  /** Hz of the session's 16-bit mono PCM, both ways, in an audio session. */
  readonly sampleRate: number;
  /** The number in the header of the session's binary audio frames on its current connection. */
  stream: number | undefined;
  /** The latest resume token, or undefined when the session cannot be resumed. Keep it out of logs. */
  token: string | undefined;
  /** How many of Sent's counted frames for the session the agent has read: the received of a session.resume. */
  received = 0;
  /** Audio frames sent back, for the log. */
  audioFrames = 0;
  /** The latest counted frames the agent sent, to send again those Sent did not read, and how many came before them. */
  private kept: SessionFrame[] = [];
  private before = 0;
  private calls = 0;
  private readonly transferTo: string | undefined;

  constructor(start: SessionStart, options: SessionOptions = {}) {
    this.id = start.session_id;
    this.callId = start.call_id;
    this.type = start.session_type;
    this.sampleRate = start.audio?.sample_rate ?? 16000;
    this.stream = start.audio?.stream;
    this.token = start.resume?.token;
    this.transferTo = options.transferTo;
  }

  /** How many counted frames the agent has sent for the session. */
  get sent(): number {
    return this.before + this.kept.length;
  }

  /** What to send once the session has started: a text session hears a greeting, an audio session nothing. */
  greeting(): SessionFrame[] {
    return this.type === 'text' ? [this.say(GREETING)] : [];
  }

  /** Reads one of Sent's frames for the session, counts it, and returns the frames to send in answer. */
  read(frame: { type: string; session_id: string; [field: string]: unknown }): SessionFrame[] {
    if (!UNCOUNTED.has(frame.type)) this.received++;
    return frame.type === 'user.said' ? this.answer(frame as UserSaid) : [];
  }

  /** The frame that moves the session to a new connection, with its latest token and count. */
  resumeFrame(): SessionResume {
    if (!this.token) throw new Error(`session ${this.id} has no resume token`);
    return { type: 'session.resume', session_id: this.id, token: this.token, received: this.received };
  }

  /**
   * Takes the answer to a session.resume: the next token, the session's stream on the new connection, and how
   * many of the agent's frames Sent read. Returns the frames to send again, or a hangup when Sent needs one
   * the session no longer keeps.
   */
  resumed(frame: SessionResumed): SessionFrame[] {
    this.token = frame.resume?.token;
    if (frame.audio) this.stream = frame.audio.stream;
    // Without a next token the session ended while it was detached: its replay ends with session.end.
    if (!frame.resume) return [];
    const unread = frame.received < this.before ? undefined : this.kept.slice(frame.received - this.before);
    this.before = frame.received;
    this.kept = [];
    return unread ? unread.map((again) => this.keep(again)) : [this.tool('hangup')];
  }

  private answer(frame: UserSaid): SessionFrame[] {
    const frames: SessionFrame[] = [];
    // A correction replaces an utterance this agent has already answered, so that answer is dropped first.
    if (frame.correction) frames.push(this.clear());
    const line = latestLine(frame.text);
    if (!line) return frames;
    switch (command(line)) {
      case 'transfer':
        if (!this.transferTo) return [...frames, this.say('No transfer target is set.')];
        return [
          ...frames,
          this.say('Transferring you now.'),
          this.tool('transfer', { to: { kind: 'number', value: this.transferTo } }),
        ];
      case 'hold':
        return [...frames, this.say('Please hold.'), this.tool('hold', { held: true })];
      case 'resume':
        return [...frames, this.tool('hold', { held: false }), this.say("I'm back.")];
      case 'hangup':
        // The tool runs after the speech queued before it, so the caller hears the goodbye.
        return [...frames, this.say('Goodbye.'), this.tool('hangup')];
      default:
        return [...frames, this.say(line)];
    }
  }

  private say(text: string): AgentSay {
    return this.keep({ type: 'agent.say', session_id: this.id, text });
  }

  private clear(): AgentClear {
    return this.keep({ type: 'agent.clear', session_id: this.id });
  }

  private tool(name: string, args?: Record<string, unknown>): ToolCall {
    const frame: ToolCall = { type: 'tool.call', session_id: this.id, call_ref: `t${++this.calls}`, name };
    if (args) frame.arguments = args;
    return this.keep(frame);
  }

  /** Counts a frame as sent, and keeps it while it is among the latest RETAINED_FRAMES. */
  private keep<T extends SessionFrame>(frame: T): T {
    if (this.kept.push(frame) > RETAINED_FRAMES) {
      this.kept.shift();
      this.before++;
    }
    return frame;
  }
}
