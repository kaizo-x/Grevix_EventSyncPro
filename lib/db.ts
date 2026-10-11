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
  | "Campus"
  | "SIH Portal"
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
      title: "Grevix AfterCode Solo Hackathon 2026",
      description:
        "Build and ship a complete offline-first web/mobile project solo in 24 hours. Submit your GitHub repo & live deployment to win cash prizes and direct interview opportunities.",
      category: "Hackathons",
      mode: "Online",
      tags: ["solo", "24-hour", "unstop", "offline-first", "nextjs", "dexie"],
      location: "Unstop Virtual Arena",
      city: "Online",
      stateRegion: "Pan-India",
      regionGroup: "Virtual / Global",
      feeInINR: 0,
      platform: "Unstop",
      sourceBadge: "Unstop",
      applyUrl: "https://unstop.com/hackathons/grevix-aftercode-solo-2026",
      prizePool: "₹1,50,000 Cash + Swag",
      ...istSlot(1, 10, 24),
      organizer: "Grevix Labs",
      registered: 4200,
      capacity: 5000,
    },
    {
      id: "evt-sih-portal-2026",
      title: "Smart India Hackathon 2026 (SIH Portal)",
      description:
        "India's premier nationwide innovation initiative by MoE. Solve real-world problem statements posed by central ministries, state departments, and top industries with a team of 6.",
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
      organizer: "Ministry of Education Innovation Cell",
      registered: 35000,
      capacity: 50000,
    },
    {
      id: "evt-devfolio-winter-sprint",
      title: "Devfolio Winter Hack Sprint 2026",
      description:
        "Rapid 48-hour builder sprint across Web3, AI, and developer infrastructure tracks. Direct mentor office hours with tier-1 venture scouts and global devrel leads.",
      category: "Hackathons",
      mode: "Online",
      tags: ["devfolio", "web3", "ai-agents", "48-hours", "open-source"],
      location: "Devfolio Portal",
      city: "Online",
      stateRegion: "Pan-India",
      regionGroup: "Virtual / Global",
      feeInINR: 0,
      platform: "Devfolio",
      sourceBadge: "Devfolio",
      applyUrl: "https://devfolio.co/hackathons/winter-sprint-2026",
      prizePool: "$20,000 USD Grants & Bounties",
      ...istSlot(7, 18, 48),
      organizer: "Devfolio Community",
      registered: 2890,
      capacity: 4000,
    },
    {
      id: "evt-hackerearth-apac-cup",
      title: "HackerEarth Collegiate Code Arena",
      description:
        "High-octane competitive programming challenge featuring algorithmic graph problems, dynamic programming, and systems design. Fast-track hiring interviews with top tech firms.",
      category: "Hackathons",
      mode: "Online",
      tags: ["hackerearth", "dsa", "competitive-programming", "internships"],
      location: "HackerEarth Platform",
      city: "Online",
      stateRegion: "Global",
      regionGroup: "Virtual / Global",
      feeInINR: 0,
      platform: "HackerEarth",
      sourceBadge: "HackerEarth",
      applyUrl: "https://www.hackerearth.com/challenges/collegiate-arena-2026",
      prizePool: "₹75,000 + Tech Interviews",
      ...istSlot(3, 17, 3),
      organizer: "HackerEarth Campus Network",
      registered: 1840,
      capacity: 3000,
    },
    {
      id: "evt-ruia-techfest-2026",
      title: "Ruia TechFest 2026 (Campus Flagship)",
      description:
        "Annual intercollegiate technical festival at Ramnarain Ruia College featuring Web3 sprint, robotics arena, code debugging marathon, and project exhibition showcase.",
      category: "Fests",
      mode: "In-Person",
      tags: ["campus", "mumbai-colleges", "robotics", "project-expo", "web3"],
      location: "Ruia College Campus, Matunga",
      city: "Mumbai",
      stateRegion: "Maharashtra",
      regionGroup: "Mumbai / Pune",
      feeInINR: 50,
      platform: "Campus Registration Desk",
      sourceBadge: "Campus",
      applyUrl: "https://ruia.edu/techfest-2026",
      prizePool: "₹60,000 Trophy & Certificates",
      ...istSlot(4, 9, 8),
      organizer: "Ruia Coding Club & Student Council",
      registered: 620,
      capacity: 800,
    },
    {
      id: "evt-global-ai-apac-challenge",
      title: "Global AI APAC Challenge (Google / Virtual)",
      description:
        "Build production-grade Multimodal AI applications and autonomous agents with Gemini 2.5 Flash and Google Cloud Vertex AI. Certified participation badge for all valid submissions.",
      category: "Hackathons",
      mode: "Online",
      tags: ["google", "gemini-api", "apac", "genai", "vertex-ai"],
      location: "Google Developer Groups (Virtual APAC)",
      city: "Online",
      stateRegion: "Global",
      regionGroup: "Virtual / Global",
      feeInINR: 0,
      platform: "Google Virtual",
      sourceBadge: "Virtual",
      applyUrl: "https://developers.google.com/community/gdg/challenges/apac-ai",
      prizePool: "$35,000 Google Cloud Credits",
      ...istSlot(2, 14, 6),
      organizer: "Google Developer Groups APAC",
      registered: 5400,
      capacity: 10000,
    },
    {
      id: "evt-pune-campus-offline-meet",
      title: "Pune Student DevCon & Open Source Jam",
      description:
        "Student-led developer summit covering Next.js 16, Service Worker PWA architectures, IndexedDB synchronization, and networking with tech founders.",
      category: "Meetups",
      mode: "In-Person",
      tags: ["pune", "campus", "offline-first", "students", "networking"],
      location: "COEP Tech Auditorium, Shivaji Nagar",
      city: "Pune",
      stateRegion: "Maharashtra",
      regionGroup: "Mumbai / Pune",
      feeInINR: 0,
      platform: "Campus Innovation Cell",
      sourceBadge: "Campus",
      applyUrl: "https://coep.ac.in/events/devcon-2026",
      prizePool: "Swag Bags & Cloud Vouchers",
      ...istSlot(6, 11, 5),
      organizer: "COEP Open Source Circle",
      registered: 210,
      capacity: 300,
    },
    {
      id: "evt-blr-student-hack-sprint",
      title: "Bengaluru Student AI Hackfest (HackerEarth)",
      description:
        "48-hour prototype hackathon for engineering undergrads in Karnataka. Build resilient applications and showcase in front of Bengaluru tech leads.",
      category: "Hackathons",
      mode: "In-Person",
      tags: ["hackerearth", "bengaluru", "students", "ai", "prototyping"],
      location: "Koramangala Community Hub",
      city: "Bengaluru",
      stateRegion: "Karnataka",
      regionGroup: "Bengaluru",
      feeInINR: 100,
      platform: "HackerEarth",
      sourceBadge: "HackerEarth",
      applyUrl: "https://www.hackerearth.com/challenges/hackathon/blr-student-hack-2026",
      prizePool: "₹1,20,000 Prize Fund",
      ...istSlot(9, 10, 48),
      organizer: "Bangalore Student Tech Chapter",
      registered: 490,
      capacity: 600,
    },
  ];
}
