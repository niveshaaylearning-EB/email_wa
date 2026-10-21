"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2Icon, LockIcon } from "lucide-react";
import { LoginSchema } from "@/lib/contracts";
import { api, errorMessage } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import type { z } from "zod";

export function LoginForm({ next }: { next: string }) {
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof LoginSchema>>({ resolver: zodResolver(LoginSchema), defaultValues: { email: "", password: "" } });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api("/api/auth/login", { body: values });
      window.location.assign(next);
    } catch (e) {
      setError(errorMessage(e));
    }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      <FieldGroup>
        <Field data-invalid={!!form.formState.errors.email}>
          <FieldLabel htmlFor="email">Work email</FieldLabel>
          <Input id="email" type="email" autoComplete="username" placeholder="you@niveshaay.com" className="h-10" {...form.register("email")} />
          <FieldError errors={[form.formState.errors.email]} />
        </Field>
        <Field data-invalid={!!form.formState.errors.password}>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input id="password" type="password" autoComplete="current-password" className="h-10" {...form.register("password")} />
          <FieldError errors={[form.formState.errors.password]} />
        </Field>
      </FieldGroup>
      {error && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" className="h-10 w-full" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? <Loader2Icon className="animate-spin" /> : <LockIcon />}
        Sign in
      </Button>
    </form>
  );
}
