# FlowFi developer portal (#1481)

Docusaurus portal unifying the docs scattered across `docs/`,
`backend/docs/` and `packages/flowfi-sdk/`, with a live API console, an
interactive Soroban RPC playground, and Mermaid architecture diagrams.

## Local development

```bash
cd docs-site
npm install
npm run dev      # http://localhost:3000
```

## Production build

```bash
npm run build    # fails on broken links or missing assets
npm run serve    # serve the production build locally
```

CI (`.github/workflows/deploy-docs.yml`) builds the site on every PR that
touches `docs-site/**` and deploys to GitHub Pages from `main`.

## Structure

```
docs-site/
  docusaurus.config.js   # site config (nav, mermaid, broken-link guard)
  sidebars.js            # navigation
  docs/                  # content: contracts/, backend/, sdks/, guides/, api-reference/
  src/components/        # OpenApiConsole, SorobanPlayground
  src/css/custom.css
```
