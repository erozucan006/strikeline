// POST /api/close  { positionId, fraction (0–1], idempotencyKey }
// Closes or reduces an open position at live bid/ask; the browser does not set the value.
import { handler, closePosition } from "./_trade.js";
import { realDeps } from "./_deps.js";
export default handler(closePosition, () => realDeps());
