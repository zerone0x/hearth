/** What the desktop panel says when it is not streaming (kept apart from noVNC, which needs a DOM to load). */

import { Button } from "@/components/ui/button";

/** What the desktop panel shows when it is not streaming. */
export type DesktopPhase =
  | { readonly kind: "closed" }
  | { readonly kind: "connecting" }
  | { readonly kind: "open" }
  | { readonly kind: "asleep" }
  | { readonly kind: "ended"; readonly reason: string };

/** Close codes of the desktop WebSocket (decision 0016). */
export const DESKTOP_CLOSE_ASLEEP = 4410;

export function desktopPhaseFor(code: number, reason: string): DesktopPhase {
  if (code === DESKTOP_CLOSE_ASLEEP) return { kind: "asleep" };
  if (code === 4401) return { kind: "ended", reason: "Signed out. Sign in again to watch." };
  if (code === 4408) return { kind: "ended", reason: "The connection was too slow to keep up." };
  if (code === 1001) return { kind: "ended", reason: "The hub is shutting down." };
  return { kind: "ended", reason: reason || `The desktop closed (code ${code}).` };
}

export function DesktopStatus({ phase, onWake }: { phase: DesktopPhase; onWake: () => void }) {
  switch (phase.kind) {
    case "open":
      return null;
    case "connecting":
      return <p className="text-stone-300">Connecting to the desktop…</p>;
    case "asleep":
      return (
        <div className="flex flex-col items-center gap-2 text-center" data-testid="desktop-asleep">
          <p className="text-stone-100">Box asleep — send a message or click Wake to reconnect.</p>
          <Button variant="secondary" size="sm" onClick={onWake}>
            Wake
          </Button>
        </div>
      );
    case "ended":
      return (
        <div className="flex flex-col items-center gap-2 text-center">
          <p className="text-stone-100">{phase.reason}</p>
          <Button variant="secondary" size="sm" onClick={onWake}>
            Reconnect
          </Button>
        </div>
      );
    case "closed":
      return (
        <div className="flex flex-col items-center gap-2 text-center">
          <p className="text-stone-300">View-only. Opening the desktop starts the box.</p>
          <Button variant="secondary" size="sm" onClick={onWake}>
            Open desktop
          </Button>
        </div>
      );
  }
}
