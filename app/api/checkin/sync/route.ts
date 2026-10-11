import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getStore, type LedgerEntry } from "@/lib/serverStore";
import type { AnalyticsSnapshot } from "@/lib/db";

const MAX_BATCH = 200;
const LEDGER_LIMIT = 25;
const CLOCK_SKEW_MS = 10 * 60 * 1000;
/** A check-in older than this when it arrives is labelled as having waited in an offline queue. */
const OFFLINE_THRESHOLD_SECONDS = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NO_STORE = { "Cache-Control": "no-store" };

type ResultStatus = "accepted" | "duplicate" | "rejected";

interface ItemResult {
  idempotencyKey: string;
  status: ResultStatus;
  reason?: string;
}

interface ValidCheckin {
  idempotencyKey: string;
  eventId: string;
  attendeeName: string;
  attendeeEmail: string;
  checkedInAt: string;
  ticketHash: string;
}

/** Must match `ticketPayload` in lib/db.ts exactly. */
function expectedHash(
  c: Pick<
    ValidCheckin,
    "eventId" | "attendeeEmail" | "checkedInAt" | "idempotencyKey"
  >,
): string {
  return createHash("sha256")
    .update(
      [c.eventId, c.attendeeEmail, c.checkedInAt, c.idempotencyKey].join("|"),
    )
    .digest("hex");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validate(
  raw: unknown,
  knownEventIds: Set<string>,
):
  | { ok: true; value: ValidCheckin }
  | { ok: false; key: string; reason: string } {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const value: ValidCheckin = {
    idempotencyKey: asString(obj.idempotencyKey),
    eventId: asString(obj.eventId),
    attendeeName: asString(obj.attendeeName),
    attendeeEmail: asString(obj.attendeeEmail).toLowerCase(),
    checkedInAt: asString(obj.checkedInAt),
    ticketHash: asString(obj.ticketHash),
  };
  const key = value.idempotencyKey || "(missing key)";

  if (!value.idempotencyKey)
    return { ok: false, key, reason: "Missing idempotencyKey." };
  if (!knownEventIds.has(value.eventId))
    return { ok: false, key, reason: "Unknown event." };
  if (value.attendeeName.length < 2 || value.attendeeName.length > 120)
    return { ok: false, key, reason: "Invalid attendee name." };
  if (!EMAIL_RE.test(value.attendeeEmail))
    return { ok: false, key, reason: "Invalid attendee email." };

  const checkedInMs = Date.parse(value.checkedInAt);
  if (Number.isNaN(checkedInMs))
    return { ok: false, key, reason: "Invalid check-in timestamp." };
  if (checkedInMs > Date.now() + CLOCK_SKEW_MS)
    return { ok: false, key, reason: "Check-in timestamp is in the future." };

  if (!value.ticketHash)
    return { ok: false, key, reason: "Missing ticket hash." };
  return { ok: true, value };
}

/**
 * POST /api/checkin/sync
 * Body: { checkins: PendingCheckin[] }
 *
 * Idempotent: replaying the same batch (a retry after a dropped response, a second tab, a second device)
 * never creates duplicate attendance rows. Every item gets its own result so the client can
 * mark exactly those records as synced and keep the rest queued.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400, headers: NO_STORE },
    );
  }

  const list = (body as { checkins?: unknown } | null)?.checkins;
  if (!Array.isArray(list)) {
    return NextResponse.json(
      { error: "Expected { checkins: [...] }." },
      { status: 400, headers: NO_STORE },
    );
  }
  if (list.length > MAX_BATCH) {
    return NextResponse.json(
      {
        error: `Batch too large. Send at most ${MAX_BATCH} check-ins per request.`,
      },
      { status: 413, headers: NO_STORE },
    );
  }

  const store = getStore();
  const knownEventIds = new Set(store.events.map((event) => event.id));
  const results: ItemResult[] = [];

  for (const raw of list) {
    const checked = validate(raw, knownEventIds);
    if (!checked.ok) {
      results.push({
        idempotencyKey: checked.key,
        status: "rejected",
        reason: checked.reason,
      });
      continue;
    }
    const item = checked.value;

    // Integrity check. A `weak-` hash comes from a device without WebCrypto and is accepted but flagged unverified.
    const isWeak = item.ticketHash.startsWith("weak-");
    if (!isWeak && item.ticketHash !== expectedHash(item)) {
      results.push({
        idempotencyKey: item.idempotencyKey,
        status: "rejected",
        reason: "Ticket hash does not match the check-in details.",
      });
      continue;
    }

    // Deduplication: same idempotency key (retry) or same person for the same event (another device).
    const personKey = `${item.eventId}|${item.attendeeEmail}`;
    if (store.ledger.has(item.idempotencyKey) || store.people.has(personKey)) {
      results.push({
        idempotencyKey: item.idempotencyKey,
        status: "duplicate",
      });
      continue;
    }

    // Timestamped ledger: the device clock says when the person checked in, the server clock says when
    // we learned about it. The gap tells organizers which records came through an offline queue.
    const receivedAtMs = Date.now();
    const delaySeconds = Math.max(
      0,
      Math.round((receivedAtMs - Date.parse(item.checkedInAt)) / 1000),
    );
    const entry: LedgerEntry = {
      ...item,
      seq: ++store.lastSeq,
      receivedAt: new Date(receivedAtMs).toISOString(),
      delaySeconds,
      offlineQueued: delaySeconds >= OFFLINE_THRESHOLD_SECONDS,
      verified: !isWeak,
    };
    store.ledger.set(item.idempotencyKey, entry);
    store.people.add(personKey);
    results.push({ idempotencyKey: item.idempotencyKey, status: "accepted" });
  }

  const count = (status: ResultStatus) =>
    results.filter((result) => result.status === status).length;
  return NextResponse.json(
    {
      results,
      accepted: count("accepted"),
      duplicates: count("duplicate"),
      rejected: count("rejected"),
      serverTime: new Date().toISOString(),
    },
    { headers: NO_STORE },
  );
}

/** GET /api/checkin/sync - organizer analytics: server-verified attendance against registrations. */
export async function GET() {
  const store = getStore();
  const entries = Array.from(store.ledger.values());

  const verifiedByEvent = new Map<string, number>();
  for (const entry of entries) {
    verifiedByEvent.set(
      entry.eventId,
      (verifiedByEvent.get(entry.eventId) ?? 0) + 1,
    );
  }

  const percent = (part: number, whole: number) =>
    whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;

  const perEvent = store.events.map((event) => {
    const verified = verifiedByEvent.get(event.id) ?? 0;
    return {
      eventId: event.id,
      title: event.title,
      registered: event.registered,
      verified,
      rate: percent(verified, event.registered),
      feeInINR: event.feeInINR,
    };
  });

  const registrations = store.events.reduce(
    (sum, event) => sum + event.registered,
    0,
  );
  const registrationRevenueINR = store.events.reduce(
    (sum, event) => sum + event.registered * event.feeInINR,
    0,
  );
  const verified = entries.length;
  const titleById = new Map(
    store.events.map((event) => [event.id, event.title]),
  );

  const ledger = entries
    .slice(-LEDGER_LIMIT)
    .reverse()
    .map((entry) => ({
      seq: entry.seq,
      idempotencyKey: entry.idempotencyKey,
      attendeeName: entry.attendeeName,
      eventId: entry.eventId,
      eventTitle: titleById.get(entry.eventId) ?? entry.eventId,
      checkedInAt: entry.checkedInAt,
      receivedAt: entry.receivedAt,
      delaySeconds: entry.delaySeconds,
      offlineQueued: entry.offlineQueued,
      verified: entry.verified,
    }));

  const snapshot: AnalyticsSnapshot = {
    generatedAt: new Date().toISOString(),
    totals: {
      registrations,
      verified,
      conversionRate: percent(verified, registrations),
      registrationRevenueINR,
    },
    perEvent,
    ledger,
  };

  return NextResponse.json(snapshot, { headers: NO_STORE });
}
