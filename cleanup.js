// cleanup.js
import fetch from "node-fetch";

const DOMAIN = process.env.BOLDDESK_DOMAIN;
const API_KEY = process.env.BOLDDESK_API_KEY;

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const DAYS = parseInt(process.env.DAYS || "14", 10);
const MAX_DELETES = parseInt(process.env.MAX_DELETES || "200", 10);

if (!DOMAIN || !API_KEY) throw new Error("Missing BOLDDESK_DOMAIN or BOLDDESK_API_KEY");

const BASE = `https://${DOMAIN}/api/v1`;

async function bdFetch(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "x-api-key": API_KEY,
      "accept": "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const ct = res.headers.get("content-type") || "";
  const payload = ct.includes("application/json") ? await res.json().catch(() => null) : await res.text().catch(() => "");

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

// TODO: Replace this with your Swagger-confirmed tickets query endpoint/params
async function listClosedTicketsOlderThan(days, page = 1, perPage = 100) {
  const cutoffIso = isoDaysAgo(days);
  return bdFetch(`/tickets?status=Closed&closedOnTo=${encodeURIComponent(cutoffIso)}&page=${page}&perPage=${perPage}`);
}

// TODO: Confirm exact attachment endpoints in Swagger
async function listTicketAttachments(ticketId, page = 1, perPage = 50) {
  return bdFetch(`/tickets/${ticketId}/attachments?Page=${page}&PerPage=${perPage}&OrderBy=createdOn%20desc`);
}

async function deleteAttachment(attachmentId) {
  return bdFetch(`/attachments/${attachmentId}`, { method: "DELETE" });
}

async function run() {
  let deleted = 0;
  let page = 1;

  while (true) {
    const ticketResp = await listClosedTicketsOlderThan(DAYS, page, 100);
    const tickets = ticketResp?.data ?? ticketResp?.result ?? ticketResp ?? [];
    if (!Array.isArray(tickets) || tickets.length === 0) break;

    for (const t of tickets) {
      const ticketId = t.id ?? t.ticketId;
      if (!ticketId) continue;

      let ap = 1;
      while (true) {
        const attResp = await listTicketAttachments(ticketId, ap, 50);
        const atts = attResp?.data ?? attResp?.result ?? attResp ?? [];
        if (!Array.isArray(atts) || atts.length === 0) break;

        for (const a of atts) {
          const attachmentId = a.id ?? a.attachmentId;
          if (!attachmentId) continue;

          if (DRY_RUN) {
            console.log(`[DRY_RUN] Would delete attachment ${attachmentId} from ticket ${ticketId}`);
          } else {
            await deleteAttachment(attachmentId);
            console.log(`Deleted attachment ${attachmentId} from ticket ${ticketId}`);
          }

          deleted += 1;
          if (deleted >= MAX_DELETES) {
            console.log(`Reached MAX
