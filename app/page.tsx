"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import clsx from "clsx";
import confetti from "canvas-confetti";
import { QRCodeSVG } from "qrcode.react";
import {
  AlertTriangle,
  BarChart3,
  CalendarPlus,
  CheckCircle2,
  Clock,
  Compass,
  Download,
  Globe,
  Loader2,
  MapPin,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Ticket,
  UserCheck,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  buildSeedEvents,
  cacheEvents,
  db,
  getCachedEvents,
  type AnalyticsSnapshot,
  type CheckinStatus,
  type EventCategory,
  type EventItem,
  type EventMode,
  type PendingCheckin,
  type RegionGroup,
} from "@/lib/db";
import {
  useNetworkSync,
  type CheckinInput,
  type EnqueueResult,
} from "@/hooks/useNetworkSync";

/* -------------------------------------------------------------------------- */
/*  Constants and small helpers                                               */
/* -------------------------------------------------------------------------- */

type Tab = "discover" | "checkin" | "dashboard";
type EventsSource = "network" | "cache" | "bundled";

const TABS: { id: Tab; label: string; icon: typeof Compass }[] = [
  { id: "discover", label: "Discover Events", icon: Compass },
  { id: "checkin", label: "Offline Check-In Terminal", icon: UserCheck },
  { id: "dashboard", label: "Organizer Dashboard", icon: BarChart3 },
];

const CATEGORIES: ("All" | EventCategory)[] = [
  "All",
  "Hackathons",
  "Workshops",
  "Conferences",
  "Fests",
  "Meetups",
];
const MODES: ("All" | EventMode)[] = ["All", "Online", "In-Person", "Hybrid"];

type RegionFilter = "All India" | Exclude<RegionGroup, "Other India">;
const REGIONS: RegionFilter[] = [
  "All India",
  "Mumbai / Pune",
  "Bengaluru",
  "Virtual / Global",
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ANALYTICS_CACHE_KEY = "grevix:analytics:v1";

const CATEGORY_STYLES: Record<EventCategory, string> = {
  Hackathons: "border-indigo-500/40 bg-indigo-500/10 text-indigo-300",
  Workshops: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  Conferences: "border-violet-500/40 bg-violet-500/10 text-violet-300",
  Fests: "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300",
  Meetups: "border-teal-500/40 bg-teal-500/10 text-teal-300",
};

const DEMO_NAMES = [
  "Aarav Mehta",
  "Diya Nair",
  "Kabir Shah",
  "Ananya Iyer",
  "Rohan Desai",
  "Meera Kulkarni",
  "Vihaan Rao",
  "Ishita Verma",
];

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

/** Time of day in IST, e.g. "6:30 pm IST". */
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

function formatDelay(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
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
/*  Calendar (.ics) generation. Pure client code, so it works offline.        */
/* -------------------------------------------------------------------------- */

const pad = (n: number) => String(n).padStart(2, "0");
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** UTC form, used only for DTSTAMP. */
function toICSDateUTC(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(
    d.getUTCMinutes(),
  )}${pad(d.getUTCSeconds())}Z`;
}

/** India Standard Time wall-clock form (UTC+05:30), e.g. 20261015T183000. Used with TZID=Asia/Kolkata. */
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

/** RFC 5545 line folding (kept under 75 octets with headroom for multi-byte characters such as the rupee sign). */
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

function generateICS(event: EventItem): string {
  const fee = event.feeInINR === 0 ? "Free" : inrFmt.format(event.feeInINR);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Grevix//EventSync India//EN",
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
    "BEGIN:VEVENT",
    `UID:${event.id}@eventsync-india`,
    `DTSTAMP:${toICSDateUTC(new Date().toISOString())}`,
    `DTSTART;TZID=Asia/Kolkata:${toICSDateIST(event.startsAt)}`,
    `DTEND;TZID=Asia/Kolkata:${toICSDateIST(event.endsAt)}`,
    `SUMMARY:${escapeICS(event.title)}`,
    `DESCRIPTION:${escapeICS(
      `${event.description}\n\nRegistration: ${fee}${event.platform ? ` on ${event.platform}` : ""}\nFormat: ${event.mode}\nOrganizer: ${event.organizer}\nAll times in IST (UTC+05:30).`,
    )}`,
    `LOCATION:${escapeICS(`${event.location}, ${event.city}`)}`,
    `CATEGORIES:${escapeICS(event.category)}`,
    "STATUS:CONFIRMED",
    "BEGIN:VALARM",
    "TRIGGER:-PT30M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeICS(`${event.title} starts in 30 minutes`)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

function downloadICS(event: EventItem): void {
  const blob = new Blob([generateICS(event)], {
    type: "text/calendar;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slugify(event.title)}.ics`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fireConfetti() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#34d399", "#4f46e5", "#fbbf24"];
  confetti({ particleCount: 90, spread: 70, origin: { y: 0.65 }, colors });
  setTimeout(
    () =>
      confetti({
        particleCount: 40,
        angle: 60,
        spread: 55,
        origin: { x: 0, y: 0.7 },
        colors,
      }),
    180,
  );
  setTimeout(
    () =>
      confetti({
        particleCount: 40,
        angle: 120,
        spread: 55,
        origin: { x: 1, y: 0.7 },
        colors,
      }),
    180,
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

export default function Home() {
  const net = useNetworkSync();
  const { isOnline, version } = net;

  const [tab, setTab] = useState<Tab>("discover");
  const [events, setEvents] = useState<EventItem[]>([]);
  const [eventsSource, setEventsSource] = useState<EventsSource | null>(null);
  const [wallet, setWallet] = useState<PendingCheckin[]>([]);
  const [preselectedEventId, setPreselectedEventId] = useState("");

  const eventsById = useMemo(
    () => new Map(events.map((event) => [event.id, event])),
    [events],
  );

  /* Event feed: IndexedDB first, refreshed from the network whenever we're connected. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let cached: EventItem[] = [];
      try {
        cached = await getCachedEvents();
      } catch {
        // IndexedDB unavailable: fall through to network or bundled data.
      }
      if (!cancelled && cached.length > 0) {
        setEvents(cached);
        setEventsSource("cache");
      }

      if (isOnline) {
        try {
          const response = await fetch("/api/events", { cache: "no-store" });
          if (!response.ok)
            throw new Error(`Events request failed with ${response.status}`);
          const data = (await response.json()) as { events: EventItem[] };
          try {
            await cacheEvents(data.events);
          } catch {
            // Caching is best effort.
          }
          if (!cancelled) {
            setEvents(data.events);
            setEventsSource("network");
          }
          return;
        } catch {
          // Fall through to cache or bundled data.
        }
      }

      if (!cancelled && cached.length === 0) {
        const seed = buildSeedEvents();
        try {
          await cacheEvents(seed);
        } catch {
          // Best effort.
        }
        setEvents(seed);
        setEventsSource("bundled");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOnline]);

  /* Local check-ins (the attendee's wallet). Re-read whenever the queue changes. */
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

  /* Service worker: app-shell caching and PWA installability (production builds only). */
  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);

  /* Home-screen shortcuts open /?tab=checkin or /?tab=dashboard. */
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    if (
      requested === "checkin" ||
      requested === "dashboard" ||
      requested === "discover"
    )
      setTab(requested);
  }, []);

  const goToCheckin = useCallback((eventId: string) => {
    setPreselectedEventId(eventId);
    setTab("checkin");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const simulated = net.simulatedOffline;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      {/* ------------------------------ Top bar ------------------------------ */}
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-indigo-600 text-white">
              <Radio className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <p className="text-sm font-semibold leading-none text-slate-100">
                EventSync India
              </p>
              <p className="mt-1 text-xs text-slate-400">
                Tech and campus events, even offline
              </p>
            </div>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span
              role="status"
              aria-live="polite"
              className={clsx(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium",
                isOnline
                  ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-400"
                  : "border-amber-400/40 bg-amber-400/10 text-amber-400",
              )}
            >
              {isOnline ? (
                <Wifi className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <WifiOff className="h-3.5 w-3.5" aria-hidden />
              )}
              {isOnline
                ? "Online"
                : simulated
                  ? "Offline (simulated)"
                  : "Offline"}
            </span>

            <button
              type="button"
              role="switch"
              aria-checked={simulated}
              onClick={net.toggleSimulation}
              className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-slate-700"
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
                    "absolute top-0.5 h-3 w-3 rounded-full bg-slate-950 transition-all",
                    simulated ? "left-3.5" : "left-0.5",
                  )}
                />
              </span>
              Simulate outage
            </button>

            <span
              className={clsx(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium",
                net.pendingCount > 0
                  ? "border-amber-400/40 bg-amber-400/10 text-amber-400"
                  : "border-slate-800 bg-slate-900 text-emerald-400",
              )}
            >
              {net.isSyncing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : net.pendingCount > 0 ? (
                <Clock className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
              )}
              {net.isSyncing
                ? "Syncing..."
                : net.pendingCount > 0
                  ? `${net.pendingCount} waiting to sync`
                  : "All check-ins synced"}
            </span>

            <button
              type="button"
              onClick={() => void net.syncNow({ force: true })}
              disabled={!isOnline || net.isSyncing}
              title={
                isOnline ? "Send queued check-ins now" : "Reconnect to sync"
              }
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
            >
              <RefreshCw
                className={clsx("h-3.5 w-3.5", net.isSyncing && "animate-spin")}
                aria-hidden
              />
              Force Sync
            </button>

            {net.canInstall && (
              <button
                type="button"
                onClick={() => void net.promptInstall()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-400 transition hover:bg-emerald-400/20"
              >
                <Download className="h-3.5 w-3.5" aria-hidden />
                Install App (APK)
              </button>
            )}
            {net.isInstalled && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-400">
                <CheckCircle2
                  className="h-3.5 w-3.5 text-emerald-400"
                  aria-hidden
                />
                Installed
              </span>
            )}
          </div>
        </div>

        {!isOnline && (
          <div className="border-t border-amber-400/30 bg-amber-400/10">
            <p className="mx-auto max-w-6xl px-4 py-2 text-xs text-amber-400">
              {simulated
                ? "Simulated outage is on. Browse events, search, export calendars and check in. Everything is saved on this device and syncs when you switch it off."
                : "No connection. Browse events, search, export calendars and check in. Everything is saved on this device and syncs automatically when you're back online."}
            </p>
          </div>
        )}
        {isOnline && net.lastError && (
          <div className="border-t border-amber-400/30 bg-amber-400/10">
            <p className="mx-auto max-w-6xl px-4 py-2 text-xs text-amber-400">
              Sync paused: {net.lastError} Your check-ins are safe on this
              device. Retrying automatically.
            </p>
          </div>
        )}
        {isOnline &&
          !net.lastError &&
          net.lastSync &&
          net.pendingCount === 0 && (
            <div className="border-t border-emerald-400/20 bg-emerald-400/5">
              <p className="mx-auto max-w-6xl px-4 py-2 text-xs text-emerald-400">
                Synced {net.lastSync.accepted} new check-in
                {net.lastSync.accepted === 1 ? "" : "s"}
                {net.lastSync.duplicates > 0
                  ? `, ${net.lastSync.duplicates} already on record`
                  : ""}
                {net.lastSync.rejected > 0
                  ? `, ${net.lastSync.rejected} rejected`
                  : ""}
                .
              </p>
            </div>
          )}
      </header>

      {/* ------------------------------- Tabs ------------------------------- */}
      <main className="mx-auto max-w-6xl px-4 pb-16 pt-6">
        <div
          role="tablist"
          aria-label="Sections"
          className="flex flex-wrap gap-1 rounded-xl border border-slate-800 bg-slate-900 p-1"
        >
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              id={`tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`panel-${id}`}
              type="button"
              onClick={() => setTab(id)}
              className={clsx(
                "inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition",
                tab === id
                  ? "bg-indigo-600 text-white"
                  : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
              {id === "checkin" && net.pendingCount > 0 && (
                <span className="rounded-full bg-amber-400 px-1.5 text-xs font-semibold text-slate-950">
                  {net.pendingCount}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="mt-6">
          {tab === "discover" && (
            <section
              role="tabpanel"
              id="panel-discover"
              aria-labelledby="tab-discover"
            >
              <DiscoverTab
                events={events}
                source={eventsSource}
                isOnline={isOnline}
                onCheckin={goToCheckin}
              />
            </section>
          )}
          {tab === "checkin" && (
            <section
              role="tabpanel"
              id="panel-checkin"
              aria-labelledby="tab-checkin"
            >
              <CheckinTab
                events={events}
                eventsById={eventsById}
                wallet={wallet}
                isOnline={isOnline}
                preselectedEventId={preselectedEventId}
                enqueueCheckin={net.enqueueCheckin}
              />
            </section>
          )}
          {tab === "dashboard" && (
            <section
              role="tabpanel"
              id="panel-dashboard"
              aria-labelledby="tab-dashboard"
            >
              <DashboardTab
                events={events}
                eventsById={eventsById}
                wallet={wallet}
                isOnline={isOnline}
                syncStamp={net.lastSync?.at ?? ""}
              />
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Discover                                                                  */
/* -------------------------------------------------------------------------- */

function DiscoverTab({
  events,
  source,
  isOnline,
  onCheckin,
}: {
  events: EventItem[];
  source: EventsSource | null;
  isOnline: boolean;
  onCheckin: (eventId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"All" | EventCategory>("All");
  const [mode, setMode] = useState<"All" | EventMode>("All");
  const [region, setRegion] = useState<RegionFilter>("All India");

  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return events
      .filter((event) =>
        category === "All" ? true : event.category === category,
      )
      .filter((event) => (mode === "All" ? true : event.mode === mode))
      .filter((event) =>
        region === "All India" ? true : event.regionGroup === region,
      )
      .filter((event) => {
        if (terms.length === 0) return true;
        const haystack =
          `${event.title} ${event.tags.join(" ")} ${event.description} ${event.city} ${event.stateRegion} ${event.platform ?? ""}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }, [events, query, category, mode, region]);

  const sourceLabel = !isOnline
    ? "Showing events saved on this device"
    : source === "network"
      ? "Live from the server, saved for offline use"
      : source === "bundled"
        ? "Showing built-in sample events"
        : "Showing events saved on this device";

  return (
    <div className="space-y-5">
      <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div className="relative">
          <label htmlFor="event-search" className="sr-only">
            Search events by title, tag, city or platform
          </label>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
            aria-hidden
          />
          <input
            id="event-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Search by title, tag, city or platform, e.g. "unstop", "pune" or "web3"'
            className="w-full rounded-lg border border-slate-800 bg-slate-950 py-2.5 pl-10 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500"
          />
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <FilterGroup
            label="Region"
            options={REGIONS}
            value={region}
            onChange={setRegion}
          />
          <FilterGroup
            label="Category"
            options={CATEGORIES}
            value={category}
            onChange={setCategory}
          />
          <FilterGroup
            label="Mode"
            options={MODES}
            value={mode}
            onChange={setMode}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
        <span aria-live="polite">
          {filtered.length} event{filtered.length === 1 ? "" : "s"}
        </span>
        <span
          className={clsx(
            "inline-flex items-center gap-1.5",
            isOnline ? "text-emerald-400" : "text-amber-400",
          )}
        >
          <span
            className={clsx(
              "h-1.5 w-1.5 rounded-full",
              isOnline ? "bg-emerald-400" : "bg-amber-400",
            )}
            aria-hidden
          />
          {sourceLabel}
        </span>
      </div>

      {events.length === 0 ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900 p-8 text-center text-sm text-slate-400">
          Loading events...
        </p>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900 p-8 text-center">
          <p className="text-sm font-medium text-slate-200">
            No events match your search
          </p>
          <p className="mt-1 text-sm text-slate-400">
            Clear the search box or switch the category and mode filters back to
            All.
          </p>
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setCategory("All");
              setMode("All");
              setRegion("All India");
            }}
            className="mt-4 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            Reset filters
          </button>
        </div>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {filtered.map((event) => (
            <li key={event.id}>
              <EventCard event={event} onCheckin={onCheckin} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: T[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-wrap items-center gap-2"
    >
      <span className="text-xs text-slate-500">{label}</span>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={clsx(
            "rounded-full border px-3 py-1 text-xs font-medium transition",
            value === option
              ? "border-indigo-500 bg-indigo-600 text-white"
              : "border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700 hover:text-slate-200",
          )}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function EventCard({
  event,
  onCheckin,
}: {
  event: EventItem;
  onCheckin: (eventId: string) => void;
}) {
  const seatsLeft = Math.max(0, event.capacity - event.registered);
  const fill = Math.min(
    100,
    Math.round((event.registered / event.capacity) * 100),
  );

  return (
    <article className="flex h-full flex-col rounded-xl border border-slate-800 bg-slate-900 p-5 transition-colors hover:border-slate-700">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={clsx(
            "rounded-full border px-2.5 py-0.5 text-xs font-medium",
            CATEGORY_STYLES[event.category],
          )}
        >
          {event.category}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-800 bg-slate-950 px-2.5 py-0.5 text-xs text-slate-400">
          {event.mode === "Online" ? (
            <Globe className="h-3 w-3" aria-hidden />
          ) : (
            <MapPin className="h-3 w-3" aria-hidden />
          )}
          {event.mode}
        </span>
        <span
          className={clsx(
            "rounded-full border px-2.5 py-0.5 text-xs font-medium",
            event.feeInINR === 0
              ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-400"
              : "border-slate-700 bg-slate-950 text-slate-200",
          )}
        >
          {formatFee(event.feeInINR)}
        </span>
      </div>

      <h3 className="mt-3 text-lg font-semibold text-slate-100">
        {event.title}
      </h3>
      <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-slate-400">
        {event.description}
      </p>

      <dl className="mt-4 space-y-1.5 text-sm text-slate-300">
        <div className="flex items-start gap-2">
          <dt className="sr-only">When</dt>
          <Clock
            className="mt-0.5 h-4 w-4 shrink-0 text-slate-500"
            aria-hidden
          />
          <dd>{formatWhen(event.startsAt, event.endsAt)}</dd>
        </div>
        <div className="flex items-start gap-2">
          <dt className="sr-only">Where</dt>
          <MapPin
            className="mt-0.5 h-4 w-4 shrink-0 text-slate-500"
            aria-hidden
          />
          <dd>
            {event.location}, {event.stateRegion}
            {event.platform ? ` · via ${event.platform}` : ""}
          </dd>
        </div>
      </dl>

      <ul className="mt-4 flex flex-wrap gap-1.5" aria-label="Tags">
        {event.tags.map((tag) => (
          <li
            key={tag}
            className="rounded-md bg-slate-950 px-2 py-0.5 text-xs text-slate-400"
          >
            {tag}
          </li>
        ))}
      </ul>

      <div className="mt-5">
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>{event.registered.toLocaleString("en-IN")} registered</span>
          <span>
            {seatsLeft === 0
              ? "Full"
              : `${seatsLeft.toLocaleString("en-IN")} spots left`}
          </span>
        </div>
        <div
          className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-800"
          role="img"
          aria-label={`${fill}% of capacity registered`}
        >
          <div
            className="h-full rounded-full bg-indigo-600"
            style={{ width: `${fill}%` }}
          />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          onClick={() => downloadICS(event)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-700"
        >
          <CalendarPlus className="h-4 w-4" aria-hidden />
          Add to calendar
        </button>
        <button
          type="button"
          onClick={() => onCheckin(event.id)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
        >
          <UserCheck className="h-4 w-4" aria-hidden />
          Check in
        </button>
      </div>
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/*  Check-in terminal                                                         */
/* -------------------------------------------------------------------------- */

function StatusChip({
  status,
  serverResult,
}: {
  status: CheckinStatus;
  serverResult?: "accepted" | "duplicate";
}) {
  if (status === "synced") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400">
        <CheckCircle2 className="h-3 w-3" aria-hidden />
        {serverResult === "duplicate"
          ? "Verified, already on record"
          : "Verified by server"}
      </span>
    );
  }
  if (status === "syncing") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-400/10 px-2.5 py-0.5 text-xs font-medium text-amber-400">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        Syncing
      </span>
    );
  }
  if (status === "rejected") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-rose-400/40 bg-rose-400/10 px-2.5 py-0.5 text-xs font-medium text-rose-400">
        <AlertTriangle className="h-3 w-3" aria-hidden />
        Rejected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-400/10 px-2.5 py-0.5 text-xs font-medium text-amber-400">
      <Clock className="h-3 w-3" aria-hidden />
      Saved on device
    </span>
  );
}

function CheckinTab({
  events,
  eventsById,
  wallet,
  isOnline,
  preselectedEventId,
  enqueueCheckin,
}: {
  events: EventItem[];
  eventsById: Map<string, EventItem>;
  wallet: PendingCheckin[];
  isOnline: boolean;
  preselectedEventId: string;
  enqueueCheckin: (input: CheckinInput) => Promise<EnqueueResult>;
}) {
  const [eventId, setEventId] = useState(preselectedEventId);
  const [attendeeName, setAttendeeName] = useState("");
  const [attendeeEmail, setAttendeeEmail] = useState("");
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

  const livePass = useMemo(
    () =>
      activeKey
        ? (wallet.find((item) => item.idempotencyKey === activeKey) ?? null)
        : null,
    [wallet, activeKey],
  );

  function fillDemoAttendee() {
    const name = DEMO_NAMES[Math.floor(Math.random() * DEMO_NAMES.length)];
    const suffix = Math.floor(Math.random() * 900) + 100;
    setAttendeeName(name);
    setAttendeeEmail(
      `${name.toLowerCase().replace(/[^a-z]+/g, ".")}${suffix}@example.com`,
    );
    setError(null);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    const name = attendeeName.trim();
    const email = attendeeEmail.trim();
    if (!eventId) return setError("Choose an event to check in to.");
    if (name.length < 2) return setError("Enter the attendee's full name.");
    if (!EMAIL_RE.test(email))
      return setError(
        "Enter a valid email address, for example name@example.com.",
      );

    setSubmitting(true);
    try {
      const { checkin, existed } = await enqueueCheckin({
        eventId,
        attendeeName: name,
        attendeeEmail: email,
      });
      setActiveKey(checkin.idempotencyKey);
      if (existed) {
        setNotice(
          "This attendee is already checked in for this event. Showing the existing pass.",
        );
      } else {
        setNotice(
          isOnline
            ? "Checked in. Confirming with the server now."
            : "Checked in on this device. It will sync automatically when the connection returns.",
        );
        fireConfetti();
        setAttendeeName("");
        setAttendeeEmail("");
      }
    } catch {
      setError(
        "Couldn't save this check-in on the device. Check that browser storage is allowed, then try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="space-y-6 lg:col-span-3">
        <form
          onSubmit={handleSubmit}
          noValidate
          className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-5"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Check in an attendee
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                Saved on this device first, so it works with no signal. The pass
                appears instantly.
              </p>
            </div>
            <button
              type="button"
              onClick={fillDemoAttendee}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-700"
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              Fill demo attendee
            </button>
          </div>

          <div>
            <label
              htmlFor="checkin-event"
              className="block text-sm font-medium text-slate-300"
            >
              Event
            </label>
            <select
              id="checkin-event"
              value={eventId}
              onChange={(e) => setEventId(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 focus:border-indigo-500"
            >
              {sortedEvents.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.title} ({event.mode})
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="checkin-name"
                className="block text-sm font-medium text-slate-300"
              >
                Full name
              </label>
              <input
                id="checkin-name"
                value={attendeeName}
                onChange={(e) => setAttendeeName(e.target.value)}
                autoComplete="name"
                placeholder="Aarav Mehta"
                className="mt-1.5 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500"
              />
            </div>
            <div>
              <label
                htmlFor="checkin-email"
                className="block text-sm font-medium text-slate-300"
              >
                Email
              </label>
              <input
                id="checkin-email"
                type="email"
                value={attendeeEmail}
                onChange={(e) => setAttendeeEmail(e.target.value)}
                autoComplete="email"
                placeholder="aarav@example.com"
                className="mt-1.5 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500"
              />
            </div>
          </div>

          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-sm text-rose-400"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {error}
            </p>
          )}
          {notice && !error && (
            <p
              role="status"
              className={clsx(
                "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
                isOnline
                  ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-400"
                  : "border-amber-400/30 bg-amber-400/10 text-amber-400",
              )}
            >
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {notice}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || events.length === 0}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <UserCheck className="h-4 w-4" aria-hidden />
            )}
            Check in
          </button>
        </form>

        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-100">
            <Ticket className="h-4 w-4 text-slate-400" aria-hidden />
            Check-ins on this device
          </h2>
          {wallet.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">
              Nothing here yet. Complete a check-in above and the pass is stored
              on this device.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-800">
              {wallet.map((item) => (
                <li
                  key={item.idempotencyKey}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-100">
                      {item.attendeeName}
                    </p>
                    <p className="truncate text-xs text-slate-400">
                      {eventsById.get(item.eventId)?.title ?? item.eventId} ·{" "}
                      {formatClock(item.checkedInAt)}
                    </p>
                    {item.status === "rejected" && item.lastError && (
                      <p className="mt-1 text-xs text-rose-400">
                        {item.lastError}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusChip
                      status={item.status}
                      serverResult={item.serverResult}
                    />
                    <button
                      type="button"
                      onClick={() => setActiveKey(item.idempotencyKey)}
                      className="rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1 text-xs font-medium text-slate-300 hover:border-slate-700"
                    >
                      Show pass
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <aside className="lg:col-span-2">
        <PassCard
          pass={livePass}
          event={livePass ? eventsById.get(livePass.eventId) : undefined}
        />
      </aside>
    </div>
  );
}

function PassCard({
  pass,
  event,
}: {
  pass: PendingCheckin | null;
  event?: EventItem;
}) {
  if (!pass) {
    return (
      <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900 p-6 text-center lg:sticky lg:top-28">
        <Ticket className="mx-auto h-8 w-8 text-slate-600" aria-hidden />
        <p className="mt-3 text-sm font-medium text-slate-200">
          Your pass will appear here
        </p>
        <p className="mt-1 text-sm text-slate-400">
          Check in an attendee to generate a QR pass with a tamper-evident
          ticket hash.
        </p>
      </div>
    );
  }

  const qrValue = `grevix://ticket?e=${encodeURIComponent(pass.eventId)}&k=${encodeURIComponent(pass.idempotencyKey)}&h=${pass.ticketHash}`;

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 lg:sticky lg:top-28">
      <div className="border-b border-dashed border-slate-800 p-5">
        <StatusChip status={pass.status} serverResult={pass.serverResult} />
        <h2 className="mt-3 text-lg font-semibold text-slate-100">
          {event?.title ?? pass.eventId}
        </h2>
        {event && (
          <p className="mt-1 text-sm text-slate-400">
            {formatWhen(event.startsAt, event.endsAt)}
          </p>
        )}
        <p className="mt-4 text-base font-medium text-slate-100">
          {pass.attendeeName}
        </p>
        <p className="text-sm text-slate-400">{pass.attendeeEmail}</p>
      </div>

      <div className="flex flex-col items-center gap-4 p-5">
        <div className="rounded-xl bg-white p-3">
          <QRCodeSVG
            value={qrValue}
            size={168}
            level="M"
            bgColor="#ffffff"
            fgColor="#020617"
          />
        </div>
        <dl className="w-full space-y-2 text-xs">
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Checked in</dt>
            <dd className="text-slate-300">{formatClock(pass.checkedInAt)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="flex items-center gap-1 text-slate-500">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
              Ticket hash
            </dt>
            <dd
              className="break-all text-right font-mono text-slate-300"
              title={pass.ticketHash}
            >
              {shortHash(pass.ticketHash)}
            </dd>
          </div>
          {pass.syncedAt && (
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Server confirmed</dt>
              <dd className="text-emerald-400">{formatClock(pass.syncedAt)}</dd>
            </div>
          )}
        </dl>
        <p className="text-center text-xs text-slate-500">
          {pass.status === "pending" || pass.status === "syncing"
            ? "This pass is valid on this device now. Server confirmation follows when you're online."
            : pass.status === "rejected"
              ? "The server could not verify this check-in. Ask an organizer for help."
              : "Confirmed by the organizer's server."}
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Organizer dashboard                                                       */
/* -------------------------------------------------------------------------- */

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: "indigo" | "emerald" | "amber" | "slate";
}) {
  const toneClass = {
    indigo: "text-indigo-300",
    emerald: "text-emerald-400",
    amber: "text-amber-400",
    slate: "text-slate-100",
  }[tone];
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <p className="text-xs text-slate-400">{label}</p>
      <p
        className={clsx("mt-2 text-3xl font-semibold tabular-nums", toneClass)}
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </div>
  );
}

function DashboardTab({
  events,
  eventsById,
  wallet,
  isOnline,
  syncStamp,
}: {
  events: EventItem[];
  eventsById: Map<string, EventItem>;
  wallet: PendingCheckin[];
  isOnline: boolean;
  syncStamp: string;
}) {
  const [analytics, setAnalytics] = useState<AnalyticsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Show the last known figures immediately, even with no connection. */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(ANALYTICS_CACHE_KEY);
      if (raw) setAnalytics(JSON.parse(raw) as AnalyticsSnapshot);
    } catch {
      // Ignore unreadable cache.
    }
  }, []);

  /* Live refresh while online, and right after each successful sync. */
  useEffect(() => {
    if (!isOnline) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const response = await fetch("/api/checkin/sync", {
          cache: "no-store",
        });
        if (!response.ok)
          throw new Error(`Analytics request failed with ${response.status}`);
        const data = (await response.json()) as AnalyticsSnapshot;
        if (cancelled) return;
        setAnalytics(data);
        setError(null);
        try {
          localStorage.setItem(ANALYTICS_CACHE_KEY, JSON.stringify(data));
        } catch {
          // Storage full or blocked. Fine.
        }
      } catch {
        if (!cancelled)
          setError(
            "Couldn't reach the server. Showing the last known figures.",
          );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isOnline, syncStamp]);

  const queued = useMemo(
    () =>
      wallet.filter(
        (item) => item.status === "pending" || item.status === "syncing",
      ),
    [wallet],
  );
  const queuedByEvent = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of queued)
      map.set(item.eventId, (map.get(item.eventId) ?? 0) + 1);
    return map;
  }, [queued]);

  const registrations =
    analytics?.totals.registrations ??
    events.reduce((sum, event) => sum + event.registered, 0);
  const verified = analytics?.totals.verified ?? 0;
  const pending = queued.length;
  const conversion = registrations > 0 ? (verified / registrations) * 100 : 0;
  const projected =
    registrations > 0 ? ((verified + pending) / registrations) * 100 : 0;
  const verifiedPct =
    registrations > 0 ? Math.min(100, (verified / registrations) * 100) : 0;
  const pendingPct =
    registrations > 0
      ? Math.min(100 - verifiedPct, (pending / registrations) * 100)
      : 0;
  const registrationRevenue =
    analytics?.totals.registrationRevenueINR ??
    events.reduce((sum, event) => sum + event.registered * event.feeInINR, 0);

  const perEvent = useMemo(() => {
    if (analytics) return analytics.perEvent;
    return events.map((event) => ({
      eventId: event.id,
      title: event.title,
      registered: event.registered,
      verified: 0,
      rate: 0,
    }));
  }, [analytics, events]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Attendance overview
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Server-verified check-ins compared with check-ins still waiting on
            devices.
          </p>
        </div>
        <span
          className={clsx(
            "inline-flex items-center gap-1.5 text-xs",
            isOnline ? "text-emerald-400" : "text-amber-400",
          )}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <span
              className={clsx(
                "h-1.5 w-1.5 rounded-full",
                isOnline ? "bg-emerald-400" : "bg-amber-400",
              )}
              aria-hidden
            />
          )}
          {isOnline
            ? analytics
              ? `Live, updated ${fmtTime(analytics.generatedAt)}`
              : "Connecting..."
            : analytics
              ? `Offline. Last server figures from ${fmtTime(analytics.generatedAt)}`
              : "Offline. Server figures load once you're connected."}
        </span>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-400"
        >
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Total registrations"
          value={registrations.toLocaleString("en-IN")}
          hint="Across all events"
          tone="slate"
        />
        <Stat
          label="Verified attendance"
          value={verified.toLocaleString("en-IN")}
          hint="Confirmed by the server"
          tone="emerald"
        />
        <Stat
          label="Pending on this device"
          value={pending.toLocaleString("en-IN")}
          hint="Queued, not yet confirmed"
          tone="amber"
        />
        <Stat
          label="Conversion rate"
          value={`${conversion.toFixed(1)}%`}
          hint={
            pending > 0
              ? `${projected.toFixed(1)}% once the queue syncs`
              : "Verified of registered"
          }
          tone="indigo"
        />
      </div>

      <p className="text-sm text-slate-400">
        Registration fees across all events:{" "}
        <span className="font-medium tabular-nums text-slate-200">
          {inrFmt.format(registrationRevenue)}
        </span>
      </p>

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
          <span className="flex items-center gap-4">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-full bg-emerald-400"
                aria-hidden
              />{" "}
              Verified
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-amber-400" aria-hidden />{" "}
              Pending
            </span>
          </span>
          <span>of {registrations.toLocaleString("en-IN")} registered</span>
        </div>
        <div
          className="mt-3 flex h-3 overflow-hidden rounded-full bg-slate-800"
          role="img"
          aria-label={`${verified} verified and ${pending} pending out of ${registrations} registered`}
        >
          <div
            className="bg-emerald-400 transition-[width] duration-500"
            style={{ width: `${verifiedPct}%` }}
          />
          <div
            className="bg-amber-400 transition-[width] duration-500"
            style={{ width: `${pendingPct}%` }}
          />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 lg:col-span-3">
          <h3 className="flex items-center gap-2 border-b border-slate-800 px-5 py-3 text-sm font-semibold text-slate-100">
            <Users className="h-4 w-4 text-slate-400" aria-hidden />
            By event
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th scope="col" className="px-5 py-2 font-medium">
                    Event
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Registered
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Verified
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Pending here
                  </th>
                  <th scope="col" className="px-5 py-2 text-right font-medium">
                    Rate
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {perEvent.map((row) => (
                  <tr key={row.eventId}>
                    <td className="max-w-[16rem] truncate px-5 py-2.5 text-slate-200">
                      {row.title}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">
                      {row.registered.toLocaleString("en-IN")}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald-400">
                      {row.verified}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-amber-400">
                      {queuedByEvent.get(row.eventId) ?? 0}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-slate-300">
                      {row.rate.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 lg:col-span-2">
          <h3 className="flex items-center gap-2 border-b border-slate-800 px-5 py-3 text-sm font-semibold text-slate-100">
            <ShieldCheck className="h-4 w-4 text-slate-400" aria-hidden />
            Live check-in ledger
          </h3>
          {queued.length === 0 &&
          (!analytics || analytics.ledger.length === 0) ? (
            <p className="p-5 text-sm text-slate-400">
              No check-ins yet. Use the Check-In Terminal to record the first
              one.
            </p>
          ) : (
            <ul className="max-h-[28rem] divide-y divide-slate-800 overflow-y-auto">
              {queued.map((item) => (
                <li
                  key={`q-${item.idempotencyKey}`}
                  className="flex items-start justify-between gap-3 px-5 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-100">
                      {item.attendeeName}
                    </p>
                    <p className="truncate text-xs text-slate-400">
                      {eventsById.get(item.eventId)?.title ?? item.eventId}
                    </p>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-xs text-amber-400">
                    <Clock className="h-3 w-3" aria-hidden />
                    Waiting
                  </span>
                </li>
              ))}
              {analytics?.ledger.map((entry) => (
                <li
                  key={`s-${entry.idempotencyKey}`}
                  className="flex items-start justify-between gap-3 px-5 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-100">
                      {entry.attendeeName}
                    </p>
                    <p className="truncate text-xs text-slate-400">
                      {entry.eventTitle} · {fmtTime(entry.checkedInAt)}
                      {entry.offlineQueued
                        ? ` · queued offline ${formatDelay(entry.delaySeconds)}`
                        : ""}
                    </p>
                  </div>
                  <span
                    className={clsx(
                      "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                      entry.verified
                        ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-400"
                        : "border-amber-400/40 bg-amber-400/10 text-amber-400",
                    )}
                  >
                    <CheckCircle2 className="h-3 w-3" aria-hidden />
                    {entry.verified ? "Verified" : "Hash unchecked"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
