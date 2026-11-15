// @types/novnc__novnc 1.6.0 types `@novnc/novnc/lib/rfb`; 1.7.0 exports RFB
// from the package root (docs/spikes/pi-runner.md, toolchain check).
declare module "@novnc/novnc" {
  import RFB from "@novnc/novnc/lib/rfb";
  export default RFB;
}
