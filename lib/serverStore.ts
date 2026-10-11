import { buildSeedEvents, type EventItem } from "@/lib/db";

export interface LedgerEntry {
  /** Strictly increasing ledger position, assigned by the server when the record is accepted. */
  seq: number;
  idempotencyKey: string;
  eventId: string;
  attendeeName: string;
  attendeeEmail: string;
  /** Device clock at check-in time. */
  checkedInAt: string;
  /** Server clock when the record was accepted. */
  receivedAt: string;
  /** Seconds between check-in (device clock) and receipt (server clock). */
  delaySeconds: number;
  /** true when the check-in waited in an offline queue before reaching the server. */
  offlineQueued: boolean;
  ticketHash: string;
  /** true when the SHA-256 ticket hash was recomputed and matched. */
  verified: boolean;
}

interface Store {
  events: EventItem[];
  lastSeq: number;
  /** Keyed by idempotencyKey. Map preserves insertion order. */
  ledger: Map<string, LedgerEntry>;
  /** `${eventId}|${email}` pairs already checked in, so a second device cannot double count a person. */
  people: Set<string>;
}

const globalForStore = globalThis as unknown as { __grevixStore?: Store };

/**
 * Hackathon-grade persistence: a process-wide singleton that survives Next.js hot reloads in dev.
 * Swap this module for a real database (Postgres, Redis, ...) without touching the route handlers' logic.
 */
export function getStore(): Store {
  if (!globalForStore.__grevixStore) {
    globalForStore.__grevixStore = {
      events: buildSeedEvents(),
      lastSeq: 0,
      ledger: new Map(),
      people: new Set(),
    };
  }
  return globalForStore.__grevixStore;
}
