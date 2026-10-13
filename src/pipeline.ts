// The loan application pipeline: the statuses an application can be in, how
// they are shown to people, and which moves are allowed. Shared by the DB
// layer (enforcement), the API (error messages) and the MCP tools (schemas).

export const STATUSES = [
  "received",
  "kyc_passed",
  "kyc_failed",
  "aml_passed",
  "aml_failed",
  "awaiting_underwriter",
  "approved",
  "declined",
  "offer_issued",
  "funded",
  "withdrawn",
] as const;

export type Status = (typeof STATUSES)[number];

export const LABELS: Record<Status, string> = {
  received: "Application Received",
  kyc_passed: "KYC Passed",
  kyc_failed: "KYC Failed",
  aml_passed: "AML Passed",
  aml_failed: "AML Failed",
  awaiting_underwriter: "Awaiting Underwriter Decision",
  approved: "Approved",
  declined: "Declined",
  offer_issued: "Offer Issued",
  funded: "Funded",
  withdrawn: "Withdrawn",
};

export const ICONS: Record<Status, string> = {
  received: "📥",
  kyc_passed: "🪪",
  kyc_failed: "🪪❌",
  aml_passed: "🔍",
  aml_failed: "🔍❌",
  awaiting_underwriter: "⚖️",
  approved: "✅",
  declined: "❌",
  offer_issued: "📄",
  funded: "💷",
  withdrawn: "🚫",
};

/** Allowed next statuses. An empty list means the status is terminal. */
export const TRANSITIONS: Record<Status, Status[]> = {
  received: ["kyc_passed", "kyc_failed", "withdrawn"],
  kyc_passed: ["aml_passed", "aml_failed", "withdrawn"],
  aml_passed: ["awaiting_underwriter", "withdrawn"],
  awaiting_underwriter: ["approved", "declined", "withdrawn"],
  approved: ["offer_issued", "withdrawn"],
  offer_issued: ["funded", "withdrawn"],
  kyc_failed: [],
  aml_failed: [],
  declined: [],
  funded: [],
  withdrawn: [],
};

export const isStatus = (s: string): s is Status => (STATUSES as readonly string[]).includes(s);
export const isOpen = (s: Status) => TRANSITIONS[s].length > 0;
export const canTransition = (from: Status, to: Status) => TRANSITIONS[from].includes(to);
export const label = (s: Status) => LABELS[s];
export const statusWithIcon = (s: Status) => `${ICONS[s]} ${LABELS[s]}`;

/** One line describing the pipeline, used in the MCP instructions and README. */
export const PIPELINE_TEXT =
  "received → kyc_passed → aml_passed → awaiting_underwriter → approved | declined → offer_issued → funded. " +
  "kyc_failed and aml_failed end the application at that check; withdrawn is allowed from any open status. " +
  "Terminal: kyc_failed, aml_failed, declined, funded, withdrawn.";
