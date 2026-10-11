import Dexie, { type Table } from "dexie";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type EventStream =
  | "Technology & Engineering"
  | "Business & Management"
  | "Arts, Design & Humanities"
  | "Sciences & Mathematics"
  | "Cross-Disciplinary";

export type EventCategory =
  | "Hackathons"
  | "Workshops"
  | "Conferences"
  | "Fests"
  | "Meetups"
  | "Hackathon"
  | "Workshop"
  | "Competition"
  | "Case Study"
  | "Trading Challenge";

export type EventMode = "Online" | "In-Person" | "Hybrid";

/** Drives the region filter chips. "Other India" appears under "All India" only. */
export type RegionGroup =
  | "Mumbai / Pune"
  | "Delhi / NCR"
  | "Bengaluru"
  | "All India"
  | "Global / Online"
  | "Virtual / Global"
  | "Other India";

export type OpportunitySource =
  | "Unstop"
  | "Devfolio"
  | "HackerEarth"
  | "SIH Portal"
  | "AWS User Group"
  | "Google Developers"
  | "NASA"
  | "Kaggle"
  | "IEEE"
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
  organizer: string;
  stream?: EventStream;
  category: EventCategory;
  mode: EventMode;
  region?: RegionGroup;
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
  feeINR?: number;
  /** Registration platform, e.g. Unstop, Devfolio, HackerEarth. */
  platform?: string;
  sourceBadge: OpportunitySource;
  applyUrl: string;
  hostUrl?: string;
  date?: string;
  /** ISO 8601 (UTC). Rendered in IST (Asia/Kolkata) by the UI. */
  startsAt: string;
  /** ISO 8601 (UTC). */
  endsAt: string;
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
      stream: "Technology & Engineering",
      region: "Global / Online",
      hostUrl: "https://unstop.com/hackathons/grevix-aftercode-solo-2026",
      feeINR: 0,
      date: "October 12, 2026",
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
      region: "All India",
      feeInINR: 0,
      feeINR: 0,
      platform: "SIH Portal",
      sourceBadge: "SIH Portal",
      applyUrl: "https://www.sih.gov.in/",
      hostUrl: "https://www.sih.gov.in/",
      date: "December 2026",
      prizePool: "₹1,00,000 per Problem Statement",
      ...istSlot(5, 9, 36),
      organizer: "Ministry of Education (MoE) Innovation Cell",
      stream: "Technology & Engineering",
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
      region: "Global / Online",
      feeInINR: 0,
      feeINR: 0,
      platform: "Devfolio",
      sourceBadge: "Devfolio",
      applyUrl: "https://devfolio.co/hackathons",
      hostUrl: "https://devfolio.co/hackathons",
      date: "Autumn 2026",
      prizePool: "$25,000 USD Bounties & Builder Grants",
      ...istSlot(7, 18, 48),
      organizer: "Devfolio Official",
      stream: "Technology & Engineering",
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
      region: "Bengaluru",
      feeInINR: 250,
      feeINR: 250,
      platform: "AWS User Group India",
      sourceBadge: "AWS User Group",
      applyUrl: "https://communityday.awsug.in/",
      hostUrl: "https://communityday.awsug.in/",
      date: "November 2026",
      prizePool: "AWS Cloud Credits & Certification Vouchers",
      ...istSlot(12, 9, 9),
      organizer: "AWS User Group India",
      stream: "Technology & Engineering",
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
      region: "Global / Online",
      feeInINR: 0,
      feeINR: 0,
      platform: "Google Developers",
      sourceBadge: "Google Developers",
      applyUrl: "https://developers.google.com/community/gdg",
      hostUrl: "https://developers.google.com/community/gdg",
      date: "October 2026",
      prizePool: "$35,000 USD Google Cloud Credits & Badges",
      ...istSlot(3, 14, 6),
      organizer: "Google Developers",
      stream: "Technology & Engineering",
      registered: 5800,
      capacity: 10000,
    },

    /* --- 1. TECHNOLOGY & ENGINEERING --- */
    {
      id: "evt-adobe-univ-hackathon-2026",
      title: "Adobe University Hackathon 2026",
      organizer: "Adobe",
      stream: "Technology & Engineering",
      category: "Hackathon",
      mode: "Online",
      region: "Global / Online",
      regionGroup: "Virtual / Global",
      feeInINR: 0,
      feeINR: 0,
      hostUrl: "https://unstop.com",
      applyUrl: "https://unstop.com",
      date: "Open through Oct 16, 2026",
      description:
        "Build autonomous AI agents and intelligent brand solutions in a multi-stage online assessment and prototype build. Collaborate on cutting-edge design tools and generative pipelines.",
      location: "Unstop Online Portal",
      city: "Online",
      stateRegion: "Global",
      tags: ["adobe", "ai-agents", "hackathon", "unstop", "design-tech"],
      sourceBadge: "Unstop",
      platform: "Unstop",
      prizePool: "Cash Grants & Adobe Subscriptions",
      ...istSlot(4, 10, 48),
      registered: 4950,
      capacity: 8000,
    },
    {
      id: "evt-nasa-space-apps-2026",
      title: "NASA Space Apps Challenge 2026",
      organizer: "NASA",
      stream: "Technology & Engineering",
      category: "Hackathon",
      mode: "Hybrid",
      region: "All India",
      regionGroup: "All India",
      feeInINR: 0,
      feeINR: 0,
      hostUrl: "https://spaceappschallenge.org",
      applyUrl: "https://spaceappschallenge.org",
      date: "November 15, 2026",
      description:
        "48-Hour Global Hackathon solving real-world Earth and space challenges using NASA open datasets. Work with multidisciplinary teams across astronomy, climate science, and orbital tracking.",
      location: "Designated Local Leads across India & Virtual",
      city: "Pan-India / Hybrid",
      stateRegion: "Pan-India",
      tags: ["nasa", "space-apps", "open-data", "satellite", "earth-science"],
      sourceBadge: "NASA",
      platform: "NASA Global Portal",
      prizePool: "Global Winner Accolades & Kennedy Space Center Visit",
      ...istSlot(15, 9, 48),
      registered: 12500,
      capacity: 20000,
    },
    {
      id: "evt-sih-grand-finale-2026",
      title: "Smart India Hackathon (SIH) 2026 Grand Finale",
      organizer: "Ministry of Education & AICTE",
      stream: "Technology & Engineering",
      category: "Hackathon",
      mode: "In-Person",
      region: "All India",
      regionGroup: "All India",
      feeInINR: 0,
      feeINR: 0,
      hostUrl: "https://sih.gov.in",
      applyUrl: "https://sih.gov.in",
      date: "December 2026",
      description:
        "36-Hour continuous nation-building hackathon solving operational problems for central ministries and industries. Teams pitch to senior ministry delegates and technology leaders.",
      location: "Selected Nodal Centers Across India",
      city: "Pan-India Nodal Centers",
      stateRegion: "Pan-India",
      tags: ["sih", "grand-finale", "national", "hardware", "software"],
      sourceBadge: "SIH Portal",
      platform: "SIH Official Portal",
      prizePool: "₹1,00,000 per Problem Statement Winner",
      ...istSlot(20, 8, 36),
      registered: 24000,
      capacity: 35000,
    },

    /* --- 2. BUSINESS, MANAGEMENT & ECONOMICS --- */
    {
      id: "evt-green-innovation-challenge",
      title: "Green Innovation Challenge",
      organizer: "IIM Tiruchirappalli",
      stream: "Business & Management",
      category: "Case Study",
      mode: "Hybrid",
      region: "All India",
      regionGroup: "All India",
      feeInINR: 0,
      feeINR: 0,
      hostUrl: "https://unstop.com",
      applyUrl: "https://unstop.com",
      date: "October 13, 2026 (Registration Deadline)",
      description:
        "Propose sustainable business models and green supply chain solutions in this national management competition. Compete through rigorous case analysis and presentation rounds.",
      location: "IIM Trichy Campus & Virtual Rounds",
      city: "Tiruchirappalli",
      stateRegion: "Tamil Nadu",
      tags: ["iim", "case-study", "green-energy", "esg", "consulting"],
      sourceBadge: "Unstop",
      platform: "Unstop",
      prizePool: "₹50,000 Cash Pool & Merit Certificates",
      ...istSlot(2, 10, 8),
      registered: 1850,
      capacity: 3000,
    },
    {
      id: "evt-comstox-mock-trading",
      title: "Comstox 3.0 — Mock Stock & Trading Challenge",
      organizer: "SGTB Khalsa College, Delhi University",
      stream: "Business & Management",
      category: "Trading Challenge",
      mode: "Hybrid",
      region: "Delhi / NCR",
      regionGroup: "Delhi / NCR",
      feeInINR: 0,
      feeINR: 0,
      hostUrl: "https://unstop.com",
      applyUrl: "https://unstop.com",
      date: "October 12, 2026",
      description:
        "Simulate real-time equity portfolio trading and quantitative risk analysis in a live market environment. Test order book strategies against volatility spikes and financial news feeds.",
      location: "SGTB Khalsa College & Online Simulation Terminal",
      city: "Delhi",
      stateRegion: "Delhi NCR",
      tags: ["mock-stock", "trading", "finance", "du", "portfolio"],
      sourceBadge: "Unstop",
      platform: "Unstop",
      prizePool: "₹35,000 Cash + Trading Mentorship",
      ...istSlot(1, 9, 7),
      registered: 1420,
      capacity: 2500,
    },
    {
      id: "evt-hult-prize-global-2027",
      title: "Hult Prize Global Challenge 2027",
      organizer: "Hult Prize Foundation",
      stream: "Business & Management",
      category: "Case Study",
      mode: "Hybrid",
      region: "Global / Online",
      regionGroup: "Global / Online",
      feeInINR: 0,
      feeINR: 0,
      hostUrl: "https://hultprize.org",
      applyUrl: "https://hultprize.org",
      date: "Registrations open Autumn 2026",
      description:
        "Known as the Nobel Prize for Students—create scalable social business ventures aligned with UN SDGs. Pitch for $1,000,000 USD in global seed capital to change the world.",
      location: "Global On-Campus Editions & Regional Summits",
      city: "Global / Virtual",
      stateRegion: "Global",
      tags: ["hult-prize", "social-enterprise", "sdgs", "startup", "venture"],
      sourceBadge: "Virtual",
      platform: "Hult Prize Portal",
      prizePool: "$1,000,000 USD Global Seed Capital",
      ...istSlot(8, 14, 10),
      registered: 21000,
      capacity: 50000,
    },

    /* --- 3. ARTS, DESIGN & HUMANITIES --- */
    {
      id: "evt-artribute-design-2026",
      title: "ArTribute 2026 — Fine Arts & Digital Design",
      organizer: "IIT Madras",
      stream: "Arts, Design & Humanities",
      category: "Competition",
      mode: "Hybrid",
      region: "All India",
      regionGroup: "All India",
      feeInINR: 99,
      feeINR: 99,
      hostUrl: "https://unstop.com",
      applyUrl: "https://unstop.com",
      date: "Open through November 9, 2026",
      description:
        "Showcase digital art, graphic design, and UI/UX branding concepts via asynchronous portfolio submission. Evaluated by renowned fine arts faculty and industry creative directors.",
      location: "IIT Madras Saarang Arena & Online",
      city: "Chennai",
      stateRegion: "Tamil Nadu",
      tags: ["iit-madras", "digital-art", "ui-ux", "graphic-design", "branding"],
      sourceBadge: "Unstop",
      platform: "Unstop",
      prizePool: "₹40,000 Cash + Exhibition Showcase",
      ...istSlot(10, 10, 6),
      registered: 960,
      capacity: 2000,
    },
    {
      id: "evt-ad-mad-challenge-2026",
      title: "Ad Mad Challenge 2026",
      organizer: "Shaheed Rajguru College, Delhi University",
      stream: "Arts, Design & Humanities",
      category: "Competition",
      mode: "Online",
      region: "Delhi / NCR",
      regionGroup: "Delhi / NCR",
      feeInINR: 0,
      feeINR: 0,
      hostUrl: "https://unstop.com",
      applyUrl: "https://unstop.com",
      date: "October 12, 2026",
      description:
        "Pitch creative video ads, copy concepts, and branding strategy campaigns online. Deliver persuasive marketing narratives within strict time constraints.",
      location: "SRCASW Portal (Online)",
      city: "Delhi",
      stateRegion: "Delhi NCR",
      tags: ["ad-mad", "creative-writing", "video-ad", "marketing", "du"],
      sourceBadge: "Unstop",
      platform: "Unstop",
      prizePool: "₹20,000 Cash & Brand Vouchers",
      ...istSlot(1, 14, 5),
      registered: 780,
      capacity: 1500,
    },

    /* --- 4. BIOLOGY, CHEMISTRY & NATURAL SCIENCES --- */
    {
      id: "evt-enveda-casmi-2026",
      title: "Enveda CASMI Computational Chemistry Challenge 2026",
      organizer: "Enveda Biosciences & Kaggle",
      stream: "Sciences & Mathematics",
      category: "Competition",
      mode: "Online",
      region: "Global / Online",
      regionGroup: "Global / Online",
      feeInINR: 0,
      feeINR: 0,
      hostUrl: "https://kaggle.com",
      applyUrl: "https://kaggle.com",
      date: "Open through December 18, 2026",
      description:
        "Predict natural molecular structures from mass spectra using AI and biophysical informatics. Accelerate plant chemistry exploration and natural therapeutic discovery.",
      location: "Kaggle Platform",
      city: "Online",
      stateRegion: "Global",
      tags: ["computational-chemistry", "kaggle", "mass-spec", "bio-ai", "enveda"],
      sourceBadge: "Kaggle",
      platform: "Kaggle Platform",
      prizePool: "$30,000 USD Kaggle Prize Pool",
      ...istSlot(18, 12, 72),
      registered: 3400,
      capacity: 8000,
    },
    {
      id: "evt-oneaquahealth-ieee-2026",
      title: "OneAquaHealth IEEE Global Hackathon",
      organizer: "IEEE",
      stream: "Sciences & Mathematics",
      category: "Hackathon",
      mode: "Online",
      region: "Global / Online",
      regionGroup: "Global / Online",
      feeInINR: 0,
      feeINR: 0,
      hostUrl: "https://ieee.org",
      applyUrl: "https://ieee.org",
      date: "Late October 2026",
      description:
        "Build virtual solutions for aquatic ecosystem conservation, water health, and environmental biology. Develop sensor networks and bio-surveillance tools for freshwater biodiversity.",
      location: "IEEE Virtual Challenge Space",
      city: "Online",
      stateRegion: "Global",
      tags: ["ieee", "marine-biology", "water-health", "ecology", "iot-sensors"],
      sourceBadge: "IEEE",
      platform: "IEEE Official Portal",
      prizePool: "$15,000 USD IEEE Travel Grants & Prizes",
      ...istSlot(6, 15, 24),
      registered: 2300,
      capacity: 5000,
    },

    /* --- 5. MATHEMATICS, PHYSICS & INTERDISCIPLINARY STEM --- */
    {
      id: "evt-arc-prize-agi-2026",
      title: "ARC Prize 2026 — ARC-AGI-3 Challenge",
      organizer: "ARC Prize Foundation & Kaggle",
      stream: "Sciences & Mathematics",
      category: "Competition",
      mode: "Online",
      region: "Global / Online",
      regionGroup: "Global / Online",
      feeInINR: 0,
      feeINR: 0,
      hostUrl: "https://arcprize.org",
      applyUrl: "https://arcprize.org",
      date: "Open through November 1, 2026",
      description:
        "Solve novel abstract mathematical logic and visual pattern-reasoning puzzles to advance artificial general intelligence. Measure out-of-distribution generalization across symbolic grids.",
      location: "ARC Prize Portal & Kaggle",
      city: "Online",
      stateRegion: "Global",
      tags: ["arc-prize", "agi", "mathematical-logic", "kaggle", "symbolic-reasoning"],
      sourceBadge: "Kaggle",
      platform: "ARC Prize Portal",
      prizePool: "$1,100,000 USD Total Prize Pool",
      ...istSlot(9, 13, 48),
      registered: 6100,
      capacity: 12000,
    },
    {
      id: "evt-iymc-math-challenge-2026",
      title: "International Youth Math Challenge (IYMC) 2026",
      organizer: "IYMC Committee",
      stream: "Sciences & Mathematics",
      category: "Competition",
      mode: "Online",
      region: "Global / Online",
      regionGroup: "Global / Online",
      feeInINR: 0,
      feeINR: 0,
      hostUrl: "https://iymc.info",
      applyUrl: "https://iymc.info",
      date: "October – November 2026",
      description:
        "Worldwide math tournament testing creative problem-solving and mathematical proof skills. Compete individually across qualification, pre-final, and final rounds.",
      location: "IYMC International Portal",
      city: "Online",
      stateRegion: "Global",
      tags: ["iymc", "math-olympiad", "proofs", "number-theory", "combinatorics"],
      sourceBadge: "Virtual",
      platform: "IYMC Portal",
      prizePool: "$700 USD Cash + Global Certificates",
      ...istSlot(11, 10, 12),
      registered: 8400,
      capacity: 15000,
    },
  ];
}
