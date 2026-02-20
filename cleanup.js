// cleanup.js
import fetch from "node-fetch";

const DOMAIN = process.env.BOLDDESK_DOMAIN;
const API_KEY = process.env.BOLDDESK_API_KEY;

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const DAYS = Number.parseInt(process.env.DAYS || "14", 10);
const MAX_DELETES = Number.parseInt(process.env.MAX_DELETES || "200", 10);

if (!DOMAIN || !API_KEY) {
  throw new Error("Missing BOLDDESK_DOMAIN or BOLDDESK_API_KEY");
}

const BASE = `https://${DOMAIN}/api/v1`;

async function bdFetch(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
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
 * TODO: Replace this with your Swagger-confirmed tickets listing endpoint + filters.
 * This is a placeholder and may 404 until updated.
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
 * TODO: Confirm exact path in Swagger for Get Ticket Attachment.
 * Placeholder based on typical pattern.
 */
async function listTicketAttachments(ticketId, page = 1, perPage = 50) {
  const path =
    `/tickets/${ticketId}/attachments` +
    `?Page=${page}&PerPage=${perPage}&OrderBy=createdOn%20desc`;
  return bdFetch(path);
}

/**
 * TODO: Confirm exact path in Swagger for Delete Attachment.
 * Placeholder based on typical pattern.
 */
async function deleteAttachment(attachmentId) {
  const path = `/attachments/${attachmentId}`;
  return bdFetch(path, { method: "DELETE" });
}

async function run() {
  let deleted = 0;
  let page = 1;
  const perPageTickets = 100;

  console.log(
    `Starting cleanup: DAYS=${DAYS}, DRY_RUN=${DRY_RUN}, MAX_DELETES=${MAX_DELETES}`
  );

  while (true) {
    const ticketResp = await listClosedTicketsOlderThan(DAYS, page, perPageTickets);

    // Adjust these based on real API response shape once confirmed
    const tickets = ticketResp?.data ?? ticketResp?.result ?? ticketResp ?? [];

    if (!Array.isArray(tickets) || tickets.length === 0) {
      console.log("No more tickets found.");
      break;
    }

    for (const t of tickets) {
      const ticketId = t.id ?? t.ticketId;
      if (!ticketId) continue;

      let ap = 1;
      const perPageAttachments = 50;

      while (true) {
        const attResp = await listTicketAttachments(ticketId, ap, perPageAttachments);
        const attachments = attResp?.data ?? attResp?.result ?? attResp ?? [];

        if (!Array.isArray(attachments) || attachments.length === 0) break;

        for (const a of attachments) {
          const attachmentId = a.id ?? a.attachmentId;
          if (!attachmentId) continue;

          if (DRY_RUN) {
            console.log(
              `[DRY_RUN] Would delete attachment ${attachmentId} from ticket ${ticketId}`
            );
          } else {
            await deleteAttachment(attachmentId);
            console.log(`Deleted attachment ${attachmentId} from ticket ${ticketId}`);
          }

          deleted += 1;

          if (deleted >= MAX_DELETES) {
            console.log(`Reached MAX_DELETES (${MAX_DELETES}). Stopping.`);
            return;
          }
        }

        if (attachments.length < perPageAttachments) break;
        ap += 1;
      }
    }

    if (tickets.length < perPageTickets) break;
    page += 1;
  }

  console.log(`Done. Processed deletions (or would-delete): ${deleted}`);
}

run().catch((e) => {
  console.error("Cleanup job failed:", e?.stack || e);
  process.exit(1);
});
