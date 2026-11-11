import type { FleetSnapshot, Step } from '../../../shared/types';

/**
 * The seam that makes airoom scalable.
 *
 * The rest of the app only ever talks to this interface. Today the only
 * implementation is LocalClaudeDataSource (reads ~/.claude/projects on this
 * machine). Later, a RemoteAgentDataSource / hub can implement the same shape
 * to aggregate many machines or many users — the server gateway and the whole
 * web client stay untouched.
 */
export interface DataSource {
  /** Compute the current fleet snapshot from scratch. */
  getSnapshot(): Promise<FleetSnapshot>;

  /** Fuller activity feed for one robot (the detail panel calls this). */
  getTranscript(sessionId: string, limit?: number): Promise<{ steps: Step[]; hasMore: boolean }>;

  /**
   * Register a project directory as a room, even before it has any sessions.
   * Returns null on success or a human-readable error message.
   */
  addProject(path: string): Promise<string | null>;
  /** Put a room away / bring it back. Never touches transcripts on disk. */
  setHidden?(path: string, hidden: boolean): Promise<string | null>;
  hiddenProjects?(): Promise<string[]>;
  /** Settle which found projects show: these are put away, the rest stay, and
   *  the first-run question is marked answered. */
  curate?(hidden: string[]): Promise<string | null>;

  /** Let one agent go / bring it back. Also never touches transcripts. */
  setSessionHidden?(sessionId: string, hidden: boolean): Promise<string | null>;
  hiddenSessions?(): Promise<string[]>;
  /** Delete a conversation. Implementations must make this recoverable. */
  deleteSession?(sessionId: string): Promise<{ error?: string; movedTo?: string }>;

  /**
   * Subscribe to change notifications. The callback fires (debounced) whenever
   * underlying data changes. Returns an unsubscribe function.
   */
  onChange(cb: () => void): () => void;

  /** Release watchers / handles. */
  close(): Promise<void>;
}
