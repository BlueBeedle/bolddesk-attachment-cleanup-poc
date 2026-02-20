// cleanup.js
import fetch from "node-fetch";

const DOMAIN = (process.env.BOLDDESK_DOMAIN || "").trim();
const API_KEY = (process.env.BOLDDESK_API_KEY || "").trim();

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const DAYS = Number.parseInt(process.env.DAYS || "14", 10);
const MAX_DELETES = Number.parseInt(process.env.MAX_DELETES || "200", 10);

if (!DOMAIN || !API_KEY) throw new Error("Missing BOLDDESK_DOMAIN or BOLDDESK_API_KEY");
if (DOMAIN.includes("http") || DOMAIN.includes("/") || DOMAIN.includes(" ")) {
  throw new Error(`BOLDDESK_DOMAIN must be host only (no https://, no slashes, no spaces). Received: "${DOMAIN}"`);
}

const BASE = `https://${DOMAIN}/api/v1`;

async function bdFetch(path, { method = "GET", body, accept = "application/json" } = {}) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "x-api-key": API_KEY,
      accept,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const ct = res.headers.get("content-type") || "";
  const payload = ct.includes("application/json")
    ? await res.json().catch(() => null)
    : await res.text().catch(() => "");

  if (!res.ok) {
    const msg = typeof payload === "string" ? payload : JSON.stringify(payload);
    throw new Error(`HTTP ${res.status} ${res.statusText} - ${msg}`);
  }
  return payload;
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function normalizeArray(resp) {
  const arr = resp?.data ?? resp?.result ?? resp;
  return Array.isArray(arr) ? arr : [];
}

/**
 * Placeholder list-tickets endpoint (works in your tenant as-is per your earlier test).
 * If this ever 404s, we’ll swap to the Swagger-confirmed route.
 */
async function listClosedTicketsOlderThan(days, page = 1, perPage = 100) {
  const cutoffIso = isoDaysAgo(days);
  const path =
    `/tickets?status=Closed&closedOnTo=${encodeURIComponent(cutoffIso)}&page=${page}&perPage=${perPage}`;
  return bdFetch(path);
}

/**
 * Ticket attachment list endpoint (confirmed working).
 */
async function listTicketAttachments(ticketId, page = 1, perPage = 50) {
  const path =
    `/tickets/${ticketId}/attachments?Page=${page}&PerPage=${perPage}&OrderBy=createdOn%20desc`;
  return bdFetch(path);
}

/**
 * Try multiple delete paths and return the first that works.
 * This keeps the POC moving even if Helpdesk gave an incomplete path.
 */
async function deleteAttachmentAuto(ticketId, attachmentId) {
  const candidates = [
    // What helpdesk (likely mistakenly) implied:
    `/${attachmentId}`,

    // Common patterns we tried earlier:
    `/attachments/${attachmentId}`,
    `/attachment/${attachmentId}`,
    `/tickets/attachments/${attachmentId}`,
    `/tickets/attachment/${attachmentId}`,
    `/tickets/${ticketId}/attachments/${attachmentId}`,

    // KB pattern helpdesk cited:
    `/kb/attachment/${attachmentId}`,

    // Activity pattern (needs activityId, which we don't have, but keep here for completeness if their API accepts it):
    // (Can't call without activityId; omitted)

    // Sometimes api uses "ticketattachments":
    `/ticketattachments/${attachmentId}`,
    `/ticket-attachments/${attachmentId}`,
  ];

  let last404 = null;

  for (const path of candidates) {
    try {
      // Delete endpoints often return text/plain
      await bdFetch(path, { method: "DELETE", accept: "text/plain" });
      return path; // return which route worked
    } catch (e) {
      const msg = String(e?.message || "");
      if (msg.includes("HTTP 404")) {
        last404 = e;
        continue;
      }
      // Any non-404 should be surfaced (401/403/500 etc.)
      throw e;
    }
  }

  throw last404 || new Error("All delete endpoint candidates failed");
}

async function run() {
  let processed = 0;

  console.log(`Starting cleanup: DAYS=${DAYS}, DRY_RUN=${DRY_RUN}, MAX_DELETES=${MAX_DELETES}`);

  let page = 1;
  const perPage = 100;

  while (true) {
    const ticketResp = await listClosedTicketsOlderThan(DAYS, page, perPage);
    const tickets = normalizeArray(ticketResp);

    if (tickets.length === 0) {
      console.log("No more tickets found.");
      break;
    }

    for (const t of tickets) {
      const ticketId = t.id ?? t.ticketId;
      if (!ticketId) continue;

      let ap = 1;
      const perPageAtt = 50;

      while (true) {
        const attResp = await listTicketAttachments(ticketId, ap, perPageAtt);
        const attachments = normalizeArray(attResp);
        if (attachments.length === 0) break;

        for (const a of attachments) {
          const attachmentId = a.id ?? a.attachmentId;
          const name = a.name ?? a.fileName ?? "(no name)";
          if (!attachmentId) continue;

          if (DRY_RUN) {
            console.log(`[DRY_RUN] Would delete attachment ${attachmentId} (${name}) from ticket ${ticketId}`);
          } else {
            const route = await deleteAttachmentAuto(ticketId, attachmentId);
            console.log(`Deleted attachment ${attachmentId} (${name}) from ticket ${ticketId} using DELETE ${route}`);
          }

          processed += 1;
          if (processed >= MAX_DELETES) {
            console.log(`Reached MAX_DELETES (${MAX_DELETES}). Stopping.`);
            console.log(`Done. Processed deletions (or would-delete): ${processed}`);
            return;
          }
        }

        if (attachments.length < perPageAtt) break;
        ap += 1;
      }
    }

    if (tickets.length < perPage) break;
    page += 1;
  }

  console.log(`Done. Processed deletions (or would-delete): ${processed}`);
}

run().catch((e) => {
  console.error("Cleanup job failed:", e?.stack || e);
  process.exit(1);
});
