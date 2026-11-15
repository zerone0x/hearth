/** The desktop stream: browser ↔ hub ↔ box VNC (PRD §8.2, §8.3, §11.1 item 4; decision 0016). */

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
  MAX_CUT_TEXT_BYTES,
  MAX_ENCODINGS,
  RFB_CLIENT,
  RfbViolation,
  STRIPPED_ENCODINGS,
  ViewOnlyFilter,
} from "./rfb";
