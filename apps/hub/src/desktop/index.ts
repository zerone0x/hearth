/** The desktop stream and its lock: browser ↔ hub ↔ box VNC (PRD §8.2, §8.3, §11.1 item 4, §11.2; decisions 0016, 0033). */

export {
  closeReason,
  DESKTOP_CLOSE,
  DesktopBridge,
  type DesktopBridgeOptions,
  HOLD_POLL_MS,
  MAX_VIEWERS_PER_SESSION,
  REAUTH_INTERVAL_MS,
  TO_BOX_LIMIT_BYTES,
  VIEWER_HIGH_WATER_BYTES,
  VIEWER_LIMIT_BYTES,
  Viewer,
  type ViewerSocket,
  type ViewerTicket,
} from "./bridge";
export {
  DESKTOP_LOCK_EVENT,
  DESKTOP_LOCK_TTL_MS,
  type DesktopLockCheck,
  type DesktopLockEnd,
  type DesktopLockHolder,
  type DesktopLockHolderKind,
  DesktopLocks,
  type DesktopLocksOptions,
  type DesktopLockView,
  USER_IN_CONTROL,
} from "./lock";
export {
  MAX_CUT_TEXT_BYTES,
  MAX_ENCODINGS,
  RFB_CLIENT,
  RfbViolation,
  STRIPPED_ENCODINGS,
  RfbInputFilter,
} from "./rfb";
export {
  DESKTOP_LOCK_PATH,
  DESKTOP_PATH,
  DESKTOP_RELEASE_PATH,
  type DesktopSocketData,
  mountDesktopLockRoutes,
  mountDesktopRoute,
  type Upgrader,
} from "./routes";
