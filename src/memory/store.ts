/**
 * Durable conversation memory backed by SQLite (node:sqlite, zero dependencies).
 *
 * Every user and assistant message is stored with its local calendar day so
 * questions like "what did I ask you on 3 November?" can be answered by
 * exact day lookup, and retrieval can boost same-day turns.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface StoredTurn {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  /** ISO timestamp of when the turn happened. */
  ts: string;
  /** Local calendar day, YYYY-MM-DD - the exact-day lookup key. */
  day: string;
}

export class MemoryStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        ts TEXT NOT NULL,
        day TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_turns_day ON turns(day);
      CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, id);
    `);
  }

  createSession(): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO sessions (id, started_at) VALUES (?, ?)')
      .run(id, new Date().toISOString());
    return id;
  }

  addTurn(sessionId: string, role: 'user' | 'assistant', content: string, now = new Date()): void {
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    this.db.prepare(
      'INSERT INTO turns (session_id, role, content, ts, day) VALUES (?, ?, ?, ?, ?)',
    ).run(sessionId, role, content, now.toISOString(), day);
  }

  /** All turns across every session, oldest first. */
  allTurns(): StoredTurn[] {
    return this.db.prepare(
      'SELECT id, session_id AS sessionId, role, content, ts, day FROM turns ORDER BY id ASC',
    ).all() as unknown as StoredTurn[];
  }

  /** Turns on one exact local calendar day, oldest first. */
  turnsOnDay(day: string): StoredTurn[] {
    return this.db.prepare(
      'SELECT id, session_id AS sessionId, role, content, ts, day FROM turns WHERE day = ? ORDER BY id ASC',
    ).all(day) as unknown as StoredTurn[];
  }

  sessionTurns(sessionId: string): StoredTurn[] {
    return this.db.prepare(
      'SELECT id, session_id AS sessionId, role, content, ts, day FROM turns WHERE session_id = ? ORDER BY id ASC',
    ).all(sessionId) as unknown as StoredTurn[];
  }

  clear(): void {
    this.db.exec('DELETE FROM turns; DELETE FROM sessions;');
  }

  close(): void {
    this.db.close();
  }
}
