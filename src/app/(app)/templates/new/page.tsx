import { requirePageUser } from "@/lib/auth/guard";
import { PageHeader } from "@/components/app/page-header";
import { TemplateEditor } from "../template-editor";

export const metadata = { title: "New template" };

export default async function NewTemplatePage({ searchParams }: PageProps<"/templates/new">) {
  await requirePageUser("templates:write");
  const sp = await searchParams;
  return (
    <div className="animate-in-fade">
      <PageHeader title="New template" description="Register an approved WhatsApp template or author email content." />
      <TemplateEditor initialChannel={sp.channel === "EMAIL" ? "EMAIL" : "WHATSAPP"} />
    </div>
  );
}
