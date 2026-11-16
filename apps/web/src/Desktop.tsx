/**
 * noVNC panel on the session's desktop WebSocket (decisions 0016, 0033). It is
 * view-only until the user clicks Take over: that takes the session's desktop
 * lock, and while the user holds it noVNC sends their keyboard and mouse and
 * the hub passes them to the box. Release hands control back; so does
 * closing the tab (the hub releases the lock when the holder's last viewer
 * closes) and leaving the desktop untouched until the lease lapses.
 * The page opens the socket itself so it sees the close code: 4410 means the
 * box went to sleep (watching does not keep it awake, #45), and the panel
 * says so instead of a blank canvas. Opening or waking the desktop starts the
 * box, so it is never done without a click.
 *
 * noVNC is its own chunk, loaded on the first connect (#84): the session
 * page does not download it until the user opens the desktop.
 */

import type RFB from "@novnc/novnc";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, type DesktopLock, desktopUrl } from "./api";
import { type DesktopPhase, DesktopStatus, desktopPhaseFor } from "./DesktopStatus";
import { ErrorAlert } from "./ErrorAlert";
import { keys, POLL_DESKTOP_LOCK_MS } from "./queries";

/** Loads noVNC's `RFB` client (a separate chunk). Replaceable in tests. */
export const loadNoVnc = {
  load: async (): Promise<typeof RFB> => (await import("@novnc/novnc")).default,
};

export function DesktopPanel({ sessionId }: { sessionId: string }) {
  const screen = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | undefined>(undefined);
  const [phase, setPhase] = useState<DesktopPhase>({ kind: "closed" });
  // Whether this user holds the lock: noVNC sends input only then.
  const inControl = useRef(false);
  const setControl = useCallback((mine: boolean) => {
    inControl.current = mine;
    const client = rfb.current;
    if (client === undefined) return;
    client.viewOnly = !mine;
    if (mine) client.focus();
  }, []);

  const disconnect = useCallback(() => {
    const current = rfb.current;
    rfb.current = undefined;
    try {
      current?.disconnect();
    } catch {
      // Already closed.
    }
  }, []);

  const connect = useCallback(async () => {
    if (screen.current === null) return;
    disconnect();
    setPhase({ kind: "connecting" });
    let Client: typeof RFB;
    try {
      Client = await loadNoVnc.load();
    } catch {
      setPhase({ kind: "ended", reason: "The desktop viewer did not load." });
      return;
    }
    // React clears the ref on unmount: a panel gone while noVNC loaded opens nothing.
    const target = screen.current;
    if (target === null) return;
    const ws = new WebSocket(desktopUrl(sessionId, window.location));
    ws.addEventListener("close", (event) => {
      setPhase(desktopPhaseFor(event.code, event.reason));
    });
    // noVNC 1.7 takes an open or connecting WebSocket as its channel.
    const client = new Client(target, ws as unknown as string, { shared: true });
    client.viewOnly = !inControl.current;
    client.scaleViewport = true;
    client.resizeSession = false;
    client.addEventListener("connect", () => setPhase({ kind: "open" }));
    rfb.current = client;
  }, [disconnect, sessionId]);

  useEffect(() => disconnect, [disconnect]);

  return (
    <div className="flex min-h-56 flex-1 flex-col gap-2">
      {phase.kind === "open" ? (
        <DesktopControl sessionId={sessionId} onControl={setControl} />
      ) : null}
      <section
        className="relative flex min-h-56 flex-1 flex-col overflow-hidden rounded-md bg-stone-900"
        aria-label="Desktop"
        data-testid="desktop"
        data-phase={phase.kind}
      >
        <div ref={screen} className="min-h-56 flex-1" />
        {phase.kind === "open" ? null : (
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <DesktopStatus phase={phase} onWake={() => void connect()} />
          </div>
        )}
      </section>
    </div>
  );
}

/** What the control bar says about the lock. */
export function lockLabel(lock: DesktopLock | undefined): string {
  if (lock === undefined) return "Checking control…";
  if (lock.mine) return "You are in control.";
  if (lock.held) return "Someone else is in control.";
  return "View-only.";
}

/**
 * Take over and Release, over the open desktop. It re-reads the lock every
 * few seconds, because the lease lapses when the user leaves the desktop
 * untouched, and reports whether the user holds it through `onControl`.
 */
export function DesktopControl({
  sessionId,
  onControl,
}: {
  sessionId: string;
  onControl: (mine: boolean) => void;
}) {
  const client = useQueryClient();
  const lock = useQuery({
    queryKey: keys.desktopLock(sessionId),
    queryFn: () => api.desktopLock(sessionId),
    refetchInterval: POLL_DESKTOP_LOCK_MS,
  });
  const update = (next: DesktopLock) => client.setQueryData(keys.desktopLock(sessionId), next);
  const takeOver = useMutation({ mutationFn: () => api.takeOver(sessionId), onSuccess: update });
  const release = useMutation({
    mutationFn: () => api.releaseDesktop(sessionId),
    onSuccess: update,
  });
  const mine = lock.data?.mine === true;
  useEffect(() => onControl(mine), [mine, onControl]);
  // Leaving the panel gives up control here; the hub also releases the lock
  // when this viewer's socket closes.
  useEffect(() => () => onControl(false), [onControl]);

  const busy = takeOver.isPending || release.isPending;
  return (
    <div className="flex flex-col gap-2" data-testid="desktop-control" data-mine={mine}>
      <div className="flex items-center gap-2">
        <Badge variant={mine ? "default" : "secondary"}>{mine ? "In control" : "Watching"}</Badge>
        <p className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
          {lockLabel(lock.data)}
        </p>
        {mine ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => release.mutate()}>
            Release
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy || lock.data === undefined || lock.data.held}
            onClick={() => takeOver.mutate()}
          >
            Take over
          </Button>
        )}
      </div>
      <ErrorAlert error={takeOver.error ?? release.error} />
    </div>
  );
}
