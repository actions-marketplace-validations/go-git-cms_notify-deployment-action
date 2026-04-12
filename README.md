# GoGitCMS Notify Deployment Action

A GitHub Action that reports deployment status to [GoGitCMS](https://gogitcms.com) via the generic webhook provider. Use it to track deployments from any CI/CD pipeline — Netlify, Railway, Render, custom scripts, or anything else that runs in GitHub Actions.

## Quick Start

Add this step at the end of your deploy job with `if: always()` so it runs on success, failure, and cancellation:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Deploy
        run: ./scripts/deploy.sh

      - name: Notify GoGitCMS
        if: always()
        uses: go-git-cms/notify-deployment-action@v1.0.0
        with:
          cms-url: ${{ vars.CMS_URL }}
          provider-id: ${{ vars.CMS_PROVIDER_ID }}
          webhook-secret: ${{ secrets.CMS_WEBHOOK_SECRET }}
          project-id: ${{ vars.CMS_PROJECT_ID }}
          deployment-url: https://my-site.example.com
```

## Prerequisites

1. A **webhook deployment provider** created on your GoGitCMS organization (Settings > Deployments > Connect > Generic Webhook). Note the provider ID and the generated secret.
2. A **deployment project mapping** linking the provider to your repository (Repository Settings > Deployments > Add Project). Note the external project ID you chose.
3. Store the webhook secret as a **GitHub Actions secret** (`CMS_WEBHOOK_SECRET`). Store the CMS URL, provider ID, and project ID as **repository variables** (`CMS_URL`, `CMS_PROVIDER_ID`, `CMS_PROJECT_ID`).

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `cms-url` | **Yes** | — | Base URL of your CMS instance (e.g. `https://cms.example.com`). |
| `provider-id` | **Yes** | — | The `id` of the webhook deployment provider record in the CMS. |
| `webhook-secret` | **Yes** | — | The Bearer token secret for the provider. **Must be stored as a GitHub Actions secret.** |
| `project-id` | **Yes** | — | The external project ID configured in the deployment project mapping. |
| `status` | No | _(auto)_ | Override the deployment status. One of: `queued`, `building`, `ready`, `error`, `cancelled`. When omitted, derived automatically from `job.status` (see [Status Derivation](#status-derivation)). |
| `deployment-url` | No | `""` | Preview or production URL to associate with the deployment. Shown as a clickable link in the CMS UI when the status is `ready`. |
| `ref` | No | _(auto)_ | Override the branch name. When omitted, resolved from the GitHub context (see [Branch Resolution](#branch-resolution)). |
| `deployment-type` | No | `""` | The name of the deployment project mapping to target. **Required when a repository has multiple projects mapped to the same provider** (monorepo setup). Omit for the common single-project case. |
| `error-message` | No | `""` | Custom error message to include when status is `error`. Appended alongside the automatic Actions run URL link. |

## Outputs

| Output | Description |
|---|---|
| `deployment-id` | The deployment ID sent to the CMS. Derived from the GitHub run ID and attempt number. |

## Status Derivation

When the `status` input is not provided, the action reads GitHub's `job.status` context value and maps it:

| GitHub job status | CMS status |
|---|---|
| `success` | `ready` |
| `failure` | `error` |
| `cancelled` | `cancelled` |
| _(step still running)_ | `building` |

For this to work correctly, the step must run with `if: always()` so it executes regardless of whether previous steps succeeded or failed. GitHub injects the final job status into the step's environment at runtime.

## Branch Resolution

The branch name is resolved in this priority order:

1. The explicit `ref` input, if provided.
2. `GITHUB_HEAD_REF` — set automatically for `pull_request` events (contains the source branch name rather than the synthetic merge ref).
3. `GITHUB_REF_NAME` — set for `push` and all other events.

Override with `ref` when using matrix builds or when the automatic resolution doesn't match the branch name in your CMS (e.g. monorepos deploying from a subdirectory that uses a different naming convention).

## Deployment ID

Each notification includes a stable deployment ID derived from the GitHub run context:

```
gogitcms-{GITHUB_RUN_ID}-{GITHUB_RUN_ATTEMPT}
```

This makes notifications idempotent within a single run attempt — calling the action twice in the same job upserts the same deployment record rather than creating a duplicate. A **re-run** of the workflow produces a new attempt number and therefore a new deployment record, correctly representing a distinct deployment attempt.

## Error Handling

When the status is `error` (whether derived or explicit), the action automatically constructs a structured error array:

```json
[
  {
    "code": "ACTIONS_RUN_URL",
    "message": "https://github.com/acme/my-site/actions/runs/12345678/attempts/1"
  }
]
```

This gives CMS users a direct link to the failed build log without the workflow author needing to do anything extra. The link appears in the deployment error popover in the CMS Studio.

If you pass an `error-message` input, it's appended as a second entry:

```json
[
  { "code": "ACTIONS_RUN_URL", "message": "https://github.com/..." },
  { "code": "CUSTOM", "message": "Build failed: module not found './Hero'" }
]
```

## Examples

### Basic: report final status

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Deploy to hosting platform
        run: ./scripts/deploy.sh

      - name: Notify CMS
        if: always()
        uses: go-git-cms/notify-deployment-action@v1.0.0
        with:
          cms-url: ${{ vars.CMS_URL }}
          provider-id: ${{ vars.CMS_PROVIDER_ID }}
          webhook-secret: ${{ secrets.CMS_WEBHOOK_SECRET }}
          project-id: ${{ vars.CMS_PROJECT_ID }}
          deployment-url: https://my-site.example.com
```

### Advanced: building + final status

Mark the branch as "building" at the start, then report the final status at the end. Both calls use the same deployment ID so the second is an upsert over the first.

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Notify CMS — building
        uses: go-git-cms/notify-deployment-action@v1.0.0
        with:
          cms-url: ${{ vars.CMS_URL }}
          provider-id: ${{ vars.CMS_PROVIDER_ID }}
          webhook-secret: ${{ secrets.CMS_WEBHOOK_SECRET }}
          project-id: ${{ vars.CMS_PROJECT_ID }}
          status: building

      - name: Deploy to hosting platform
        run: ./scripts/deploy.sh

      - name: Notify CMS — final status
        if: always()
        uses: go-git-cms/notify-deployment-action@v1.0.0
        with:
          cms-url: ${{ vars.CMS_URL }}
          provider-id: ${{ vars.CMS_PROVIDER_ID }}
          webhook-secret: ${{ secrets.CMS_WEBHOOK_SECRET }}
          project-id: ${{ vars.CMS_PROJECT_ID }}
          deployment-url: https://my-site.example.com
```

### Advanced: monorepo with multiple projects

When a single repository deploys multiple apps, use `deployment-type` to route each notification to the correct deployment project mapping. The value must match the `name` field on the `DeploymentProject` record in the CMS.

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        app: [web, api]
    steps:
      - uses: actions/checkout@v4

      - name: Deploy ${{ matrix.app }}
        run: ./scripts/deploy.sh ${{ matrix.app }}

      - name: Notify CMS — ${{ matrix.app }}
        if: always()
        uses: go-git-cms/notify-deployment-action@v1.0.0
        with:
          cms-url: ${{ vars.CMS_URL }}
          provider-id: ${{ vars.CMS_PROVIDER_ID }}
          webhook-secret: ${{ secrets.CMS_WEBHOOK_SECRET }}
          project-id: ${{ matrix.app == 'web' && vars.CMS_WEB_PROJECT_ID || vars.CMS_API_PROJECT_ID }}
          deployment-type: ${{ matrix.app }}
          deployment-url: https://${{ matrix.app }}.example.com
```

### Pull request previews

For pull request workflows, the action automatically reads the source branch from `GITHUB_HEAD_REF` so deployment status is tracked against the feature branch, not the merge ref.

```yaml
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Deploy preview
        id: deploy
        run: |
          URL=$(./scripts/deploy-preview.sh)
          echo "url=$URL" >> "$GITHUB_OUTPUT"

      - name: Notify CMS
        if: always()
        uses: go-git-cms/notify-deployment-action@v1.0.0
        with:
          cms-url: ${{ vars.CMS_URL }}
          provider-id: ${{ vars.CMS_PROVIDER_ID }}
          webhook-secret: ${{ secrets.CMS_WEBHOOK_SECRET }}
          project-id: ${{ vars.CMS_PROJECT_ID }}
          deployment-url: ${{ steps.deploy.outputs.url }}
```

## How It Works

The action sends a `POST` request to the CMS generic webhook endpoint:

```
POST {cms-url}/api/v1/webhooks/deployment/{provider-id}
Authorization: Bearer {webhook-secret}
Content-Type: application/json

{
  "project_id": "my-project",
  "branch": "main",
  "commit": "abc123def456",
  "deployment_id": "gogitcms-12345678-1",
  "status": "ready",
  "deployment_url": "https://my-site.example.com",
  "deployment_type": "",
  "errors": []
}
```

The CMS server validates the Bearer token, looks up the deployment project mapping, resolves the branch, and enqueues a background job that upserts a `Deployment` row and publishes a real-time event to any subscribed Studio clients.
