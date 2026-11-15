import pkg from "../../package.json" with { type: "json" };

/** The hub's version (`apps/hub/package.json`), stamped on every trajectory record. */
export const HUB_VERSION: string = pkg.version;
