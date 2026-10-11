import Dexie, { type Table } from "dexie";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type EventCategory =
  | "Hackathons"
  | "Workshops"
  | "Conferences"
  | "Fests"
  | "Meetups";
export type EventMode = "Online" | "In-Person" | "Hybrid";

/** Drives the region filter chips. "Other India" appears under "All India" only. */
export type RegionGroup =
  | "Mumbai / Pune"
  | "Bengaluru"
  | "Virtual / Global"
  | "Other India";

export interface EventItem {
  id: string;
  title: string;
  description: string;
  category: EventCategory;
  mode: EventMode;
  tags: string[];
  /** Venue or platform line shown on the card. */
  location: string;
  /** City, or "Online" / "Participating colleges". */
  city: string;
  /** Indian state, "Pan-India" or "Global". */
  stateRegion: string;
  regionGroup: RegionGroup;
  /** Registration fee in Indian rupees. 0 means free. */
  feeInINR: number;
  /** Registration platform, e.g. Unstop. */
  platform?: string;
  /** ISO 8601 (UTC). Rendered in IST (Asia/Kolkata) by the UI. */
  startsAt: string;
  /** ISO 8601 (UTC). */
  endsAt: string;
  organizer: string;
  registered: number;
  capacity: number;
}

/** An event row as stored in IndexedDB for offline discovery. */
export interface CachedEvent extends EventItem {
  cachedAt: number;
}

/**
 * pending   - saved on this device, waiting for the server
 * syncing   - currently being sent in a batch
 * synced    - acknowledged by the server (kept locally as the attendee's pass)
 * rejected  - the server refused it (e.g. tampered ticket hash); never retried
 */
export type CheckinStatus = "pending" | "syncing" | "synced" | "rejected";

export interface PendingCheckin {
  id?: number;
  /** Deterministic per (event, attendee). The server uses it to deduplicate. */
  idempotencyKey: string;
  eventId: string;
  attendeeName: string;
  attendeeEmail: string;
  /** ISO timestamp taken on the device at the moment of check-in. */
  checkedInAt: string;
  /** SHA-256 over eventId|email|checkedInAt|idempotencyKey (hex). */
  ticketHash: string;
  status: CheckinStatus;
  attempts: number;
  lastError?: string;
  syncedAt?: string;
  serverResult?: "accepted" | "duplicate";
}

/** Shape returned by GET /api/checkin/sync. */
export interface AnalyticsSnapshot {
  generatedAt: string;
  totals: {
    registrations: number;
    verified: number;
    /** Percentage, 0-100. */
    conversionRate: number;
    /** Sum of registered x feeInINR across events. */
    registrationRevenueINR: number;
  };
  perEvent: {
    eventId: string;
    title: string;
    registered: number;
    verified: number;
    rate: number;
    feeInINR: number;
  }[];
  ledger: {
    /** Server-assigned, strictly increasing ledger sequence number. */
    seq: number;
    idempotencyKey: string;
    attendeeName: string;
    eventId: string;
    eventTitle: string;
    /** Device clock when the attendee checked in. */
    checkedInAt: string;
    /** Server clock when the record was accepted. */
    receivedAt: string;
    /** Seconds between check-in and server receipt. */
    delaySeconds: number;
    /** true when the check-in sat in an offline queue before reaching the server. */
    offlineQueued: boolean;
    verified: boolean;
  }[];
}

/* -------------------------------------------------------------------------- */
/*  Database                                                                  */
/* -------------------------------------------------------------------------- */

export class EventSyncDB extends Dexie {
  pendingCheckins!: Table<PendingCheckin, number>;
  cachedEvents!: Table<CachedEvent, string>;

  constructor() {
    super("grevix_eventsyncpro");

    this.version(1).stores({
      pendingCheckins: "++id, &idempotencyKey, eventId, status, checkedInAt",
      cachedEvents: "id, category, mode, startsAt",
    });

    // v2: events gained feeInINR / stateRegion / regionGroup. Drop stale cached events; they are refetched.
    this.version(2)
      .stores({
        // &idempotencyKey = unique index: the same attendee can never be queued twice on one device.
        pendingCheckins: "++id, &idempotencyKey, eventId, status, checkedInAt",
        cachedEvents: "id, category, mode, regionGroup, startsAt",
      })
      .upgrade((tx) => tx.table("cachedEvents").clear());
  }
}

/** Singleton. Constructing it is safe during SSR; IndexedDB is only touched when a method runs. */
export const db = new EventSyncDB();

export const UNSYNCED_STATUSES: CheckinStatus[] = ["pending", "syncing"];

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

export async function countUnsynced(): Promise<number> {
  return db.pendingCheckins.where("status").anyOf(UNSYNCED_STATUSES).count();
}

export async function cacheEvents(events: EventItem[]): Promise<void> {
  const cachedAt = Date.now();
  await db.transaction("rw", db.cachedEvents, async () => {
    await db.cachedEvents.clear();
    await db.cachedEvents.bulkPut(
      events.map((event) => ({ ...event, cachedAt })),
    );
  });
}

export async function getCachedEvents(): Promise<EventItem[]> {
  return db.cachedEvents.orderBy("startsAt").toArray();
}

export function makeIdempotencyKey(eventId: string, email: string): string {
  return `chk_${eventId}_${email.trim().toLowerCase()}`;
}

/**
 * The string that gets hashed. The API route rebuilds the exact same string to verify
 * the hash, so keep both in sync.
 */
export function ticketPayload(c: {
  eventId: string;
  attendeeEmail: string;
  checkedInAt: string;
  idempotencyKey: string;
}): string {
  return [c.eventId, c.attendeeEmail, c.checkedInAt, c.idempotencyKey].join(
    "|",
  );
}

/** Small non-cryptographic fallback for insecure origins (plain http on a LAN IP) where crypto.subtle is missing. */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** SHA-256 hex via WebCrypto. Falls back to a `weak-` prefixed hash the server marks as unverified. */
export async function createTicketHash(payload: string): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(payload),
    );
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  return `weak-${cyrb53(payload).toString(16).padStart(14, "0")}`;
}

/* -------------------------------------------------------------------------- */
/*  Seed data: Indian student and developer events                            */
/* -------------------------------------------------------------------------- */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * A start/end pair at `hour:minute` India Standard Time, `daysFromNow` days after today (IST),
 * so the demo feed always looks current no matter where the server runs.
 */
function istSlot(
  daysFromNow: number,
  hour: number,
  durationHours: number,
  minute = 0,
) {
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  const startMs =
    Date.UTC(
      istNow.getUTCFullYear(),
      istNow.getUTCMonth(),
      istNow.getUTCDate() + daysFromNow,
      hour,
      minute,
    ) - IST_OFFSET_MS;
  return {
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(startMs + durationHours * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * Sample catalogue for demos. Event names follow well-known Indian formats, but dates, venues, fees,
 * organizers and attendance figures are illustrative placeholders, not live listings.
 */
export function buildSeedEvents(): EventItem[] {
  return [
    {
      id: "evt-grevix-aftercode",
      title: "Grevix AfterCode 24H Hackathon",
      description:
        "Build and ship a complete project solo in 24 hours. Register on Unstop, submit your repo and demo link, and get reviewed by mentors.",
      category: "Hackathons",
      mode: "Online",
      tags: ["solo", "24-hour", "unstop", "web", "offline-first"],
      location: "Unstop (online)",
      city: "Online",
      stateRegion: "Pan-India",
      regionGroup: "Virtual / Global",
      feeInINR: 0,
      platform: "Unstop",
      ...istSlot(1, 10, 24),
      organizer: "Grevix",
      registered: 4200,
      capacity: 5000,
    },
    {
      id: "evt-sih-campus",
      title: "Smart India Hackathon (SIH) Campus Selection",
      description:
        "Internal college round to pick the teams that represent your campus. Pitch a solution to a problem statement and get shortlisted for the national stage.",
      category: "Hackathons",
      mode: "In-Person",
      tags: ["sih", "problem statements", "team of 6", "college round"],
      location: "Your college campus (internal round)",
      city: "Participating colleges",
      stateRegion: "Pan-India",
      regionGroup: "Other India",
      feeInINR: 0,
      ...istSlot(5, 9, 8),
      organizer: "College Innovation Cell",
      registered: 320,
      capacity: 400,
    },
    {
      id: "evt-ruia-codecraft",
      title: "Ruia CodeCraft & Web3 Workshop",
      description:
        "Hands-on day covering smart contract basics and wallet integrations, followed by a short coding contest. Laptops required.",
      category: "Workshops",
      mode: "In-Person",
      tags: ["web3", "solidity", "contest", "college"],
      location: "Ruia College campus",
      city: "Mumbai",
      stateRegion: "Maharashtra",
      regionGroup: "Mumbai / Pune",
      feeInINR: 50,
      ...istSlot(4, 10, 6),
      organizer: "Ruia Coding Club",
      registered: 140,
      capacity: 180,
    },
    {
      id: "evt-sahyadri-fort-hack",
      title: "Sahyadri Fort Hack & Trek",
      description:
        "Hack through the night at a base camp, then trek up a Sahyadri fort at sunrise. Group transport from Pune is available.",
      category: "Hackathons",
      mode: "In-Person",
      tags: ["trek", "overnight", "outdoors", "team"],
      location: "Lonavala base camp, Pune district",
      city: "Lonavala",
      stateRegion: "Maharashtra",
      regionGroup: "Mumbai / Pune",
      feeInINR: 400,
      ...istSlot(8, 18, 20),
      organizer: "Sahyadri Dev Trekkers",
      registered: 85,
      capacity: 100,
    },
    {
      id: "evt-aws-community-day",
      title: "AWS Community Day India",
      description:
        "Community-run day of talks on cloud architecture, serverless and cost control. Attend in Bengaluru or follow the live stream.",
      category: "Conferences",
      mode: "Hybrid",
      tags: ["aws", "cloud", "serverless", "community"],
      location: "Bengaluru venue + live stream",
      city: "Bengaluru",
      stateRegion: "Karnataka",
      regionGroup: "Bengaluru",
      feeInINR: 200,
      ...istSlot(13, 9, 9),
      organizer: "AWS User Group India",
      registered: 780,
      capacity: 1000,
    },
    {
      id: "evt-genai-apac",
      title: "Global AI GenAI APAC Edition",
      description:
        "Virtual sessions for the Asia-Pacific time zones on building with generative AI: prompts, evaluation, retrieval and shipping to production.",
      category: "Conferences",
      mode: "Online",
      tags: ["genai", "llm", "apac", "virtual"],
      location: "Virtual (APAC time zones)",
      city: "Online",
      stateRegion: "Global",
      regionGroup: "Virtual / Global",
      feeInINR: 0,
      ...istSlot(3, 15, 4),
      organizer: "Global AI Community",
      registered: 2600,
      capacity: 5000,
    },
    {
      id: "evt-pune-web-meetup",
      title: "Pune Web Dev Meetup: Offline-First Apps",
      description:
        "Lightning talks and a live demo on PWAs, service workers and IndexedDB sync. Pizza and networking afterwards.",
      category: "Meetups",
      mode: "In-Person",
      tags: ["pwa", "indexeddb", "meetup", "networking"],
      location: "Community co-working space",
      city: "Pune",
      stateRegion: "Maharashtra",
      regionGroup: "Mumbai / Pune",
      feeInINR: 0,
      ...istSlot(2, 18, 3, 30),
      organizer: "Pune Web Devs",
      registered: 64,
      capacity: 80,
    },
    {
      id: "evt-blr-frontend-night",
      title: "Bengaluru Frontend Night",
      description:
        "Three talks on React performance, design systems and accessibility, with time to ask speakers questions over chai.",
      category: "Meetups",
      mode: "In-Person",
      tags: ["react", "design systems", "accessibility", "meetup"],
      location: "Community space",
      city: "Bengaluru",
      stateRegion: "Karnataka",
      regionGroup: "Bengaluru",
      feeInINR: 0,
      ...istSlot(6, 18, 3, 30),
      organizer: "Blr Frontend Folks",
      registered: 150,
      capacity: 200,
    },
    {
      id: "evt-mumbai-intercollege-fest",
      title: "Mumbai Inter-College Tech Fest",
      description:
        "Robotics arena, coding relay, gaming zone and a project expo hosted by colleges across Mumbai. Walk-ins welcome with a pass.",
      category: "Fests",
      mode: "In-Person",
      tags: ["inter-college", "robotics", "expo", "gaming"],
      location: "Host college grounds",
      city: "Mumbai",
      stateRegion: "Maharashtra",
      regionGroup: "Mumbai / Pune",
      feeInINR: 100,
      ...istSlot(10, 10, 9),
      organizer: "Mumbai Student Council Alliance",
      registered: 1800,
      capacity: 2500,
    },
  ];
}
