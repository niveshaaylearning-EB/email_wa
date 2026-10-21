import type { JobName } from "./index";

/** Single dispatch table for both the BullMQ worker and the inline driver. */
export async function runJob(name: JobName, data: unknown): Promise<void> {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (name) {
    case "campaign.execute": {
      const { executeCampaign } = await import("@/lib/services/execution");
      return executeCampaign(String(d.campaignId));
    }
    case "wa.send": {
      const { sendWhatsAppDelivery } = await import("@/lib/services/execution");
      return sendWhatsAppDelivery(String(d.deliveryId));
    }
    case "email.dispatch": {
      const { dispatchEmailGroup } = await import("@/lib/services/execution");
      return dispatchEmailGroup(String(d.campaignId), Number(d.groupIndex));
    }
    case "email.reconcile": {
      const { reconcileEmailGroup } = await import("@/lib/services/execution");
      return reconcileEmailGroup(String(d.campaignId), Number(d.groupIndex));
    }
    case "mock.simulate": {
      const { simulateWhatsAppLifecycle } = await import("@/lib/services/execution");
      return simulateWhatsAppLifecycle(String(d.deliveryId));
    }
    case "scheduler.tick": {
      const { schedulerTick } = await import("@/lib/services/execution");
      await schedulerTick();
      // Salesforce archive: due backup schedules + resume of interrupted backups. Isolated so
      // an archive problem can never block campaign scheduling.
      const { sfmcSchedulerTick } = await import("@/lib/services/salesforce/backups");
      await sfmcSchedulerTick().catch((err) => console.error("[scheduler] salesforce archive tick failed:", (err as Error).message));
      return;
    }
    case "sfmc.backup.step": {
      const { backupStep } = await import("@/lib/services/salesforce/backups");
      return backupStep(String(d.backupJobId));
    }
    case "sfmc.reconcile": {
      const { runReconciliation } = await import("@/lib/services/salesforce/reconciliation");
      return runReconciliation(String(d.reconciliationId));
    }
    case "webhook.retry": {
      const { retryWebhookEvent } = await import("@/lib/services/webhooks");
      return retryWebhookEvent(String(d.webhookEventId));
    }
    case "crm.sync": {
      const { runCrmSync } = await import("@/lib/services/crm-sync");
      await runCrmSync({ actor: null, type: d.scheduled ? "INCREMENTAL" : "MANUAL", full: !!d.full }).catch((err) => {
        if (!String(err.message).includes("already running")) throw err;
      });
      return;
    }
  }
}
