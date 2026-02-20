# BoldDesk Attachment Retention Cleanup (POC)

This repository contains a zero-infrastructure proof of concept (POC) for automatically deleting attachments from Closed tickets in BoldDesk after a configurable number of days. It runs entirely using GitHub Actions and does not require any servers or additional paid infrastructure.

This workflow finds tickets where the status is Closed and the closed date is older than a configurable number of days, lists attachments for those tickets, and deletes those attachments using the confirmed working BoldDesk endpoint:

DELETE /api/v1/{attachmentId}

The repository can safely be public because no API keys are stored in the code. All credentials are stored securely as GitHub Actions Secrets. Secrets are encrypted, masked in logs, and are not shared with forks or pull requests.

To use this with your own BoldDesk tenant, first fork this repository into your own GitHub account. After forking, go to Repository → Settings → Secrets and variables → Actions and create the following repository secrets:

BOLDDESK_DOMAIN = yourtenant.bolddesk.com  
BOLDDESK_API_KEY = your BoldDesk API key  

Important: BOLDDESK_DOMAIN must be the host only. Do not include https:// and do not include trailing slashes.

Next, open the file .github/workflows/cleanup.yml and configure the environment variables:

BOLDDESK_DOMAIN: ${{ secrets.BOLDDESK_DOMAIN }}  
BOLDDESK_API_KEY: ${{ secrets.BOLDDESK_API_KEY }}  
DRY_RUN: "true"  
DAYS: "14"  
MAX_DELETES: "200"  

DRY_RUN controls whether attachments are actually deleted. When DRY_RUN is set to "true", the workflow will only log what would be deleted. No attachments are removed. DAYS controls the retention window. The script deletes attachments from tickets where closedOn <= (today minus DAYS). For example, if DAYS is 14, attachments on tickets closed at least 14 days ago will be deleted. MAX_DELETES is a safety cap that limits how many attachments can be processed in a single run.

For first-time setup, it is strongly recommended to use:

DRY_RUN: "true"  
DAYS: "0"  
MAX_DELETES: "10"  

Then manually run the workflow from the Actions tab and review the logs. You should see lines similar to:

[DRY_RUN] Would delete attachment 123 (file.pdf) from ticket 456

Once you confirm the correct tickets and attachments are being selected, change DRY_RUN to "false" to enable real deletion. It is recommended to keep MAX_DELETES low during initial live runs.

The workflow runs on a schedule defined in cleanup.yml using cron syntax. The default example runs daily at 6 AM UTC. You can adjust this schedule as needed.

The retention logic deletes attachments only from tickets with status equal to Closed and where the closed date is less than or equal to the calculated cutoff date. Open, Pending, or other non-Closed tickets are not targeted.

If your BoldDesk tenant uses different status values (for example, Resolved instead of Closed), you may need to adjust the ticket filter in the script to match your environment. You can review available API filters in your tenant’s Swagger documentation at:

https://yourtenant.bolddesk.com/api/help/index.html

This project demonstrates secure secret handling, zero-cost scheduled automation, configurable retention enforcement, and a confirmed working attachment delete endpoint for BoldDesk.

Always test with DRY_RUN enabled before enabling deletion in production.
