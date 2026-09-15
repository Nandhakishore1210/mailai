import { mailApi } from "./api";
import { EmailSummary } from "./types";

/**
 * Realtime mail sync.
 *
 * Primary path: a Server-Sent Events stream. The browser opens one connection
 * and the backend pushes when the mailbox changes (IMAP IDLE for app-password
 * accounts, Gmail Pub/Sub or a short server-side history check otherwise).
 * The browser never polls.
 *
 * Events carry the inbox, so an arrival renders with no follow-up request.
 * They also carry an id: EventSource replays it back as `Last-Event-ID` when it
 * reconnects, so a sleep or a dropped network is caught up rather than guessed
 * at. If the server says we are past its buffer it sends `resync` and we
 * refetch from scratch.
 *
 * Fallback: if EventSource is unavailable or the stream cannot connect after a
 * few tries (a proxy that buffers, say) we drop back to polling, so sync
 * degrades rather than breaking.
 */

export interface ChangeEvent {
  source: string;
  inbox?: EmailSummary[];
}

type Handler = (info: ChangeEvent) => void;

let source: EventSource | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let onVisible: (() => void) | null = null;
let failures = 0;
let stopped = true;

const STREAM_URL = `${process.env.NEXT_PUBLIC_API_URL}/mail/sync/stream`;
const MAX_STREAM_FAILURES = 3;
const POLL_MS = 15000;

function startFallbackPolling(onChanged: Handler) {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      const { changed } = await mailApi.poll();
      if (changed) onChanged({ source: "poll" });
    } catch {
      // swallow — the next cycle self-corrects
    }
  }, POLL_MS);
}

function connect(onChanged: Handler) {
  if (stopped) return;
  try {
    source = new EventSource(STREAM_URL, { withCredentials: true });
  } catch {
    startFallbackPolling(onChanged);
    return;
  }

  source.addEventListener("open", () => {
    failures = 0;
  });

  source.addEventListener("change", (event) => {
    let info: ChangeEvent = { source: "stream" };
    try {
      const data = JSON.parse((event as MessageEvent).data);
      info = { source: data.source ?? "stream", inbox: data.inbox };
    } catch {
      /* keep the default */
    }
    onChanged(info);
  });

  // We fell past the server's replay buffer: refetch everything.
  source.addEventListener("resync", () => {
    onChanged({ source: "resync" });
  });

  source.addEventListener("error", () => {
    source?.close();
    source = null;
    if (stopped) return;
    failures += 1;
    if (failures >= MAX_STREAM_FAILURES) {
      startFallbackPolling(onChanged);
      return;
    }
    // Back off, then retry: 1s, 2s, 4s. EventSource resends Last-Event-ID.
    const delay = 1000 * 2 ** (failures - 1);
    reconnectTimer = setTimeout(() => connect(onChanged), delay);
  });
}

/** Begin realtime sync. `onChanged` fires when the mailbox changes. */
export function startRealtime(onChanged: Handler) {
  if (!stopped) return;
  stopped = false;
  failures = 0;

  if (typeof EventSource === "undefined") {
    startFallbackPolling(onChanged);
  } else {
    connect(onChanged);
  }

  // Coming back to the tab: check right away, and repair a stream the browser
  // suspended while the tab was hidden.
  onVisible = () => {
    if (stopped || document.visibilityState !== "visible") return;
    mailApi.wake().catch(() => {});
    if (!source && !pollTimer) {
      failures = 0;
      connect(onChanged);
    }
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
}

export function stopRealtime() {
  stopped = true;
  source?.close();
  source = null;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (onVisible) {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
    onVisible = null;
  }
}

/** Back-compat aliases used by earlier code. */
export const startPolling = startRealtime;
export const stopPolling = stopRealtime;
