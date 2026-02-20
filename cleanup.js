// cleanup.js
import fetch from "node-fetch";

/**
 * ENV VARS
 * - BOLDDESK_DOMAIN (example: investorflow.bolddesk.com)   [NO https://]
 * - BOLDDESK_API_KEY
 * - DRY_RUN (true/false)
 * - DAYS (14 for real, 0/1 for testing)
 * - MAX_DELETES (safety cap)
 */

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
 * IMPORTANT:
 * This ticket listing endpoint is still a placeholder.
 * If this 404s, we must replace it with the exact Swagger "list tickets" path + params.
 */
async function listClosedTicketsOlderThan(days, page = 1, perPage = 100) {
  const cutoffIso = isoDaysAgo(days);
  const path =
    `/tickets?status=Closed` +
    `&closedOnTo=${encodeURIComponent(cutoffIso)}` +
    `&page=${page}&perPage=${perPage}`;
  return bdFetch(path);
}

/**
 * Your "Get Ticket Attachment" endpoint (seems valid in your tenant).
 * We expect each attachment item to include:
 * - id (attachmentId)
 * - AND an activity identifier (activityId OR updateId)
 */
async function listTicketAttachments(ticketId, page = 1, perPage = 50) {
  const path =
    `/tickets/${ticketId}/attachments` +
    `?Page=${page}&PerPage=${perPage}&OrderBy=createdOn%20desc`;
  return bdFetch(path);
}

/**
 * CORRECT DELETE based on your dev guide:
 * DELETE /activities/{activityId}/attachments/{attachmentId}
 *
 * Dev guide curl uses:
 *  -H "accept: text/plain"
 */
async function deleteActivityAttachment(activityId, attachmentId) {
  const path = `/activities/${activityId}/attachments/${attachmentId}`;
  return bdFetch(path, { method: "DELETE", accept: "text/plain" });
}

function getActivityIdFromAttachment(a) {
  // BoldDesk docs mention "OrderBy updateId" as a sort option for ticket attachments.
  // In some responses, updateId is effectively the activity id you need.
  return a.activityId ?? a.updateId ?? a.activityID ?? a.updateID ?? null;
}

async function run() {
  let deletedCount = 0;
  let ticketPage = 1;
  const ticketsPerPage = 100;

  console.log(`Starting cleanup: DAYS=${DAYS}, DRY_RUN=${DRY_RUN}, MAX_DELETES=${MAX_DELETES}`);

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
          const activityId = getActivityIdFromAttachment(a);

          if (!attachmentId) continue;

          if (!activityId) {
            console.log(
              `[SKIP] Ticket ${ticketId} attachment ${attachmentId} (${name}) missing activityId/updateId; cannot delete via activities endpoint.`
            );
            continue;
          }

          if (DRY_RUN) {
            console.log(
              `[DRY_RUN] Would delete activity attachment ${attachmentId} (${name}) from ticket ${ticketId} (activityId=${activityId})`
            );
          } else {
            await deleteActivityAttachment(activityId, attachmentId);
            console.log(
              `Deleted activity attachment ${attachmentId} (${name}) from ticket ${ticketId} (activityId=${activityId})`
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
