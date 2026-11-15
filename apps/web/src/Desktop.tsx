/**
 * View-only noVNC panel on the session's desktop WebSocket (decision 0016).
 * The page opens the socket itself so it sees the close code: 4410 means the
 * box went to sleep (watching does not keep it awake, #45), and the panel
 * says so instead of a blank canvas. Opening or waking the desktop starts the
 * box, so it is never done without a click.
 */

import RFB from "@novnc/novnc";
import { useCallback, useEffect, useRef, useState } from "react";
import { desktopUrl } from "./api";
import { type DesktopPhase, DesktopStatus, desktopPhaseFor } from "./DesktopStatus";

export function DesktopPanel({ sessionId }: { sessionId: string }) {
  const screen = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | undefined>(undefined);
  const [phase, setPhase] = useState<DesktopPhase>({ kind: "closed" });

  const disconnect = useCallback(() => {
    const current = rfb.current;
    rfb.current = undefined;
    try {
      current?.disconnect();
    } catch {
      // Already closed.
    }
  }, []);

  const connect = useCallback(() => {
    const target = screen.current;
    if (target === null) return;
    disconnect();
    setPhase({ kind: "connecting" });
    const ws = new WebSocket(desktopUrl(sessionId, window.location));
    ws.addEventListener("close", (event) => {
      setPhase(desktopPhaseFor(event.code, event.reason));
    });
    // noVNC 1.7 takes an open or connecting WebSocket as its channel.
    const client = new RFB(target, ws as unknown as string, { shared: true });
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
          <DesktopStatus phase={phase} onWake={connect} />
        </div>
      )}
    </section>
  );
}
