import SignupForm from '@/components/auth/SignupForm';

// Public route, reachable whether or not anyone is signed in — this is the
// front door for a brand-new client, not a page behind the app shell.
export default function SignupPage() {
  return <SignupForm />;
}
