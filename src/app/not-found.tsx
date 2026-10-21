import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="mt-2 text-xl font-semibold">Not found</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">The record may have been archived, or the link is incorrect.</p>
      <Button asChild className="mt-6">
        <Link href="/">Back to overview</Link>
      </Button>
    </main>
  );
}
