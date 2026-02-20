// cleanup.js
import fetch from "node-fetch";

/**
 * ENV VARS (from GitHub Actions)
 * - BOLDDESK_DOMAIN  (example: investorflow.bolddesk.com)  [NO https://]
 * - BOLDDESK_API_KEY
 * - DRY_RUN          ("true" or "false")
 * - DAYS             (14 for real retention, 0/1 for testing)
 * - MAX_DELETES      (safety cap)
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
 * LIST CLOSED TICKETS OLDER THAN X DAYS
 * (If this ever 404s, we’ll replace with exact Swagger endpoint)
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
 * LIST ATTACHMENTS FOR A TICKET
 */
async function listTicketAttachments(ticketId, page = 1, perPage = 50) {
  const path =
    `/tickets/${ticketId}/attachments` +
    `?Page=${page}&PerPage=${perPage}&OrderBy=createdOn%20desc`;

  return bdFetch(path);
}

/**
 * CONFIRMED WORKING DELETE ENDPOINT
 * DELETE /api/v1/{attachmentId}
 */
async function deleteAttachment(attachmentId) {
  return bdFetch(`/${attachmentId}`, {
    method: "DELETE",
    accept: "text/plain",
  });
}

async function run() {
  let processed = 0;

  console.log(
    `Starting cleanup: DAYS=${DAYS}, DRY_RUN=${DRY_RUN}, MAX_DELETES=${MAX_DELETES}`
  );

  let page = 1;
  const ticketsPerPage = 100;

  while (true) {
    const ticketResp = await listClosedTicketsOlderThan(DAYS, page, ticketsPerPage);
    const tickets = normalizeArray(ticketResp);

    if (tickets.length === 0) {
      console.log("No more tickets found.");
      break;
    }

    for (const t of tickets) {
      const ticketId = t.id ?? t.ticketId;
      if (!ticketId) continue;

      let ap = 1;
      const attachmentsPerPage = 50;

      while (true) {
        const attResp = await listTicketAttachments(ticketId, ap, attachmentsPerPage);
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
            await deleteAttachment(attachmentId);
            console.log(
              `Deleted attachment ${attachmentId} (${name}) from ticket ${ticketId}`
            );
          }

          processed += 1;

          if (processed >= MAX_DELETES) {
            console.log(`Reached MAX_DELETES (${MAX_DELETES}). Stopping.`);
            console.log(`Done. Processed deletions (or would-delete): ${processed}`);
            return;
          }
        }

        if (attachments.length < attachmentsPerPage) break;
        ap += 1;
      }
    }

    if (tickets.length < ticketsPerPage) break;
    page += 1;
  }

  console.log(`Done. Processed deletions (or would-delete): ${processed}`);
}

run().catch((e) => {
  console.error("Cleanup job failed:", e?.stack || e);
  process.exit(1);
});
