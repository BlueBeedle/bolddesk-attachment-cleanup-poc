// cleanup.js
import fetch from "node-fetch";

/**
 * ENV VARS (from GitHub Actions secrets / workflow env)
 * - BOLDDESK_DOMAIN (example: investorflow.bolddesk.com)   [NO https://]
 * - BOLDDESK_API_KEY
 * - DRY_RUN (true/false)
 * - DAYS (number of days; 14 for real policy, 0/1 for POC testing)
 * - MAX_DELETES (safety cap)
 */

const DOMAIN = (process.env.BOLDDESK_DOMAIN || "").trim();
const API_KEY = (process.env.BOLDDESK_API_KEY || "").trim();

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const DAYS = Number.parseInt(process.env.DAYS || "14", 10);
const MAX_DELETES = Number.parseInt(process.env.MAX_DELETES || "200", 10);

if (!DOMAIN || !API_KEY) {
  throw new Error("Missing BOLDDESK_DOMAIN or BOLDDESK_API_KEY");
}

if (DOMAIN.includes("http") || DOMAIN.includes("/") || DOMAIN.includes(" ")) {
  throw new Error(
    `BOLDDESK_DOMAIN must be host only (no https://, no slashes, no spaces). Received: "${DOMAIN}"`
  );
}

const BASE = `https://${DOMAIN}/api/v1`;

async function bdFetch(path, { method = "GET", body } = {}) {
  const url = `${BASE}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      "x-api-key": API_KEY,
      accept: "application/json",
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

/**
 * IMPORTANT:
 * This ticket listing endpoint is still a "best guess" placeholder.
 * If you get a 404 here, we must replace this with the exact Swagger path + query params.
 */
async function listClosedTicketsOlderThan(days, page = 1, perPage = 100) {
  const cutoffIso = isoDaysAgo(days);

  // Placeholder query parameters:
  // - status=Closed
  // - closedOnTo=<ISO> (meaning closed date <= ISO)
  // - page/perPage
  const path =
    `/tickets?status=Closed` +
    `&closedOnTo=${encodeURIComponent(cutoffIso)}` +
    `&page=${page}&perPage=${perPage}`;

  return bdFetch(path);
}

/**
 * Get Ticket Attachment (you mentioned these params)
 * NOTE: If your Swagger uses different query param names, we’ll update.
 */
async function listTicketAttachments(ticketId, page = 1, perPage = 50) {
  const path =
    `/tickets/${ticketId}/attachments` +
    `?Page=${page}&PerPage=${perPage}&OrderBy=createdOn%20desc`;

  return bdFetch(path);
}

/**
 * Delete Attachment:
 * Some tenants expose different routes. We try multiple candidates.
 */
async function deleteAttachment(ticketId, attachmentId) {
  const candidates = [
    `/attachments/${attachmentId}`,
    `/tickets/attachments/${attachmentId}`,
    `/tickets/${ticketId}/attachments/${attachmentId}`,
  ];

  let last404 = null;

  for (const path of candidates) {
    try {
      return await bdFetch(path, { method: "DELETE" });
    } catch (e) {
      const msg = String(e?.message || "");
      // Only fallback on 404; for 401/403/etc we should stop immediately.
      if (msg.includes("HTTP 404")) {
        last404 = e;
        continue;
      }
      throw e;
    }
  }

  throw last404 || new Error("Delete failed for all candidate paths");
}

function normalizeArray(resp) {
  // Try common response shapes: {data:[]}, {result:[]}, or raw []
  const arr = resp?.data ?? resp?.result ?? resp;
  return Array.isArray(arr) ? arr : [];
}

async function run() {
  let deletedCount = 0;
  let ticketPage = 1;
  const ticketsPerPage = 100;

  console.log(
    `Starting cleanup: DAYS=${DAYS}, DRY_RUN=${DRY_RUN}, MAX_DELETES=${MAX_DELETES}`
  );

  while (true) {
    const ticketResp = await listClosedTicketsOlderThan(DAYS, ticketPage, ticketsPerPage);
    const tickets = normalizeArray(ticketResp);

    if (tickets.length === 0) {
      console.log("No more tickets found.");
      break;
    }

    for (const t of tickets) {
      const ticketId = t.id ?? t.ticketId;
      if (!ticketId) continue;

      let attachmentPage = 1;
      const attachmentsPerPage = 50;

      while (true) {
        const attResp = await listTicketAttachments(ticketId, attachmentPage, attachmentsPerPage);
        const attachments = normalizeArray(attResp);

        if (attachments.length === 0) break;

        for (const a of attachments) {
          const attachmentId = a.id ?? a.attachmentId;
          const name = a.name ?? a.fileName ?? "(no name)";

          if (!attachmentId) continue;

          if (DRY_RUN) {
            console.log(
              `[DRY_RUN] Would delete attachment ${attachmentId} (${name}) from ticket ${ticketId}`
            );
          } else {
            await deleteAttachment(ticketId, attachmentId);
            console.log(
              `Deleted attachment ${attachmentId} (${name}) from ticket ${ticketId}`
            );
          }

          deletedCount += 1;

          if (deletedCount >= MAX_DELETES) {
            console.log(`Reached MAX_DELETES (${MAX_DELETES}). Stopping.`);
            console.log(`Done. Processed deletions (or would-delete): ${deletedCount}`);
            return;
          }
        }

        if (attachments.length < attachmentsPerPage) break;
        attachmentPage += 1;
      }
    }

    if (tickets.length < ticketsPerPage) break;
    ticketPage += 1;
  }

  console.log(`Done. Processed deletions (or would-delete): ${deletedCount}`);
}

run().catch((e) => {
  console.error("Cleanup job failed:", e?.stack || e);
  process.exit(1);
});
