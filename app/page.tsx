"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import clsx from "clsx";
import confetti from "canvas-confetti";
import { QRCodeSVG } from "qrcode.react";
import {
  AlertTriangle,
  ArrowRight,
  BookmarkCheck,
  Calendar,
  CalendarPlus,
  CheckCircle2,
  ChevronRight,
  Clock,
  Compass,
  Download,
  ExternalLink,
  GraduationCap,
  Layers,
  ListFilter,
  Loader2,
  Lock,
  LogOut,
  MapPin,
  QrCode,
  Radio,
  RefreshCw,
  Search,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Tag,
  Ticket,
  Trophy,
  User,
  UserCheck,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import {
  buildSeedEvents,
  cacheEvents,
  db,
  getCachedEvents,
  getStudentApplications,
  removeStudentApplication,
  saveStudentApplication,
  updateApplicationStatus,
  type ApplicationStatus,
  type CheckinStatus,
  type EventCategory,
  type EventItem,
  type EventMode,
  type OpportunitySource,
  type PendingCheckin,
  type RegionGroup,
  type StudentApplication,
  type StudentProfile,
} from "@/lib/db";
import {
  useNetworkSync,
  type CheckinInput,
  type EnqueueResult,
} from "@/hooks/useNetworkSync";

/* -------------------------------------------------------------------------- */
/*  Constants & Small Helpers                                                 */
/* -------------------------------------------------------------------------- */

type Tab = "aggregator" | "tracker" | "checkin";
type EventsSource = "network" | "cache" | "bundled";

const TABS: { id: Tab; label: string; icon: typeof Compass; badge?: string }[] = [
  { id: "aggregator", label: "Opportunity Aggregator", icon: Compass },
  { id: "tracker", label: "My Applications & Tracker", icon: BookmarkCheck },
  { id: "checkin", label: "Venue Offline Check-In", icon: QrCode },
];

const CATEGORIES: ("All" | EventCategory)[] = [
  "All",
  "Hackathons",
  "Workshops",
  "Conferences",
  "Fests",
  "Meetups",
];

const SOURCES: ("All" | OpportunitySource)[] = [
  "All",
  "Unstop",
  "Devfolio",
  "HackerEarth",
  "Campus",
  "SIH Portal",
  "Virtual",
];

type RegionFilter = "All India" | Exclude<RegionGroup, "Other India">;
const REGIONS: RegionFilter[] = [
  "All India",
  "Mumbai / Pune",
  "Bengaluru",
  "Virtual / Global",
];

const SOURCE_BADGES: Record<OpportunitySource, { bg: string; text: string; border: string }> = {
  Unstop: { bg: "bg-blue-500/15", text: "text-blue-400", border: "border-blue-500/30" },
  Devfolio: { bg: "bg-cyan-500/15", text: "text-cyan-300", border: "border-cyan-500/30" },
  HackerEarth: { bg: "bg-purple-500/15", text: "text-purple-300", border: "border-purple-500/30" },
  Campus: { bg: "bg-emerald-500/15", text: "text-emerald-400", border: "border-emerald-500/30" },
  "SIH Portal": { bg: "bg-amber-500/15", text: "text-amber-400", border: "border-amber-500/30" },
  Virtual: { bg: "bg-indigo-500/15", text: "text-indigo-300", border: "border-indigo-500/30" },
};

const STATUS_CONFIG: Record<
  ApplicationStatus,
  { bg: string; text: string; border: string; desc: string }
> = {
  "Applied / Registered": {
    bg: "bg-sky-500/15",
    text: "text-sky-300",
    border: "border-sky-500/30",
    desc: "Application submitted to host platform",
  },
  Shortlisted: {
    bg: "bg-amber-500/15",
    text: "text-amber-400",
    border: "border-amber-500/30",
    desc: "Round 1 passed, team shortlisted for finals",
  },
  "Offline Pass Ready": {
    bg: "bg-emerald-500/15",
    text: "text-emerald-400",
    border: "border-emerald-500/30",
    desc: "Pass verified locally, ready for venue entry",
  },
  Attended: {
    bg: "bg-indigo-500/15",
    text: "text-indigo-300",
    border: "border-indigo-500/30",
    desc: "Verified check-in acknowledged by server",
  },
};

const STUDENT_SESSION_KEY = "grevix_student_session_v1";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const IST = "Asia/Kolkata";

const dateFmt = new Intl.DateTimeFormat("en-IN", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: IST,
});
const timeFmt = new Intl.DateTimeFormat("en-IN", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: IST,
});
const inrFmt = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

function fmtTime(iso: string): string {
  return `${timeFmt.format(new Date(iso))} IST`;
}

function formatWhen(startsAt: string, endsAt: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (dateFmt.format(start) === dateFmt.format(end)) {
    return `${dateFmt.format(start)}, ${timeFmt.format(start)} to ${timeFmt.format(end)} IST`;
  }
  return `${dateFmt.format(start)}, ${timeFmt.format(start)} to ${dateFmt.format(end)}, ${timeFmt.format(end)} IST`;
}

function formatClock(iso: string): string {
  return `${dateFmt.format(new Date(iso))}, ${fmtTime(iso)}`;
}

function formatFee(feeInINR: number): string {
  return feeInINR === 0 ? "Free" : `${inrFmt.format(feeInINR)} registration`;
}

function shortHash(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 12)}...${hash.slice(-8)}` : hash;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/* -------------------------------------------------------------------------- */
/*  Dynamic Calendar (.ics) Generation (Single and Bulk)                     */
/* -------------------------------------------------------------------------- */

const pad = (n: number) => String(n).padStart(2, "0");
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function toICSDateUTC(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(
    d.getUTCMinutes(),
  )}${pad(d.getUTCSeconds())}Z`;
}

function toICSDateIST(iso: string): string {
  const d = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(
    d.getUTCMinutes(),
  )}${pad(d.getUTCSeconds())}`;
}

function escapeICS(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function foldLine(line: string): string {
  const chunks: string[] = [];
  let rest = line;
  while (rest.length > 70) {
    chunks.push(rest.slice(0, 70));
    rest = ` ${rest.slice(70)}`;
  }
  chunks.push(rest);
  return chunks.join("\r\n");
}

function generateSingleVEvent(event: EventItem): string[] {
  const fee = event.feeInINR === 0 ? "Free" : inrFmt.format(event.feeInINR);
  return [
    "BEGIN:VEVENT",
    `UID:${event.id}@eventsyncpro-student`,
    `DTSTAMP:${toICSDateUTC(new Date().toISOString())}`,
    `DTSTART;TZID=Asia/Kolkata:${toICSDateIST(event.startsAt)}`,
    `DTEND;TZID=Asia/Kolkata:${toICSDateIST(event.endsAt)}`,
    `SUMMARY:${escapeICS(event.title)}`,
    `DESCRIPTION:${escapeICS(
      `${event.description}\n\nHost: ${event.sourceBadge} (${event.platform ?? "Platform"})\nPrize Pool: ${event.prizePool ?? "Standard"}\nRegistration: ${fee}\nDirect Link: ${event.applyUrl}`,
    )}`,
    `LOCATION:${escapeICS(`${event.location}, ${event.city}`)}`,
    `CATEGORIES:${escapeICS(event.category)}`,
    "STATUS:CONFIRMED",
    "BEGIN:VALARM",
    "TRIGGER:-PT30M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeICS(`${event.title} begins in 30 minutes!`)}`,
    "END:VALARM",
    "END:VEVENT",
  ];
}

function exportBatchICS(events: EventItem[], filename = "My_Student_Applications.ics") {
  if (events.length === 0) return;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Grevix//EventSyncPro Student Aggregator//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-TIMEZONE:Asia/Kolkata",
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Kolkata",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0530",
    "TZOFFSETTO:+0530",
    "TZNAME:IST",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];

  for (const ev of events) {
    lines.push(...generateSingleVEvent(ev));
  }

  lines.push("END:VCALENDAR");

  const blob = new Blob([lines.map(foldLine).join("\r\n") + "\r\n"], {
    type: "text/calendar;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fireConfetti() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#38bdf8", "#6366f1", "#10b981", "#f59e0b"];
  confetti({ particleCount: 80, spread: 70, origin: { y: 0.65 }, colors });
}

/* -------------------------------------------------------------------------- */
/*  Main Component                                                            */
/* -------------------------------------------------------------------------- */

export default function Home() {
  const net = useNetworkSync();
  const { isOnline, version } = net;

  // Student Authentication State (Persists offline via localStorage)
  const [student, setStudent] = useState<StudentProfile | null>(null);
  const [authInitialized, setAuthInitialized] = useState(false);

  // Tab State: [1. Opportunity Aggregator], [2. My Applications & Tracker], [3. Venue Offline Check-In]
  const [tab, setTab] = useState<Tab>("aggregator");

  // Core Data
  const [events, setEvents] = useState<EventItem[]>([]);
  const [eventsSource, setEventsSource] = useState<EventsSource | null>(null);
  const [applications, setApplications] = useState<StudentApplication[]>([]);
  const [wallet, setWallet] = useState<PendingCheckin[]>([]);
  const [preselectedEventId, setPreselectedEventId] = useState("");

  // Load student session from offline storage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STUDENT_SESSION_KEY);
      if (stored) {
        setStudent(JSON.parse(stored) as StudentProfile);
      }
    } catch {
      // Best effort
    }
    setAuthInitialized(true);
  }, []);

  const handleLogin = (profile: StudentProfile) => {
    setStudent(profile);
    try {
      localStorage.setItem(STUDENT_SESSION_KEY, JSON.stringify(profile));
    } catch {
      // Storage might be restricted
    }
    fireConfetti();
  };

  const handleLogout = () => {
    setStudent(null);
    try {
      localStorage.removeItem(STUDENT_SESSION_KEY);
    } catch {
      // Best effort
    }
  };

  // Maps events by ID
  const eventsById = useMemo(
    () => new Map(events.map((event) => [event.id, event])),
    [events],
  );

  // Load events (IndexedDB first, fallback to network/bundled)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let cached: EventItem[] = [];
      try {
        cached = await getCachedEvents();
      } catch {
        // IDB unavailable
      }

      if (!cancelled && cached.length > 0) {
        setEvents(cached);
        setEventsSource("cache");
      }

      if (isOnline) {
        try {
          const res = await fetch("/api/events", { cache: "no-store" });
          if (res.ok) {
            const data = (await res.json()) as { events: EventItem[] };
            try {
              await cacheEvents(data.events);
            } catch {
              // Best effort
            }
            if (!cancelled) {
              setEvents(data.events);
              setEventsSource("network");
            }
            return;
          }
        } catch {
          // Network fall-through
        }
      }

      if (!cancelled && cached.length === 0) {
        const seed = buildSeedEvents();
        try {
          await cacheEvents(seed);
        } catch {
          // Best effort
        }
        setEvents(seed);
        setEventsSource("bundled");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOnline]);

  // Load student applications from IndexedDB
  const refreshApplications = useCallback(async () => {
    if (!student?.rollNoOrEmail) {
      setApplications([]);
      return;
    }
    try {
      const list = await getStudentApplications(student.rollNoOrEmail);
      // Sort newest first
      list.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
      setApplications(list);
    } catch {
      setApplications([]);
    }
  }, [student?.rollNoOrEmail]);

  useEffect(() => {
    void refreshApplications();
  }, [refreshApplications, version]);

  // Local check-ins (Dexie IndexedDB wallet)
  useEffect(() => {
    let cancelled = false;
    db.pendingCheckins
      .orderBy("checkedInAt")
      .reverse()
      .toArray()
      .then((rows) => {
        if (!cancelled) setWallet(rows);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [version]);

  // Register service worker for PWA capabilities
  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);

  // Handle URL tabs (?tab=aggregator | ?tab=tracker | ?tab=checkin)
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    if (requested === "aggregator" || requested === "tracker" || requested === "checkin") {
      setTab(requested as Tab);
    }
  }, []);

  // Save / apply action
  const handleSaveApplication = async (event: EventItem, initialStatus: ApplicationStatus = "Applied / Registered") => {
    if (!student) {
      alert("Please login with your Student Profile first to save applications!");
      return;
    }
    try {
      await saveStudentApplication({
        eventId: event.id,
        studentEmail: student.rollNoOrEmail,
        status: initialStatus,
        appliedAt: new Date().toISOString(),
        teamName: `${student.fullName.split(" ")[0]}'s Squad`,
      });
      await refreshApplications();
      fireConfetti();
    } catch {
      alert("Unable to save application locally. Please check storage permissions.");
    }
  };

  const goToCheckinWithEvent = useCallback((eventId: string) => {
    setPreselectedEventId(eventId);
    setTab("checkin");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const simulated = net.simulatedOffline;

  // Render Student Portal Login Screen if not authenticated
  if (authInitialized && !student) {
    return (
      <StudentAuthPortal
        onLogin={handleLogin}
        isOnline={isOnline}
        simulated={simulated}
        toggleSimulated={net.toggleSimulation}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 selection:bg-indigo-500/30 selection:text-indigo-200">
      {/* --------------------------- Top Header --------------------------- */}
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-3 sm:px-6">
          {/* Logo & Student Platform Tag */}
          <div className="flex items-center gap-3">
            <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-sky-600 shadow-lg shadow-indigo-500/20 ring-1 ring-white/20">
              <GraduationCap className="h-5 w-5 text-white" aria-hidden />
              <span className="absolute -bottom-1 -right-1 flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
              </span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold tracking-tight text-white sm:text-lg">
                  EventSync <span className="text-indigo-400">Pro</span>
                </h1>
                <span className="rounded-md border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-300">
                  Student Edition
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Aggregator & Tracker · Unstop · Devfolio · SIH · HackerEarth
              </p>
            </div>
          </div>

          {/* Right Controls: Student Profile, Network Toggle, Sync, PWA Install */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            {/* Network Status Badge */}
            <span
              role="status"
              aria-live="polite"
              className={clsx(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium shadow-sm transition",
                isOnline
                  ? "border-emerald-500/40 bg-emerald-950/40 text-emerald-400 shadow-emerald-950/50"
                  : "border-amber-500/40 bg-amber-950/40 text-amber-400 shadow-amber-950/50",
              )}
            >
              {isOnline ? (
                <Wifi className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <WifiOff className="h-3.5 w-3.5" aria-hidden />
              )}
              <span>{isOnline ? "Online" : simulated ? "Offline (Simulated)" : "Offline (Local Engine)"}</span>
            </span>

            {/* Network Status Simulator Toggle */}
            <button
              type="button"
              role="switch"
              aria-checked={simulated}
              onClick={net.toggleSimulation}
              title="Toggle network simulation outage to test offline Dexie syncing"
              className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/90 px-3 py-1 text-xs font-medium text-slate-300 shadow-sm transition hover:border-slate-700 hover:text-white"
            >
              <span
                className={clsx(
                  "relative h-4 w-7 rounded-full transition-colors",
                  simulated ? "bg-amber-400" : "bg-slate-700",
                )}
                aria-hidden
              >
                <span
                  className={clsx(
                    "absolute top-0.5 h-3 w-3 rounded-full bg-slate-950 shadow transition-all",
                    simulated ? "left-3.5" : "left-0.5",
                  )}
                />
              </span>
              <span className="hidden sm:inline">Simulate Outage</span>
            </button>

            {/* Sync Status Indicator / Queue */}
            <span
              className={clsx(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
                net.pendingCount > 0
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-400 animate-pulse"
                  : "border-slate-800 bg-slate-900 text-slate-300",
              )}
            >
              {net.isSyncing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-400" aria-hidden />
              ) : net.pendingCount > 0 ? (
                <Clock className="h-3.5 w-3.5 text-amber-400" aria-hidden />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
              )}
              <span>
                {net.isSyncing
                  ? "Syncing Dexie..."
                  : net.pendingCount > 0
                    ? `${net.pendingCount} Offline Sync Pending`
                    : "IndexedDB Synced"}
              </span>
            </span>

            {/* Force Sync Button */}
            <button
              type="button"
              onClick={() => void net.syncNow({ force: true })}
              disabled={!isOnline || net.isSyncing}
              title={isOnline ? "Force Sync offline passes to server" : "Connect to network to sync"}
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-600/90 px-2.5 py-1 text-xs font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:border-slate-800 disabled:bg-slate-800/60 disabled:text-slate-500"
            >
              <RefreshCw className={clsx("h-3.5 w-3.5", net.isSyncing && "animate-spin")} aria-hidden />
              <span className="hidden sm:inline">Sync Now</span>
            </button>

            {/* Install App / APK PWA Button */}
            {net.canInstall && (
              <button
                type="button"
                onClick={() => void net.promptInstall()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/40 bg-emerald-500/20 px-2.5 py-1 text-xs font-semibold text-emerald-400 shadow transition hover:bg-emerald-500/30"
              >
                <Download className="h-3.5 w-3.5" aria-hidden />
                <span>Install APK / PWA</span>
              </button>
            )}

            {/* Student Profile Pill */}
            {student && (
              <div className="flex items-center gap-2 rounded-full border border-indigo-500/30 bg-slate-900/90 py-0.5 pl-2.5 pr-1 text-xs">
                <span className="font-semibold text-indigo-300">{student.fullName}</span>
                <span className="hidden text-slate-400 md:inline">({student.collegeName})</span>
                <button
                  type="button"
                  onClick={handleLogout}
                  title="Sign out of student portal"
                  className="rounded-full p-1 text-slate-400 transition hover:bg-slate-800 hover:text-rose-400"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span className="sr-only">Sign out</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Offline Banner Notification */}
        {!isOnline && (
          <div className="border-t border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-300">
            <div className="mx-auto flex max-w-7xl items-center justify-between gap-2">
              <span className="flex items-center gap-1.5">
                <Zap className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                <span>
                  <strong>Offline Mode Active:</strong> You can explore events, generate passes, and record attendance locally. Everything saves to Dexie IndexedDB and syncs automatically when network resumes.
                </span>
              </span>
            </div>
          </div>
        )}
      </header>

      {/* ------------------------- Main Navigation Tabs ------------------------- */}
      <main className="mx-auto max-w-7xl px-4 pb-20 pt-6 sm:px-6">
        <div
          role="tablist"
          aria-label="Student Navigation Tabs"
          className="grid grid-cols-1 gap-2 rounded-2xl border border-slate-800/80 bg-slate-900/80 p-1.5 sm:grid-cols-3"
        >
          {TABS.map(({ id, label, icon: Icon }) => {
            const isActive = tab === id;
            return (
              <button
                key={id}
                role="tab"
                id={`tab-${id}`}
                aria-selected={isActive}
                aria-controls={`panel-${id}`}
                type="button"
                onClick={() => setTab(id)}
                className={clsx(
                  "relative inline-flex items-center justify-center gap-2.5 rounded-xl px-4 py-3 text-sm font-semibold transition-all duration-150",
                  isActive
                    ? "bg-gradient-to-r from-indigo-600 to-indigo-500 text-white shadow-md shadow-indigo-600/30"
                    : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200",
                )}
              >
                <Icon className={clsx("h-4 w-4", isActive ? "text-white" : "text-slate-400")} aria-hidden />
                <span>{label}</span>
                {id === "tracker" && applications.length > 0 && (
                  <span className="rounded-full bg-indigo-950/80 px-2 py-0.5 text-xs font-bold text-indigo-300 ring-1 ring-indigo-500/40">
                    {applications.length}
                  </span>
                )}
                {id === "checkin" && net.pendingCount > 0 && (
                  <span className="rounded-full bg-amber-400 px-2 py-0.5 text-xs font-bold text-slate-950">
                    {net.pendingCount} queued
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* ------------------------- Tab 1: Opportunity Aggregator ------------------------- */}
        {tab === "aggregator" && (
          <div className="mt-8">
            <AggregatorTab
              events={events}
              source={eventsSource}
              isOnline={isOnline}
              student={student}
              appliedEventIds={new Set(applications.map((a) => a.eventId))}
              onSaveApplication={handleSaveApplication}
              onCheckin={goToCheckinWithEvent}
            />
          </div>
        )}

        {/* ------------------------- Tab 2: My Applications & Tracker ------------------------- */}
        {tab === "tracker" && (
          <div className="mt-8">
            <TrackerTab
              eventsById={eventsById}
              applications={applications}
              student={student}
              onUpdateStatus={async (id, status) => {
                await updateApplicationStatus(id, status);
                await refreshApplications();
              }}
              onRemoveApplication={async (id) => {
                if (confirm("Remove this application from your tracker?")) {
                  await removeStudentApplication(id);
                  await refreshApplications();
                }
              }}
              onGoToCheckin={(eventId) => goToCheckinWithEvent(eventId)}
            />
          </div>
        )}

        {/* ------------------------- Tab 3: Venue Offline Check-In ------------------------- */}
        {tab === "checkin" && (
          <div className="mt-8">
            <VenueCheckinTab
              events={events}
              eventsById={eventsById}
              wallet={wallet}
              student={student}
              isOnline={isOnline}
              preselectedEventId={preselectedEventId}
              enqueueCheckin={net.enqueueCheckin}
            />
          </div>
        )}
      </main>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Student Auth Portal Component                                             */
/* -------------------------------------------------------------------------- */

function StudentAuthPortal({
  onLogin,
  isOnline,
  simulated,
  toggleSimulated,
}: {
  onLogin: (profile: StudentProfile) => void;
  isOnline: boolean;
  simulated: boolean;
  toggleSimulated: () => void;
}) {
  const [fullName, setFullName] = useState("Aarav Sharma");
  const [collegeName, setCollegeName] = useState("Veermata Jijabai Technological Institute (VJTI)");
  const [rollNoOrEmail, setRollNoOrEmail] = useState("aarav.sharma@vjti.ac.in");
  const [password, setPassword] = useState("student@2026");
  const [degreeBranch, setDegreeBranch] = useState("B.Tech Computer Engineering");
  const [yearOfStudy, setYearOfStudy] = useState("3rd Year");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!fullName.trim() || fullName.trim().length < 2) {
      return setError("Please enter your full name.");
    }
    if (!collegeName.trim() || collegeName.trim().length < 3) {
      return setError("Please enter your college or university name.");
    }
    if (!rollNoOrEmail.trim() || rollNoOrEmail.trim().length < 3) {
      return setError("Please enter a valid student roll number or institutional email.");
    }
    if (!password.trim() || password.length < 4) {
      return setError("Password must be at least 4 characters.");
    }

    onLogin({
      fullName: fullName.trim(),
      collegeName: collegeName.trim(),
      rollNoOrEmail: rollNoOrEmail.trim().toLowerCase(),
      degreeBranch,
      yearOfStudy,
    });
  };

  const fillQuickDemo = (profileName: "VJTI" | "COEP" | "IITB") => {
    if (profileName === "VJTI") {
      setFullName("Aarav Sharma");
      setCollegeName("VJTI Mumbai");
      setRollNoOrEmail("aarav.sharma@vjti.ac.in");
      setDegreeBranch("B.Tech Computer Science");
      setYearOfStudy("3rd Year");
    } else if (profileName === "COEP") {
      setFullName("Pooja Kulkarni");
      setCollegeName("COEP Technological University, Pune");
      setRollNoOrEmail("pooja.k@coep.ac.in");
      setDegreeBranch("B.Tech Artificial Intelligence");
      setYearOfStudy("4th Year");
    } else {
      setFullName("Rohan Deshmukh");
      setCollegeName("IIT Bombay");
      setRollNoOrEmail("rohan.d@iitb.ac.in");
      setDegreeBranch("B.Tech Electrical Engineering");
      setYearOfStudy("2nd Year");
    }
    setError(null);
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-950 px-4 py-12 text-slate-100">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_var(--tw-gradient-stops))] from-indigo-900/20 via-slate-950/80 to-slate-950 -z-10" />

      {/* Network Simulator toggle in login screen */}
      <div className="mb-6 flex items-center gap-3 rounded-full border border-slate-800 bg-slate-900/90 px-4 py-1.5 text-xs text-slate-300">
        <span className={clsx("h-2 w-2 rounded-full", isOnline ? "bg-emerald-400" : "bg-amber-400")} />
        <span>{isOnline ? "Network Online" : simulated ? "Offline (Simulated Outage)" : "Offline"}</span>
        <button
          type="button"
          onClick={toggleSimulated}
          className="ml-2 rounded-md bg-slate-800 px-2 py-0.5 text-[11px] font-semibold text-slate-200 hover:bg-slate-700"
        >
          {simulated ? "Turn Online" : "Simulate Offline"}
        </button>
      </div>

      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/90 p-8 shadow-2xl backdrop-blur-xl">
        <div className="flex flex-col items-center text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-tr from-indigo-600 to-sky-500 shadow-xl shadow-indigo-500/20">
            <GraduationCap className="h-8 w-8 text-white" />
          </div>
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-white">
            Student Opportunity Portal
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Sign in to track Unstop, Devfolio & SIH applications with offline Dexie sync.
          </p>
        </div>

        {/* Demo Fast Fill Buttons */}
        <div className="mt-6">
          <p className="text-center text-xs font-medium text-slate-500 uppercase tracking-wider">
            Quick Fill Demo Profiles:
          </p>
          <div className="mt-2 flex justify-center gap-2">
            <button
              type="button"
              onClick={() => fillQuickDemo("VJTI")}
              className="rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1 text-xs text-slate-300 hover:border-indigo-500 hover:text-white"
            >
              VJTI (Aarav)
            </button>
            <button
              type="button"
              onClick={() => fillQuickDemo("COEP")}
              className="rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1 text-xs text-slate-300 hover:border-indigo-500 hover:text-white"
            >
              COEP (Pooja)
            </button>
            <button
              type="button"
              onClick={() => fillQuickDemo("IITB")}
              className="rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1 text-xs text-slate-300 hover:border-indigo-500 hover:text-white"
            >
              IIT Bombay (Rohan)
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
              Full Name
            </label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="e.g. Aarav Sharma"
              className="mt-1.5 w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
              College / University Name
            </label>
            <input
              type="text"
              value={collegeName}
              onChange={(e) => setCollegeName(e.target.value)}
              placeholder="e.g. Ruia College, Mumbai"
              className="mt-1.5 w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
              Student Email or Roll Number
            </label>
            <input
              type="text"
              value={rollNoOrEmail}
              onChange={(e) => setRollNoOrEmail(e.target.value)}
              placeholder="e.g. student@college.edu or 22BCS104"
              className="mt-1.5 w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                Degree / Branch
              </label>
              <input
                type="text"
                value={degreeBranch}
                onChange={(e) => setDegreeBranch(e.target.value)}
                placeholder="Computer Engg"
                className="mt-1.5 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                Year of Study
              </label>
              <input
                type="text"
                value={yearOfStudy}
                onChange={(e) => setYearOfStudy(e.target.value)}
                placeholder="3rd Year"
                className="mt-1.5 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="mt-1.5 w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
              required
            />
          </div>

          {error && (
            <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-2.5 text-xs text-rose-300">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-500 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/30 transition hover:from-indigo-500 hover:to-indigo-400"
          >
            <span>Enter Student Workspace</span>
            <ArrowRight className="h-4 w-4" />
          </button>
        </form>

        <p className="mt-5 text-center text-xs text-slate-500">
          Persistent offline authentication via IndexedDB & LocalStorage. Stays signed in across offline restarts.
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Aggregator Tab (Unstop, Devfolio, HackerEarth, SIH, Campus)               */
/* -------------------------------------------------------------------------- */

function AggregatorTab({
  events,
  source,
  isOnline,
  student,
  appliedEventIds,
  onSaveApplication,
  onCheckin,
}: {
  events: EventItem[];
  source: EventsSource | null;
  isOnline: boolean;
  student: StudentProfile | null;
  appliedEventIds: Set<string>;
  onSaveApplication: (event: EventItem) => void;
  onCheckin: (eventId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedSource, setSelectedSource] = useState<"All" | OpportunitySource>("All");
  const [category, setCategory] = useState<"All" | EventCategory>("All");
  const [region, setRegion] = useState<RegionFilter>("All India");

  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return events
      .filter((event) => (selectedSource === "All" ? true : event.sourceBadge === selectedSource))
      .filter((event) => (category === "All" ? true : event.category === category))
      .filter((event) => (region === "All India" ? true : event.regionGroup === region))
      .filter((event) => {
        if (terms.length === 0) return true;
        const haystack =
          `${event.title} ${event.tags.join(" ")} ${event.description} ${event.city} ${event.sourceBadge} ${event.organizer}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }, [events, query, selectedSource, category, region]);

  return (
    <div className="space-y-6">
      {/* Top Welcome / Hero Banner for Students */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-800/80 bg-gradient-to-r from-slate-900 via-indigo-950/40 to-slate-900 p-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-xs font-semibold text-indigo-300">
              <Sparkles className="h-3.5 w-3.5" />
              <span>Real-Time Student Hackathon & Opportunity Aggregator</span>
            </div>
            <h2 className="mt-2 text-xl font-bold text-white sm:text-2xl">
              Discover & Track Hackathons across India & Global
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Aggregated directly from Unstop, Devfolio, HackerEarth, SIH Portal & top university fests. Saved offline for instant verification.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => exportBatchICS(events, "All_Aggregated_Student_Hackathons.ics")}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-2.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-700"
            >
              <CalendarPlus className="h-4 w-4 text-indigo-400" />
              <span>Export All to Calendar (.ics)</span>
            </button>
          </div>
        </div>
      </div>

      {/* Search & Filter Controls */}
      <div className="space-y-4 rounded-2xl border border-slate-800/80 bg-slate-900/90 p-5 shadow-sm">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Search opportunities (e.g. "Unstop", "SIH", "Devfolio", "Ruia", "Gemini", "AI")...'
            className="w-full rounded-xl border border-slate-800 bg-slate-950 py-3 pl-11 pr-4 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        {/* Source Badges Filter Row */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Source Platform:
          </span>
          {SOURCES.map((src) => {
            const isSelected = selectedSource === src;
            return (
              <button
                key={src}
                type="button"
                onClick={() => setSelectedSource(src)}
                className={clsx(
                  "rounded-full border px-3 py-1 text-xs font-medium transition",
                  isSelected
                    ? "border-indigo-500 bg-indigo-600 text-white shadow-sm"
                    : "border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700 hover:text-slate-200",
                )}
              >
                {src}
              </button>
            );
          })}
        </div>

        {/* Secondary Category & Region Filters */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-slate-800/60 pt-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-slate-500">Category:</span>
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                className={clsx(
                  "rounded-lg px-2.5 py-1 transition",
                  category === cat
                    ? "bg-slate-800 text-white font-medium"
                    : "text-slate-400 hover:text-slate-200",
                )}
              >
                {cat}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-slate-500">Region:</span>
            {REGIONS.map((reg) => (
              <button
                key={reg}
                type="button"
                onClick={() => setRegion(reg)}
                className={clsx(
                  "rounded-lg px-2.5 py-1 transition",
                  region === reg
                    ? "bg-slate-800 text-white font-medium"
                    : "text-slate-400 hover:text-slate-200",
                )}
              >
                {reg}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Results Header */}
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>
          Showing <strong>{filtered.length}</strong> opportunities
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={clsx("h-2 w-2 rounded-full", isOnline ? "bg-emerald-400" : "bg-amber-400")} />
          <span>
            {isOnline
              ? "Live feed aggregated from verified portals"
              : "Browsing offline cached catalogue (Dexie IndexedDB)"}
          </span>
        </span>
      </div>

      {/* Opportunity Grid */}
      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/50 p-12 text-center">
          <Trophy className="mx-auto h-10 w-10 text-slate-600" />
          <h3 className="mt-3 text-base font-semibold text-slate-200">No opportunities match your filter</h3>
          <p className="mt-1 text-sm text-slate-400">
            Try resetting your search query or switching source badges back to "All".
          </p>
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setSelectedSource("All");
              setCategory("All");
              setRegion("All India");
            }}
            className="mt-4 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
          >
            Reset Filters
          </button>
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          {filtered.map((event) => {
            const isSaved = appliedEventIds.has(event.id);
            const badgeStyle = SOURCE_BADGES[event.sourceBadge] || SOURCE_BADGES.Campus;

            return (
              <article
                key={event.id}
                className="group flex flex-col justify-between rounded-2xl border border-slate-800/80 bg-slate-900/90 p-5 shadow-sm transition hover:border-slate-700 hover:shadow-lg hover:shadow-indigo-950/20"
              >
                <div>
                  {/* Badges Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {/* Host Source Badge */}
                      <span
                        className={clsx(
                          "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-bold",
                          badgeStyle.bg,
                          badgeStyle.text,
                          badgeStyle.border,
                        )}
                      >
                        <Tag className="h-3 w-3" />
                        {event.sourceBadge}
                      </span>

                      {/* Mode Badge */}
                      <span className="inline-flex items-center gap-1 rounded-full border border-slate-800 bg-slate-950 px-2.5 py-0.5 text-xs text-slate-300">
                        {event.mode}
                      </span>

                      {/* Fee Badge */}
                      <span
                        className={clsx(
                          "rounded-full border px-2.5 py-0.5 text-xs font-medium",
                          event.feeInINR === 0
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                            : "border-slate-700 bg-slate-950 text-slate-300",
                        )}
                      >
                        {formatFee(event.feeInINR)}
                      </span>
                    </div>

                    {event.prizePool && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-xs font-semibold text-amber-300">
                        <Trophy className="h-3 w-3" />
                        {event.prizePool}
                      </span>
                    )}
                  </div>

                  {/* Title & Description */}
                  <h3 className="mt-3.5 text-lg font-bold text-white group-hover:text-indigo-300 transition-colors">
                    {event.title}
                  </h3>
                  <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-slate-400">
                    {event.description}
                  </p>

                  {/* Details Metadata */}
                  <div className="mt-4 space-y-1.5 text-xs text-slate-300">
                    <div className="flex items-center gap-2">
                      <Clock className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                      <span>{formatWhen(event.startsAt, event.endsAt)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <MapPin className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                      <span>
                        {event.location} · {event.city} ({event.stateRegion})
                      </span>
                    </div>
                  </div>

                  {/* Tags */}
                  <div className="mt-3.5 flex flex-wrap gap-1.5">
                    {event.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded-md border border-slate-800/80 bg-slate-950 px-2 py-0.5 text-[11px] text-slate-400"
                      >
                        #{t}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Card Action Buttons */}
                <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/60 pt-4">
                  {/* Left: Apply Link */}
                  <a
                    href={event.applyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-500 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:from-indigo-500 hover:to-indigo-400"
                  >
                    <span>Apply on {event.sourceBadge}</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>

                  {/* Right: Save to Tracker & Offline Pass button */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onSaveApplication(event)}
                      className={clsx(
                        "inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition",
                        isSaved
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                          : "border-slate-800 bg-slate-950 text-slate-300 hover:border-slate-700 hover:text-white",
                      )}
                    >
                      <BookmarkCheck className="h-3.5 w-3.5" />
                      <span>{isSaved ? "Saved in Tracker" : "Save to Tracker"}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => exportBatchICS([event], `${slugify(event.title)}.ics`)}
                      title="Download .ics Calendar Event"
                      className="rounded-xl border border-slate-800 bg-slate-950 p-2 text-slate-400 transition hover:border-slate-700 hover:text-slate-200"
                    >
                      <Calendar className="h-3.5 w-3.5" />
                    </button>

                    <button
                      type="button"
                      onClick={() => onCheckin(event.id)}
                      title="Generate offline verification pass"
                      className="rounded-xl border border-indigo-500/30 bg-indigo-950/40 p-2 text-indigo-300 transition hover:bg-indigo-900/60"
                    >
                      <QrCode className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Tracker Tab (My Applications & Tracker Dashboard)                         */
/* -------------------------------------------------------------------------- */

function TrackerTab({
  eventsById,
  applications,
  student,
  onUpdateStatus,
  onRemoveApplication,
  onGoToCheckin,
}: {
  eventsById: Map<string, EventItem>;
  applications: StudentApplication[];
  student: StudentProfile | null;
  onUpdateStatus: (id: number, status: ApplicationStatus) => Promise<void>;
  onRemoveApplication: (id: number) => Promise<void>;
  onGoToCheckin: (eventId: string) => void;
}) {
  const [statusFilter, setStatusFilter] = useState<"All" | ApplicationStatus>("All");

  const appliedEvents = useMemo(() => {
    return applications
      .map((app) => ({
        app,
        event: eventsById.get(app.eventId),
      }))
      .filter((item): item is { app: StudentApplication; event: EventItem } => Boolean(item.event));
  }, [applications, eventsById]);

  const filtered = useMemo(() => {
    if (statusFilter === "All") return appliedEvents;
    return appliedEvents.filter((item) => item.app.status === statusFilter);
  }, [appliedEvents, statusFilter]);

  const handleExportAllApplicationsICS = () => {
    const list = appliedEvents.map((item) => item.event);
    exportBatchICS(list, `${student?.fullName ? slugify(student.fullName) : "Student"}_Applied_Schedule.ics`);
  };

  return (
    <div className="space-y-6">
      {/* Tracker Overview & Export Header */}
      <div className="rounded-2xl border border-slate-800/80 bg-slate-900/90 p-6 shadow-sm">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold text-white sm:text-2xl">
                My Applications & Tracker
              </h2>
              <span className="rounded-full bg-indigo-500/15 border border-indigo-500/30 px-2.5 py-0.5 text-xs font-semibold text-indigo-300">
                {applications.length} Saved
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-400">
              Manage your registered hackathons, shortlisted teams, offline venue passes, and attended events.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={appliedEvents.length === 0}
              onClick={handleExportAllApplicationsICS}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-500 px-4 py-2.5 text-xs font-semibold text-white shadow-md shadow-indigo-600/20 transition hover:from-indigo-500 hover:to-indigo-400 disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              <span>Export All Applied (.ics)</span>
            </button>
          </div>
        </div>

        {/* Quick Filter Status Badges */}
        <div className="mt-6 flex flex-wrap gap-2 border-t border-slate-800/60 pt-4 text-xs">
          <span className="self-center font-semibold uppercase tracking-wider text-slate-500 mr-2">
            Status:
          </span>
          {(["All", "Applied / Registered", "Shortlisted", "Offline Pass Ready", "Attended"] as const).map(
            (status) => {
              const count =
                status === "All"
                  ? applications.length
                  : applications.filter((a) => a.status === status).length;
              return (
                <button
                  key={status}
                  type="button"
                  onClick={() => setStatusFilter(status)}
                  className={clsx(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-medium transition",
                    statusFilter === status
                      ? "border-indigo-500 bg-indigo-600 text-white"
                      : "border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700 hover:text-slate-200",
                  )}
                >
                  <span>{status}</span>
                  <span className="rounded-full bg-slate-800 px-1.5 py-0.2 text-[10px] text-slate-300">
                    {count}
                  </span>
                </button>
              );
            },
          )}
        </div>
      </div>

      {/* Applications Cards List */}
      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/50 p-12 text-center">
          <BookmarkCheck className="mx-auto h-10 w-10 text-slate-600" />
          <h3 className="mt-3 text-base font-semibold text-slate-200">No applications found in this view</h3>
          <p className="mt-1 text-sm text-slate-400">
            Head to the Opportunity Aggregator tab to explore hackathons and click "Save to Tracker".
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map(({ app, event }) => {
            const statusMeta = STATUS_CONFIG[app.status];
            const sourceStyle = SOURCE_BADGES[event.sourceBadge];

            return (
              <div
                key={app.id ?? event.id}
                className="flex flex-col justify-between gap-4 rounded-2xl border border-slate-800/80 bg-slate-900/90 p-5 shadow-sm transition hover:border-slate-700 md:flex-row md:items-center"
              >
                {/* Event & Application Info */}
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={clsx(
                        "rounded-full border px-2.5 py-0.5 text-xs font-bold",
                        sourceStyle.bg,
                        sourceStyle.text,
                        sourceStyle.border,
                      )}
                    >
                      {event.sourceBadge}
                    </span>

                    <span
                      className={clsx(
                        "rounded-full border px-2.5 py-0.5 text-xs font-semibold",
                        statusMeta.bg,
                        statusMeta.text,
                        statusMeta.border,
                      )}
                    >
                      {app.status}
                    </span>

                    <span className="text-xs text-slate-500">
                      Applied on {dateFmt.format(new Date(app.appliedAt))}
                    </span>
                  </div>

                  <h3 className="text-base font-bold text-white">{event.title}</h3>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                    <span>
                      📅 <strong>Schedule:</strong> {formatWhen(event.startsAt, event.endsAt)}
                    </span>
                    <span>
                      📍 <strong>Venue:</strong> {event.location} ({event.city})
                    </span>
                    {app.teamName && (
                      <span>
                        👥 <strong>Team:</strong> {app.teamName}
                      </span>
                    )}
                  </div>
                </div>

                {/* Status Switcher & Action Buttons */}
                <div className="flex flex-wrap items-center gap-2">
                  {/* Status Dropdown */}
                  <select
                    value={app.status}
                    onChange={(e) => {
                      if (app.id) {
                        void onUpdateStatus(app.id, e.target.value as ApplicationStatus);
                      }
                    }}
                    className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs font-medium text-slate-200 focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="Applied / Registered">Status: Applied / Registered</option>
                    <option value="Shortlisted">Status: Shortlisted</option>
                    <option value="Offline Pass Ready">Status: Offline Pass Ready</option>
                    <option value="Attended">Status: Attended</option>
                  </select>

                  {/* Pass Quick Link */}
                  <button
                    type="button"
                    onClick={() => onGoToCheckin(event.id)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-500/30 bg-indigo-950/40 px-3 py-2 text-xs font-semibold text-indigo-300 transition hover:bg-indigo-900/60"
                  >
                    <QrCode className="h-3.5 w-3.5" />
                    <span>Venue Pass</span>
                  </button>

                  {/* Individual .ics Export */}
                  <button
                    type="button"
                    onClick={() => exportBatchICS([event], `${slugify(event.title)}.ics`)}
                    title="Export event to calendar"
                    className="rounded-xl border border-slate-800 bg-slate-950 p-2 text-slate-400 transition hover:border-slate-700 hover:text-white"
                  >
                    <Calendar className="h-4 w-4" />
                  </button>

                  {/* Host Apply Link */}
                  <a
                    href={event.applyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Open ${event.sourceBadge} portal`}
                    className="rounded-xl border border-slate-800 bg-slate-950 p-2 text-slate-400 transition hover:border-slate-700 hover:text-white"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>

                  {/* Remove Button */}
                  <button
                    type="button"
                    onClick={() => {
                      if (app.id) void onRemoveApplication(app.id);
                    }}
                    title="Remove from tracker"
                    className="rounded-xl border border-slate-800 bg-slate-950 p-2 text-slate-400 transition hover:border-rose-500/40 hover:text-rose-400"
                  >
                    <LogOut className="h-4 w-4 rotate-180" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Venue Offline Check-In Tab (Challenge Card Engine)                        */
/* -------------------------------------------------------------------------- */

function VenueCheckinTab({
  events,
  eventsById,
  wallet,
  student,
  isOnline,
  preselectedEventId,
  enqueueCheckin,
}: {
  events: EventItem[];
  eventsById: Map<string, EventItem>;
  wallet: PendingCheckin[];
  student: StudentProfile | null;
  isOnline: boolean;
  preselectedEventId: string;
  enqueueCheckin: (input: CheckinInput) => Promise<EnqueueResult>;
}) {
  const [eventId, setEventId] = useState(preselectedEventId);
  const [attendeeName, setAttendeeName] = useState(student?.fullName || "");
  const [attendeeEmail, setAttendeeEmail] = useState(student?.rollNoOrEmail || "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const sortedEvents = useMemo(
    () => [...events].sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    [events],
  );

  useEffect(() => {
    if (preselectedEventId) setEventId(preselectedEventId);
  }, [preselectedEventId]);

  useEffect(() => {
    if (!eventId && sortedEvents.length > 0) setEventId(sortedEvents[0].id);
  }, [eventId, sortedEvents]);

  useEffect(() => {
    if (student) {
      if (!attendeeName) setAttendeeName(student.fullName);
      if (!attendeeEmail) setAttendeeEmail(student.rollNoOrEmail);
    }
  }, [student, attendeeName, attendeeEmail]);

  const livePass = useMemo(() => {
    if (activeKey) {
      return wallet.find((item) => item.idempotencyKey === activeKey) ?? null;
    }
    return wallet.length > 0 ? wallet[0] : null;
  }, [wallet, activeKey]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    const name = attendeeName.trim();
    const email = attendeeEmail.trim();
    if (!eventId) return setError("Please select an event to generate a venue pass.");
    if (name.length < 2) return setError("Please enter your full name.");
    if (!EMAIL_RE.test(email)) {
      return setError("Please provide a valid email format (e.g. rollno@college.edu or student@example.com).");
    }

    setSubmitting(true);
    try {
      const { checkin, existed } = await enqueueCheckin({
        eventId,
        attendeeName: name,
        attendeeEmail: email,
      });
      setActiveKey(checkin.idempotencyKey);
      if (existed) {
        setNotice("Attendee already registered locally! Showing your saved pass.");
      } else {
        setNotice(
          isOnline
            ? "Pass recorded & synced with cloud server!"
            : "Offline Pass created & saved to Dexie IndexedDB! Will sync when connection resumes.",
        );
        fireConfetti();
      }
    } catch {
      setError("Failed to save check-in to local IndexedDB. Check storage permissions.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      {/* Left 3 cols: Terminal Form & Device Storage List */}
      <div className="space-y-6 lg:col-span-3">
        {/* Terminal Header Card */}
        <div className="rounded-2xl border border-slate-800/80 bg-slate-900/90 p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-400">
                <ShieldCheck className="h-3.5 w-3.5" />
                <span>Phase 2 Offline Dexie Sync Engine</span>
              </div>
              <h2 className="mt-2 text-lg font-bold text-white">
                Venue Offline Check-In & Entry Verification
              </h2>
              <p className="mt-1 text-xs text-slate-400">
                Works 100% offline at zero-network hackathon venues. Creates tamper-evident SHA-256 QR passes stored locally in Dexie IndexedDB.
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                Select Hackathon / Event
              </label>
              <select
                value={eventId}
                onChange={(e) => setEventId(e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                {sortedEvents.map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    [{ev.sourceBadge}] {ev.title} ({ev.mode})
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Student Full Name
                </label>
                <input
                  type="text"
                  value={attendeeName}
                  onChange={(e) => setAttendeeName(e.target.value)}
                  placeholder="e.g. Aarav Sharma"
                  className="mt-1.5 w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Registered Email
                </label>
                <input
                  type="email"
                  value={attendeeEmail}
                  onChange={(e) => setAttendeeEmail(e.target.value)}
                  placeholder="e.g. aarav@college.edu"
                  className="mt-1.5 w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
                  required
                />
              </div>
            </div>

            {error && (
              <p className="flex items-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-300">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{error}</span>
              </p>
            )}

            {notice && !error && (
              <p className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-300">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>{notice}</span>
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-500 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 transition hover:from-indigo-500 hover:to-indigo-400 disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <QrCode className="h-4 w-4" />
              )}
              <span>Generate Offline Verification Pass</span>
            </button>
          </form>
        </div>

        {/* Local Passes in IndexedDB */}
        <div className="rounded-2xl border border-slate-800/80 bg-slate-900/90 p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-bold text-white">
              <Ticket className="h-4 w-4 text-indigo-400" />
              <span>Offline Verified Passes on this Device</span>
            </h3>
            <span className="text-xs text-slate-400">
              {wallet.length} pass{wallet.length === 1 ? "" : "es"}
            </span>
          </div>

          {wallet.length === 0 ? (
            <p className="mt-3 text-xs text-slate-500">
              No passes generated on this device yet. Complete the form above to generate your offline entry pass.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-800/80">
              {wallet.map((item) => {
                const ev = eventsById.get(item.eventId);
                const isSelected = activeKey === item.idempotencyKey;

                return (
                  <li
                    key={item.idempotencyKey}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-white">
                        {item.attendeeName}
                      </p>
                      <p className="truncate text-xs text-slate-400">
                        {ev?.title ?? item.eventId} · {formatClock(item.checkedInAt)}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <span
                        className={clsx(
                          "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold",
                          item.status === "synced"
                            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                            : item.status === "rejected"
                              ? "border-rose-500/40 bg-rose-500/10 text-rose-400"
                              : "border-amber-500/40 bg-amber-500/10 text-amber-400",
                        )}
                      >
                        {item.status === "synced" ? "Synced with Cloud" : "Saved in Dexie"}
                      </span>

                      <button
                        type="button"
                        onClick={() => setActiveKey(item.idempotencyKey)}
                        className={clsx(
                          "rounded-lg border px-2.5 py-1 text-xs font-semibold transition",
                          isSelected
                            ? "border-indigo-500 bg-indigo-600 text-white"
                            : "border-slate-800 bg-slate-950 text-slate-300 hover:border-slate-700",
                        )}
                      >
                        View Pass
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Right 2 cols: Live Pass Card */}
      <aside className="lg:col-span-2">
        <LiveStudentPassCard
          pass={livePass}
          event={livePass ? eventsById.get(livePass.eventId) : undefined}
        />
      </aside>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Live Student Pass Card with Tamper-Evident SHA-256 Hash                   */
/* -------------------------------------------------------------------------- */

function LiveStudentPassCard({
  pass,
  event,
}: {
  pass: PendingCheckin | null;
  event?: EventItem;
}) {
  if (!pass) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/60 p-8 text-center lg:sticky lg:top-24">
        <QrCode className="mx-auto h-12 w-12 text-slate-700" />
        <h3 className="mt-3 text-sm font-semibold text-slate-300">
          Venue Pass Preview
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          Select or generate a pass to see your tamper-evident QR code and verification badge.
        </p>
      </div>
    );
  }

  const qrValue = `grevix://student-pass?e=${encodeURIComponent(pass.eventId)}&k=${encodeURIComponent(
    pass.idempotencyKey,
  )}&h=${pass.ticketHash}&s=${encodeURIComponent(pass.attendeeName)}`;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800/80 bg-slate-900/90 shadow-xl lg:sticky lg:top-24">
      {/* Header banner */}
      <div className="border-b border-dashed border-slate-800/90 bg-gradient-to-br from-indigo-950/60 via-slate-900 to-slate-900 p-5">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-bold text-emerald-400">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>Official Venue Pass</span>
          </span>
          <span className="text-[11px] font-semibold text-slate-400">
            {event?.sourceBadge ?? "Event"}
          </span>
        </div>

        <h3 className="mt-3 text-base font-bold text-white">
          {event?.title ?? pass.eventId}
        </h3>
        {event && (
          <p className="mt-1 text-xs text-slate-400">
            {formatWhen(event.startsAt, event.endsAt)}
          </p>
        )}

        <div className="mt-4 rounded-xl border border-slate-800/80 bg-slate-950/80 p-3">
          <p className="text-sm font-bold text-white">{pass.attendeeName}</p>
          <p className="text-xs text-slate-400">{pass.attendeeEmail}</p>
        </div>
      </div>

      {/* QR Code and Cryptographic Verification Hash */}
      <div className="flex flex-col items-center gap-4 p-5">
        <div className="rounded-2xl bg-white p-3.5 shadow-md">
          <QRCodeSVG value={qrValue} size={175} level="M" bgColor="#ffffff" fgColor="#020617" />
        </div>

        <div className="w-full space-y-2 text-xs">
          <div className="flex justify-between gap-2 border-b border-slate-800/60 pb-1.5">
            <span className="text-slate-500">Device Clock:</span>
            <span className="text-slate-300 font-medium">{formatClock(pass.checkedInAt)}</span>
          </div>

          <div className="flex justify-between gap-2 border-b border-slate-800/60 pb-1.5">
            <span className="text-slate-500 flex items-center gap-1">
              <Lock className="h-3 w-3 text-indigo-400" />
              <span>SHA-256 Ticket Hash:</span>
            </span>
            <span className="font-mono text-indigo-300" title={pass.ticketHash}>
              {shortHash(pass.ticketHash)}
            </span>
          </div>

          <div className="flex justify-between gap-2">
            <span className="text-slate-500">Cloud Sync Status:</span>
            <span
              className={clsx(
                "font-semibold",
                pass.status === "synced" ? "text-emerald-400" : "text-amber-400",
              )}
            >
              {pass.status === "synced" ? "Verified on Server" : "Cached locally in Dexie"}
            </span>
          </div>
        </div>

        <p className="text-center text-[11px] text-slate-500">
          This digital badge proves offline attendance legitimacy without waiting for venue WiFi connectivity.
        </p>
      </div>
    </div>
  );
}
