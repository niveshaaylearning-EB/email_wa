"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangleIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const forbidden = /permission/i.test(error.message);
  return (
    <div className="mx-auto flex max-w-md flex-col items-center py-20 text-center">
      <span className="mb-4 grid size-12 place-items-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangleIcon className="size-6" />
      </span>
      <h1 className="text-lg font-semibold">{forbidden ? "You don’t have access to this page" : "This page couldn’t be loaded"}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {forbidden ? "Ask an administrator to change your role if you need access." : "The error has been logged. Try again; if it persists, contact the platform administrator"}
        {error.digest && !forbidden ? ` (reference ${error.digest}).` : "."}
      </p>
      <div className="mt-6 flex gap-2">
        {!forbidden && (
          <Button onClick={reset}>
            <RotateCcwIcon /> Try again
          </Button>
        )}
        <Button asChild variant="outline">
          <Link href="/">Go to overview</Link>
        </Button>
      </div>
    </div>
  );
}
