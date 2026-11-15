import { describeBoxAgent } from "./agent";

// Stub entry point. Dialing the hub arrives with the hub-box connection issue.
const info = describeBoxAgent();
console.log(`hearth box-agent (protocol ${info.protocol}, pi ${info.pi}): no hub connection yet`);
