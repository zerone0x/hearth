/**
 * View-only noVNC panel on the session's desktop WebSocket (decision 0016).
 * The page opens the socket itself so it sees the close code: 4410 means the
 * box went to sleep (watching does not keep it awake, #45), and the panel
 * says so instead of a blank canvas. Opening or waking the desktop starts the
 * box, so it is never done without a click.
 *
 * noVNC is its own chunk, loaded on the first connect (#84): the session
 * page does not download it until the user opens the desktop.
 */

import type RFB from "@novnc/novnc";
import { useCallback, useEffect, useRef, useState } from "react";
import { desktopUrl } from "./api";
import { type DesktopPhase, DesktopStatus, desktopPhaseFor } from "./DesktopStatus";

/** Loads noVNC's `RFB` client (a separate chunk). Replaceable in tests. */
export const loadNoVnc = {
  load: async (): Promise<typeof RFB> => (await import("@novnc/novnc")).default,
};

export function DesktopPanel({ sessionId }: { sessionId: string }) {
  const screen = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | undefined>(undefined);
  /** Bumped by every connect and disconnect, so a connect still loading noVNC knows it is stale. */
  const attempt = useRef(0);
  const [phase, setPhase] = useState<DesktopPhase>({ kind: "closed" });

  const disconnect = useCallback(() => {
    attempt.current += 1;
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
    const mine = attempt.current;
    setPhase({ kind: "connecting" });
    let Client: typeof RFB;
    try {
      Client = await loadNoVnc.load();
    } catch {
      if (attempt.current === mine) {
        setPhase({ kind: "ended", reason: "The desktop viewer did not load." });
      }
      return;
    }
    const target = screen.current;
    if (attempt.current !== mine || target === null) return;
    const ws = new WebSocket(desktopUrl(sessionId, window.location));
    ws.addEventListener("close", (event) => {
      setPhase(desktopPhaseFor(event.code, event.reason));
    });
    // noVNC 1.7 takes an open or connecting WebSocket as its channel.
    const client = new Client(target, ws as unknown as string, { shared: true });
    client.viewOnly = true;
    client.scaleViewport = true;
    client.resizeSession = false;
    client.addEventListener("connect", () => setPhase({ kind: "open" }));
    rfb.current = client;
  }, [disconnect, sessionId]);

  useEffect(() => disconnect, [disconnect]);

  return (
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
  );
}
