// GET /api/admin — the platform's revenue and open exposure. Signed-in users whose e-mail is in
// ADMIN_EMAILS only; everyone else gets 403.
import { handler, adminSummary } from "./_trade.js";
import { realDeps } from "./_deps.js";
export default handler(adminSummary, () => realDeps(), "GET");
