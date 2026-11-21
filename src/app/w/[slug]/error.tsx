"use client";

import { RotateCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function WorkspaceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto w-full max-w-xl p-8">
      <Alert
        tone="danger"
        title="We couldn't load this page"
        actions={
          <Button size="sm" variant="secondary" onClick={reset}>
            <RotateCw className="size-3.5" aria-hidden /> Try again
          </Button>
        }
      >
        Something went wrong on our side. Your mail is safe.
        {error.digest ? <span className="mt-1 block font-mono text-xs opacity-70">Ref: {error.digest}</span> : null}
      </Alert>
    </div>
  );
}
