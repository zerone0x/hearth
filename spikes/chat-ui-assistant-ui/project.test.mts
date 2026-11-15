// Node check of the pure path: Hearth log -> PiClientEvent -> reducer -> projection.
import { createPiThreadState, projectPiThreadMessages, reducePiThreadState } from "@assistant-ui/react-pi";
import { RECORDED_LOG } from "./src/events.ts";
import { toPiClientEvent } from "./src/hearthPiClient.ts";

let state = createPiThreadState("se_demo");
for (const e of RECORDED_LOG) {
  const m = toPiClientEvent("se_demo", e);
  if (m) state = reducePiThreadState(state, m);
}
const out = projectPiThreadMessages({
  messages: state.messages,
  toolExecutions: state.toolExecutions,
  runStatus: state.runStatus,
  hostUiRequests: [],
});
console.log(state.runStatus, state.lastSeq, state.messages.length);
console.log(JSON.stringify(out.map((m) => ({ role: m.role, content: m.content })), null, 1).slice(0, 2500));
