import { requirePageUser } from "@/lib/auth/guard";
import { PageHeader } from "@/components/app/page-header";
import { CampaignWizard } from "../wizard/campaign-wizard";
import { loadWizardData } from "../wizard/data";

export const metadata = { title: "New campaign" };

export default async function NewCampaignPage() {
  await requirePageUser("campaigns:write");
  const data = await loadWizardData();
  return (
    <div className="animate-in-fade">
      <PageHeader title="New campaign" description="Seven steps from audience to approval. Your progress is saved as a draft at every step." />
      <CampaignWizard {...data} />
    </div>
  );
}
