/**
 * Tracks which signed-in account owns asynchronous work.
 *
 * Access-token rotation is deliberately not a session boundary: Supabase can
 * refresh a token while requests for the same account are in flight. Signing
 * in, signing out, or replacing one account with another is a boundary and
 * advances the monotonic generation.
 */
export class SessionGeneration {
  private accountId: string | null = null;
  private generation = 0;

  capture(): number {
    return this.generation;
  }

  isCurrent(captured: number): boolean {
    return captured === this.generation;
  }

  updateAccount(accountId: string | null): boolean {
    if (accountId === this.accountId) return false;
    this.accountId = accountId;
    this.generation += 1;
    return true;
  }
}

/** A small reusable guard for latest-request-wins stores. */
export class RequestGeneration {
  private generation = 0;

  capture(): number {
    return this.generation;
  }

  next(): number {
    this.generation += 1;
    return this.generation;
  }

  invalidate(): void {
    this.generation += 1;
  }

  isCurrent(captured: number): boolean {
    return captured === this.generation;
  }
}
