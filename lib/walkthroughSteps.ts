// The trial walkthrough's content, lifted verbatim from the walkthrough Mark
// authored. Kept as data rather than markup so the copy can be reworded without
// touching the component or its tests.

export interface WalkthroughStep {
  title: string;
  body: string;
  /** Screenshot under public/walkthrough, shown at the top of the step. */
  image: string;
}

export const WALKTHROUGH_STEPS: WalkthroughStep[] = [
  {
    title: "Three ways to get your billing in",
    body: "Cloud Assist One can take your cloud billing by CSV upload, by read-only key, or from an automated daily export.",
    image: "/walkthrough/step-1.png",
  },
  {
    title: "Upload raw CSV billing reports",
    body: "Drop the billing exports you already download into Uploaded Files — no cloud access needed.",
    image: "/walkthrough/step-2.png",
  },
  {
    title: "Connect with a billing key",
    body: "In Settings, connect using a key and secret that has billing rights from your cloud provider.",
    image: "/walkthrough/step-3.png",
  },
  {
    title: "Automate a daily export",
    body: "Build an automated daily export in your provider and we pick it up with the click of a button.",
    image: "/walkthrough/step-4.png",
  },
  {
    title: "Reports on total cloud spend",
    body: "Once your billing data is in, we build easy-to-read reports of spend by day and by service.",
    image: "/walkthrough/step-5.png",
  },
  {
    title: "A tab per cloud provider",
    body: "AWS, Azure, Google Cloud and Snowflake each get their own tab, so all your billing lives in one portal.",
    image: "/walkthrough/step-6.png",
  },
  {
    title: "Line Items: search, sort, ask AI",
    body: "Sort by any column, search keywords, or ask AI for specific items — then export or print the result.",
    image: "/walkthrough/step-7.png",
  },
  {
    title: "Compare providers side by side",
    body: "The Compare tab totals every provider in one window, broken out by resource category.",
    image: "/walkthrough/step-8.png",
  },
  {
    title: "Live resource inventory",
    body: "See running resources color-coded by when they launched, and verify any one with your cloud administrator.",
    image: "/walkthrough/step-9.png",
  },
  {
    title: "Verify IAM users",
    body: "Check which IAM users are new in the last 24 hours, week or month, and confirm they are legitimate.",
    image: "/walkthrough/step-10.png",
  },
  {
    title: "Security checks",
    body: "Automated checks flag public buckets, stale access keys and more — for every provider in one place.",
    image: "/walkthrough/step-11.png",
  },
  {
    title: "Stop cost leakage",
    body: "Find unattached volumes, idle IPs and stopped instances still billing you, and act on them.",
    image: "/walkthrough/step-12.png",
  },
  {
    title: "You're set",
    body: "Need help with setup or one-on-one training? Contact us at support@cloudassistone.com.",
    image: "/walkthrough/step-13.png",
  },
];
