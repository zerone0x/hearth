/** A form's or page's error as an alert (`role="alert"`), or nothing. */

import { Alert, AlertDescription } from "@/components/ui/alert";

function errorText(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
  return error instanceof Error ? error.message : String(error);
}

export function ErrorAlert({ error }: { error: unknown }) {
  const text = errorText(error);
  if (text === undefined) return null;
  return (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}
