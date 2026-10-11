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

export type OpportunitySource =
  | "Unstop"
  | "Devfolio"
  | "HackerEarth"
  | "SIH Portal"
  | "AWS User Group"
  | "Google Developers"
  | "Campus"
  | "Virtual";

export type ApplicationStatus =
  | "Applied / Registered"
  | "Shortlisted"
  | "Offline Pass Ready"
  | "Attended";

export interface StudentProfile {
  fullName: string;
  collegeName: string;
  rollNoOrEmail: string;
  degreeBranch?: string;
  yearOfStudy?: string;
}

export interface StudentApplication {
  id?: number;
  eventId: string;
  studentEmail: string;
  status: ApplicationStatus;
  appliedAt: string;
  notes?: string;
  teamName?: string;
}

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
  /** Registration platform, e.g. Unstop, Devfolio, HackerEarth. */
  platform?: string;
  sourceBadge: OpportunitySource;
  applyUrl: string;
  /** ISO 8601 (UTC). Rendered in IST (Asia/Kolkata) by the UI. */
  startsAt: string;
  /** ISO 8601 (UTC). */
  endsAt: string;
  organizer: string;
  registered: number;
  capacity: number;
  prizePool?: string;
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
  applications!: Table<StudentApplication, number>;

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

    // v3: student applications tracker
    this.version(3)
      .stores({
        pendingCheckins: "++id, &idempotencyKey, eventId, status, checkedInAt",
        cachedEvents: "id, category, mode, regionGroup, startsAt",
        applications: "++id, &[eventId+studentEmail], eventId, studentEmail, status, appliedAt",
      });
  }
}

/** Singleton. Constructing it is safe during SSR; IndexedDB is only touched when a method runs. */
export const db = new EventSyncDB();

export const UNSYNCED_STATUSES: CheckinStatus[] = ["pending", "syncing"];

export async function getStudentApplications(studentEmail: string): Promise<StudentApplication[]> {
  try {
    return await db.applications.where("studentEmail").equalsIgnoreCase(studentEmail.trim()).toArray();
  } catch {
    return [];
  }
}

export async function saveStudentApplication(app: Omit<StudentApplication, "id">): Promise<StudentApplication> {
  const normalizedEmail = app.studentEmail.trim().toLowerCase();
  const existing = await db.applications
    .where({ eventId: app.eventId, studentEmail: normalizedEmail })
    .first();

  if (existing && existing.id) {
    const updated: StudentApplication = { ...existing, ...app, studentEmail: normalizedEmail };
    await db.applications.put(updated);
    return updated;
  }

  const newApp: StudentApplication = { ...app, studentEmail: normalizedEmail };
  const id = await db.applications.add(newApp);
  return { ...newApp, id };
}

export async function updateApplicationStatus(
  id: number,
  status: ApplicationStatus,
): Promise<void> {
  await db.applications.update(id, { status });
}

export async function removeStudentApplication(id: number): Promise<void> {
  await db.applications.delete(id);
}

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
      title: "Grevix AfterCode 24H Solo Hackathon",
      description:
        "Official 24-hour solo engineering hackathon hosted on Unstop. Build, ship, and deploy a production offline-capable web or mobile system. Evaluated on architecture resilience, code clarity, and functional deployment.",
      category: "Hackathons",
      mode: "Online",
      tags: ["solo", "24-hour", "unstop", "offline-first", "nextjs", "dexie"],
      location: "Unstop Arena (Online)",
      city: "Online",
      stateRegion: "Pan-India",
      regionGroup: "Virtual / Global",
      feeInINR: 0,
      platform: "Unstop",
      sourceBadge: "Unstop",
      applyUrl: "https://unstop.com/hackathons/grevix-aftercode-solo-2026",
      prizePool: "₹1,50,000 Cash Pool + Tech Interview Fastrack",
      ...istSlot(1, 10, 24),
      organizer: "Grevix Official",
      registered: 4200,
      capacity: 5000,
    },
    {
      id: "evt-sih-portal-2026",
      title: "Smart India Hackathon 2026",
      description:
        "India's premier nationwide innovation initiative by the Ministry of Education's Innovation Cell (MIC) & AICTE. Solve real-world problem statements posed by central ministries, state departments, and top industries with a team of 6.",
      category: "Hackathons",
      mode: "In-Person",
      tags: ["sih-2026", "ministry-problems", "team-of-6", "national-stage", "hardware-software"],
      location: "SIH Portal & Designated Nodal Centers",
      city: "Pan-India Centers",
      stateRegion: "Pan-India",
      regionGroup: "Other India",
      feeInINR: 0,
      platform: "SIH Portal",
      sourceBadge: "SIH Portal",
      applyUrl: "https://www.sih.gov.in/",
      prizePool: "₹1,00,000 per Problem Statement",
      ...istSlot(5, 9, 36),
      organizer: "Ministry of Education (MoE) Innovation Cell",
      registered: 35000,
      capacity: 50000,
    },
    {
      id: "evt-devfolio-global-series",
      title: "Devfolio Global Hackathon Series",
      description:
        "Devfolio's official flagship builder sprint across Web3, decentralized protocols, AI agents, and developer tooling. Access exclusive mentor office hours, bounties, and direct seed grants.",
      category: "Hackathons",
      mode: "Online",
      tags: ["devfolio", "web3", "ai-agents", "open-source", "grants"],
      location: "Devfolio Official Portal",
      city: "Online",
      stateRegion: "Pan-India",
      regionGroup: "Virtual / Global",
      feeInINR: 0,
      platform: "Devfolio",
      sourceBadge: "Devfolio",
      applyUrl: "https://devfolio.co/hackathons",
      prizePool: "$25,000 USD Bounties & Builder Grants",
      ...istSlot(7, 18, 48),
      organizer: "Devfolio Official",
      registered: 3200,
      capacity: 5000,
    },
    {
      id: "evt-aws-community-day-2026",
      title: "AWS Community Day India 2026",
      description:
        "Official community-organized technical conference led by AWS User Groups across India. In-depth technical tracks covering Serverless, Distributed Architecture, Cloud Security, and Generative AI on AWS.",
      category: "Conferences",
      mode: "Hybrid",
      tags: ["aws", "cloud", "serverless", "generative-ai", "community"],
      location: "Bengaluru Convention Center & Official Stream",
      city: "Bengaluru",
      stateRegion: "Karnataka",
      regionGroup: "Bengaluru",
      feeInINR: 250,
      platform: "AWS User Group India",
      sourceBadge: "AWS User Group",
      applyUrl: "https://communityday.awsug.in/",
      prizePool: "AWS Cloud Credits & Certification Vouchers",
      ...istSlot(12, 9, 9),
      organizer: "AWS User Group India",
      registered: 1100,
      capacity: 1500,
    },
    {
      id: "evt-google-ai-apac-developer",
      title: "Google AI APAC Developer Challenge",
      description:
        "Official developer initiative by Google Developers APAC. Build production-grade multimodal applications using Gemini 2.5 Flash, Vertex AI, and Google Cloud infrastructure with verifiable participant credentials.",
      category: "Hackathons",
      mode: "Online",
      tags: ["google", "gemini-api", "vertex-ai", "apac", "google-developers"],
      location: "Google Developers Portal (Virtual APAC)",
      city: "Online",
      stateRegion: "Global",
      regionGroup: "Virtual / Global",
      feeInINR: 0,
      platform: "Google Developers",
      sourceBadge: "Google Developers",
      applyUrl: "https://developers.google.com/community/gdg",
      prizePool: "$35,000 USD Google Cloud Credits & Badges",
      ...istSlot(3, 14, 6),
      organizer: "Google Developers",
      registered: 5800,
      capacity: 10000,
    },
  ];
}
