import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from 'sqlite';
import { MindPondError } from './errors.js';

/** A transaction belongs to a SQLite connection, not to an individual Promise.
 * All users of that connection share this queue, including standalone reads.
 * Nested store calls reuse the live owner; detached timers cannot inherit it. */
export class ConnectionCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private owner = new AsyncLocalStorage<{ active: boolean; transaction: boolean }>();
  private closed = false;

  /** Timers/background jobs are independent operations even if their creator
   * still owns a transaction when the callback fires. */
  detached<T>(work:()=>Promise<T>):Promise<T> {return this.owner.exit(work);}

  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.owner.getStore()?.active) return work();
    if (this.closed) throw new MindPondError('temporarily_unavailable', 'Memory connection is closing', { retryable: true });
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const token = { active: true, transaction: false };
    try { return await this.owner.run(token, work); }
    finally { token.active = false; release(); }
  }

  async transaction<T>(db: Database, work: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      if (this.owner.getStore()?.transaction) return work();
      await db.exec('BEGIN IMMEDIATE');
      try { const result = await work(); await db.exec('COMMIT'); return result; }
      catch (error) { await db.exec('ROLLBACK'); throw error; }
    });
  }

  connection(db: Database): Database {
    return new Proxy(db, { get: (target, key) => {
      const value = Reflect.get(target, key);
      if (!['get', 'all', 'run', 'exec', 'close'].includes(String(key)) || typeof value !== 'function') return value;
      return (...args: unknown[]) => this.exclusive(async () => {
        const token = this.owner.getStore();
        if (key === 'exec' && /^\s*BEGIN\b/i.test(String(args[0])) && token?.transaction)
          throw new Error('Nested SQLite transaction: use the existing transaction owner');
        const result = await value.apply(target, args);
        if (key === 'exec' && token) {
          if (/^\s*BEGIN\b/i.test(String(args[0]))) token.transaction = true;
          if (/^\s*(COMMIT|ROLLBACK)\s*;?\s*$/i.test(String(args[0]))) token.transaction = false;
        }
        return result;
      });
    } });
  }

  service<T extends object>(service: T, methods: string[]): T {
    return new Proxy(service, { get: (target, key) => {
      const value = Reflect.get(target, key);
      return methods.includes(String(key)) && typeof value === 'function'
        ? (...args: unknown[]) => this.exclusive(() => value.apply(target, args)) : value;
    } });
  }

  async shutdown(close: () => Promise<void>): Promise<void> {
    // Reserve the last queue position before refusing any new owners.
    const completion = this.exclusive(close);
    this.closed = true;
    await completion;
  }
}
