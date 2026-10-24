/** Wraps any SyncTransport with failure injection (offline, lost responses, 5xx). */
import {
  TransientSyncError,
  type ApplyMutationsRequest,
  type ApplyMutationsResponse,
  type PullChangesResponse,
  type SyncTransport,
  type Uuid,
} from '@/src/contracts';

export class ChaosTransport implements SyncTransport {
  online = true;
  private lose = 0;
  private fail = 0;
  calls = 0;

  constructor(private readonly inner: SyncTransport) {}

  loseNextResponses(n = 1): void {
    this.lose += n;
  }

  failNext(n = 1): void {
    this.fail += n;
  }

  /** Network healthy again: drops pending injected failures. */
  heal(): void {
    this.online = true;
    this.lose = 0;
    this.fail = 0;
  }

  private pre(): void {
    this.calls++;
    if (!this.online) throw new TransientSyncError('offline');
    if (this.fail > 0) {
      this.fail--;
      throw new TransientSyncError('HTTP 503');
    }
  }

  async applyMutations(req: ApplyMutationsRequest): Promise<ApplyMutationsResponse> {
    this.pre();
    const res = await this.inner.applyMutations(req);
    if (this.lose > 0) {
      this.lose--;
      throw new TransientSyncError('response lost');
    }
    return res;
  }

  async pullChanges(householdId: Uuid, sinceSeq: number, limit?: number): Promise<PullChangesResponse> {
    this.pre();
    return this.inner.pullChanges(householdId, sinceSeq, limit);
  }

  subscribe(householdId: Uuid, onNudge: (source: 'items' | 'household' | 'membership') => void): () => void {
    return this.inner.subscribe(householdId, (s) => {
      if (this.online) onNudge(s);
    });
  }
}
