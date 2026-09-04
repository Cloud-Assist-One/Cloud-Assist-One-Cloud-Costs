import { Button } from '@/components/ui/button';

// Renders in place of AppShell (see app/page.tsx) once a client company's
// trial has run out with no payment method on file -- not layered over it,
// so no gated tab or data endpoint ever reaches the browser.
export default function TrialExpired() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-6 text-center">
      <h1 className="text-3xl font-semibold">Your free trial has ended</h1>
      <p className="text-muted-foreground">
        Your cost data is safe and untouched. Add a payment method and everything
        comes straight back.
      </p>
      <Button asChild size="lg" className="mx-auto">
        <a href="/billing">Choose a plan</a>
      </Button>
    </main>
  );
}
