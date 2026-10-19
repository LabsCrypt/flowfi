/**
 * FlowFi Developer Portal — Docusaurus config (#1481).
 *
 * The portal unifies docs currently scattered across `docs/`, `backend/docs/`
 * and `packages/flowfi-sdk/` under one navigation. Build with `npm run build`
 * inside `docs-site/`; CI builds it on every PR (see
 * `.github/workflows/deploy-docs.yml`).
 *
 * @type {import('@docusaurus/types').Config}
 */
const config = {
  title: "FlowFi Developers",
  tagline: "Streaming payments on Stellar Soroban — build on the FlowFi protocol",
  url: "https://developers.flowfi.xyz",
  baseUrl: "/",
  organizationName: "LabsCrypt",
  projectName: "flowfi",
  onBrokenLinks: "throw",
  onBrokenMarkdownLinks: "throw",
  favicon: "img/favicon.ico",

  presets: [
    [
      "classic",
      /** @type {import('@docusaurus/preset-classic').Options} */
      {
        docs: {
          routeBasePath: "/",
          sidebarPath: "./sidebars.js",
          editUrl: "https://github.com/LabsCrypt/flowfi/edit/main/docs-site/",
        },
        theme: {
          customCss: "./src/css/custom.css",
        },
      },
    ],
  ],

  // Mermaid diagrams render from ```mermaid code blocks via the official
  // theme (no third-party remark plugin needed).
  themes: ["@docusaurus/theme-mermaid"],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    {
      navbar: {
        title: "FlowFi Developers",
        items: [
          { to: "/quickstart", label: "Getting Started", position: "left" },
          { to: "/contracts/lifecycle", label: "Contracts", position: "left" },
          { to: "/backend/overview", label: "Backend & Indexer", position: "left" },
          { to: "/sdks/typescript", label: "SDKs", position: "left" },
          { to: "/api-reference", label: "API Reference", position: "left" },
          { to: "/api-reference/playground", label: "Playground", position: "right" },
          {
            href: "https://github.com/LabsCrypt/flowfi",
            label: "GitHub",
            position: "right",
          },
        ],
      },
      footer: {
        copyright: `Copyright © ${new Date().getFullYear()} FlowFi contributors.`,
      },
      mermaid: {
        theme: { light: "neutral", dark: "dark" },
      },
    },

  markdown: {
    mermaid: true,
  },
};

module.exports = config;
