// POST /api/order  { underlying, name, legs:[{type,K,e,side,qty,limit}], idempotencyKey }
// Authorization: Bearer <Supabase session token>. Prices are set here, never by the browser.
import { handler, placeOrder } from "./_trade.js";
import { realDeps } from "./_deps.js";
export default handler(placeOrder, () => realDeps());
