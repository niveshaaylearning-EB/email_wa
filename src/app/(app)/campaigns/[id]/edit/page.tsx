import { notFound, redirect } from "next/navigation";
import { requirePageUser } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/app/page-header";
import { CampaignWizard } from "../../wizard/campaign-wizard";
import { loadWizardData } from "../../wizard/data";
import { utcToIstLocalInput } from "@/lib/time";
import { previewCampaignAudience } from "@/lib/services/campaigns";

export const metadata = { title: "Edit campaign" };

export default async function EditCampaignPage({ params }: PageProps<"/campaigns/[id]/edit">) {
  await requirePageUser("campaigns:write");
  const { id } = await params;
  const c = await prisma.campaign.findUnique({ where: { id }, include: { categories: { orderBy: { priority: "asc" } } } });
  if (!c || c.deletedAt) notFound();
  if (!["DRAFT", "REJECTED"].includes(c.status)) redirect(`/campaigns/${id}`);
  const [data, preview] = await Promise.all([loadWizardData(), previewCampaignAudience(id)]);
  return (
    <div className="animate-in-fade">
      <PageHeader title={c.name} eyebrow="Edit campaign" description={c.status === "REJECTED" ? `Rejected: ${c.rejectionReason ?? ""} — edits return it to draft.` : "Draft — changes are saved at every step."} />
      <CampaignWizard
        {...data}
        initialPreview={preview}
        initial={{
          id: c.id,
          version: c.version,
          status: c.status,
          name: c.name,
          description: c.description ?? "",
          purpose: c.purpose,
          channelMode: c.channelMode,
          overlapStrategy: c.overlapStrategy,
          scheduleType: c.scheduledAt ? "SCHEDULED" : "IMMEDIATE",
          scheduledAtLocal: c.scheduledAt ? utcToIstLocalInput(c.scheduledAt) : "",
          rateLimitPerMinute: c.rateLimitPerMinute,
          categories: c.categories.map((x) => ({ categoryId: x.categoryId, priority: x.priority, emailTemplateId: x.emailTemplateId, whatsappTemplateId: x.whatsappTemplateId })),
        }}
      />
    </div>
  );
}
