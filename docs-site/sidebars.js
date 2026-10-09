/**
 * Docusaurus sidebar for the FlowFi developer portal (#1481).
 *
 * Mirrors the navigation structure from the issue: Getting Started, Smart
 * Contracts, Backend & Indexer, Client SDKs, Guides, API Reference.
 *
 * @type {import('@docusaurus/plugin-content-docs').SidebarsConfig}
 */
const sidebars = {
  docs: [
    { type: "doc", id: "intro", label: "Protocol Overview" },
    {
      type: "category",
      label: "Getting Started",
      items: ["quickstart", "core-concepts"],
    },
    {
      type: "category",
      label: "Smart Contracts",
      items: [
        "contracts/lifecycle",
        "contracts/storage-ttl",
        "contracts/batch-operations",
        "contracts/emergency-pause",
        "contracts/conditional-streams",
        "contracts/soroban-reference",
      ],
    },
    {
      type: "category",
      label: "Backend & Indexer",
      items: [
        "backend/overview",
        "backend/event-ingestion",
        "backend/streams-sse",
        "backend/webhooks",
        "backend/dead-letter-triage",
        "backend/analytics",
      ],
    },
    {
      type: "category",
      label: "Client SDKs",
      items: ["sdks/typescript", "sdks/react", "sdks/python", "sdks/rust"],
    },
    {
      type: "category",
      label: "Guides & Recipes",
      items: [
        "guides/dao-payroll",
        "guides/saas-subscription-billing",
        "guides/milestone-vesting-for-grants",
      ],
    },
    {
      type: "category",
      label: "API Reference",
      items: ["api-reference/index", "api-reference/playground"],
    },
  ],
};

module.exports = sidebars;
