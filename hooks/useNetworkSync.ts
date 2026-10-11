"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  countUnsynced,
  createTicketHash,
  db,
  makeIdempotencyKey,
  ticketPayload,
  type PendingCheckin,
} from "@/lib/db";

/** Chrome's non-standard install prompt event. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

declare global {
  interface Window {
    /** Captured by an inline script in app/layout.tsx before React hydrates. */
    __deferredInstallPrompt?: BeforeInstallPromptEvent;
  }
}

export type InstallOutcome = "accepted" | "dismissed" | "unavailable";

const SYNC_ENDPOINT = "/api/checkin/sync";
const BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 5_000;
const BASE_RETRY_MS = 3_000;
const MAX_RETRY_MS = 60_000;

export interface SyncSummary {
  accepted: number;
  duplicates: number;
  rejected: number;
  /** ISO timestamp of when the run finished. */
  at: string;
}

export interface CheckinInput {
  eventId: string;
  attendeeName: string;
  attendeeEmail: string;
}

export interface EnqueueResult {
  checkin: PendingCheckin;
  /** true when this attendee was already checked in on this device. */
  existed: boolean;
}

interface ServerItemResult {
  idempotencyKey: string;
  status: "accepted" | "duplicate" | "rejected";
  reason?: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError")
    return "The server took too long to respond.";
  if (error instanceof Error) return error.message;
  return "Unknown sync error.";
}

/**
 * Single source of truth for connectivity and the offline check-in queue.
 *
 * - `isOnline` = real browser state (navigator.onLine + window events) AND the demo simulator being off.
 * - Check-ins are written to IndexedDB first, so the UI never waits on the network.
 * - Whenever the connection is available, the queue is flushed in batches to POST /api/checkin/sync.
 *   The server is idempotent, so retries after a lost response are always safe.
 */
export function useNetworkSync() {
  const [browserOnline, setBrowserOnline] = useState(true);
  const [simulatedOffline, setSimulatedOffline] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncSummary | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  /** Bumps whenever local check-in data may have changed, so views can re-read IndexedDB. */
  const [version, setVersion] = useState(0);
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);

  const isOnline = browserOnline && !simulatedOffline;

  const isOnlineRef = useRef(isOnline);
  const syncingRef = useRef(false);
  const failuresRef = useRef(0);
  const nextAttemptRef = useRef(0);

  useEffect(() => {
    isOnlineRef.current = isOnline;
  }, [isOnline]);

  const refreshCounts = useCallback(async () => {
    try {
      setPendingCount(await countUnsynced());
    } catch {
      // IndexedDB can be unavailable (private mode on some browsers). The UI keeps working with a zero count.
    }
    setVersion((v) => v + 1);
  }, []);

  /** Flush every pending check-in. Resolves with a summary, or null if nothing ran or the attempt failed. */
  const syncNow = useCallback(
    async (options?: { force?: boolean }): Promise<SyncSummary | null> => {
      const force = options?.force === true;
      if (syncingRef.current) return null;
      if (!isOnlineRef.current) {
        if (force)
          setLastError(
            "You're offline. Check-ins stay saved on this device until the connection returns.",
          );
        return null;
      }
      if (force) {
        failuresRef.current = 0;
        nextAttemptRef.current = 0;
      }

      syncingRef.current = true;
      setIsSyncing(true);
      setLastError(null);

      const summary: SyncSummary = {
        accepted: 0,
        duplicates: 0,
        rejected: 0,
        at: "",
      };

      try {
        // A tab closed mid-request can leave rows in "syncing". Put them back in the queue.
        await db.pendingCheckins
          .where("status")
          .equals("syncing")
          .modify({ status: "pending" });
        const queue = await db.pendingCheckins
          .where("status")
          .equals("pending")
          .sortBy("checkedInAt");

        for (let start = 0; start < queue.length; start += BATCH_SIZE) {
          if (!isOnlineRef.current)
            throw new Error(
              "Connection lost during sync. Remaining check-ins are still queued.",
            );

          const batch = queue.slice(start, start + BATCH_SIZE);
          const ids = batch.map((item) => item.id as number);

          await db.pendingCheckins
            .where("id")
            .anyOf(ids)
            .modify({ status: "syncing" });
          setVersion((v) => v + 1);

          try {
            const controller = new AbortController();
            const timer = setTimeout(
              () => controller.abort(),
              REQUEST_TIMEOUT_MS,
            );
            let response: Response;
            try {
              response = await fetch(SYNC_ENDPOINT, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  checkins: batch.map((item) => ({
                    idempotencyKey: item.idempotencyKey,
                    eventId: item.eventId,
                    attendeeName: item.attendeeName,
                    attendeeEmail: item.attendeeEmail,
                    checkedInAt: item.checkedInAt,
                    ticketHash: item.ticketHash,
                  })),
                }),
                signal: controller.signal,
              });
            } finally {
              clearTimeout(timer);
            }
            if (!response.ok)
              throw new Error(`Server responded with ${response.status}.`);

            const data = (await response.json()) as {
              results?: ServerItemResult[];
            };
            const byKey = new Map(
              (data.results ?? []).map((result) => [
                result.idempotencyKey,
                result,
              ]),
            );
            const now = new Date().toISOString();

            await db.transaction("rw", db.pendingCheckins, async () => {
              for (const item of batch) {
                const result = byKey.get(item.idempotencyKey);
                if (!result) {
                  await db.pendingCheckins.update(item.id as number, {
                    status: "pending",
                    attempts: item.attempts + 1,
                    lastError: "The server did not acknowledge this check-in.",
                  });
                } else if (result.status === "rejected") {
                  summary.rejected += 1;
                  await db.pendingCheckins.update(item.id as number, {
                    status: "rejected",
                    attempts: item.attempts + 1,
                    lastError: result.reason ?? "Rejected by the server.",
                  });
                } else {
                  if (result.status === "accepted") summary.accepted += 1;
                  else summary.duplicates += 1;
                  await db.pendingCheckins.update(item.id as number, {
                    status: "synced",
                    syncedAt: now,
                    serverResult: result.status,
                    lastError: undefined,
                  });
                }
              }
            });
          } catch (error) {
            // Network drop, timeout or 5xx: nothing was lost. Put the batch back and let the backoff retry it.
            const message = errorMessage(error);
            await db.pendingCheckins
              .where("id")
              .anyOf(ids)
              .and((item) => item.status === "syncing")
              .modify((item) => {
                item.status = "pending";
                item.attempts += 1;
                item.lastError = message;
              });
            throw error;
          }
        }

        failuresRef.current = 0;
        nextAttemptRef.current = 0;
        summary.at = new Date().toISOString();
        if (summary.accepted + summary.duplicates + summary.rejected > 0)
          setLastSync(summary);
        return summary;
      } catch (error) {
        failuresRef.current += 1;
        const delay = Math.min(
          MAX_RETRY_MS,
          BASE_RETRY_MS * 2 ** (failuresRef.current - 1),
        );
        nextAttemptRef.current = Date.now() + delay;
        setLastError(errorMessage(error));
        return null;
      } finally {
        syncingRef.current = false;
        setIsSyncing(false);
        await refreshCounts();
      }
    },
    [refreshCounts],
  );

  /** Save a check-in locally (instant, works offline) and kick off a sync if we're connected. */
  const enqueueCheckin = useCallback(
    async (input: CheckinInput): Promise<EnqueueResult> => {
      const attendeeEmail = input.attendeeEmail.trim().toLowerCase();
      const attendeeName = input.attendeeName.trim();
      const idempotencyKey = makeIdempotencyKey(input.eventId, attendeeEmail);

      const existing = await db.pendingCheckins
        .where("idempotencyKey")
        .equals(idempotencyKey)
        .first();
      if (existing) return { checkin: existing, existed: true };

      const checkedInAt = new Date().toISOString();
      const ticketHash = await createTicketHash(
        ticketPayload({
          eventId: input.eventId,
          attendeeEmail,
          checkedInAt,
          idempotencyKey,
        }),
      );

      const record: PendingCheckin = {
        idempotencyKey,
        eventId: input.eventId,
        attendeeName,
        attendeeEmail,
        checkedInAt,
        ticketHash,
        status: "pending",
        attempts: 0,
      };

      try {
        record.id = await db.pendingCheckins.add(record);
      } catch (error) {
        // Two quick taps (or two tabs) raced on the unique index. Return the winner instead of failing.
        if (error instanceof Error && error.name === "ConstraintError") {
          const winner = await db.pendingCheckins
            .where("idempotencyKey")
            .equals(idempotencyKey)
            .first();
          if (winner) return { checkin: winner, existed: true };
        }
        throw error;
      }

      await refreshCounts();
      if (isOnlineRef.current) void syncNow();
      return { checkin: record, existed: false };
    },
    [refreshCounts, syncNow],
  );

  /** Mirror the browser's connectivity events. */
  useEffect(() => {
    setBrowserOnline(navigator.onLine);
    const goOnline = () => setBrowserOnline(true);
    const goOffline = () => setBrowserOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    void refreshCounts();
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [refreshCounts]);

  /** PWA install: capture Chrome's prompt so we can offer our own "Install App" button. */
  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    setIsInstalled(standalone);

    if (window.__deferredInstallPrompt)
      setInstallPrompt(window.__deferredInstallPrompt);

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      window.__deferredInstallPrompt = event as BeforeInstallPromptEvent;
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      window.__deferredInstallPrompt = undefined;
      setInstallPrompt(null);
      setIsInstalled(true);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<InstallOutcome> => {
    if (!installPrompt) return "unavailable";
    await installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    // A prompt event can only be used once.
    window.__deferredInstallPrompt = undefined;
    setInstallPrompt(null);
    if (outcome === "accepted") setIsInstalled(true);
    return outcome;
  }, [installPrompt]);

  /** Connection restored (real or simulator switched off): flush the queue right away. */
  useEffect(() => {
    if (!isOnline) return;
    failuresRef.current = 0;
    nextAttemptRef.current = 0;
    const timer = setTimeout(() => void syncNow(), 400);
    return () => clearTimeout(timer);
  }, [isOnline, syncNow]);

  /** Safety net: retry with exponential backoff while anything is still queued. Also picks up writes from other tabs. */
  useEffect(() => {
    const interval = setInterval(async () => {
      let waiting = 0;
      try {
        waiting = await countUnsynced();
      } catch {
        return;
      }
      setPendingCount((current) => (current === waiting ? current : waiting));
      if (
        waiting > 0 &&
        isOnlineRef.current &&
        !syncingRef.current &&
        Date.now() >= nextAttemptRef.current
      ) {
        void syncNow();
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [syncNow]);

  const toggleSimulation = useCallback(
    () => setSimulatedOffline((value) => !value),
    [],
  );

  return {
    isOnline,
    browserOnline,
    simulatedOffline,
    setSimulatedOffline,
    toggleSimulation,
    pendingCount,
    isSyncing,
    lastSync,
    lastError,
    version,
    syncNow,
    enqueueCheckin,
    refreshCounts,
    canInstall: installPrompt !== null && !isInstalled,
    isInstalled,
    promptInstall,
  };
}
