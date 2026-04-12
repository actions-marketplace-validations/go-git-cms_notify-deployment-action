import * as core from "@actions/core";
import * as github from "@actions/github";

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

/**
 * Maps a GitHub job status string to the CMS canonical deployment status.
 *
 * `job.status` is only available as a workflow expression (`${{ job.status }}`),
 * NOT as a Node.js environment variable. Callers should pass it explicitly
 * via the `job-status` input so that auto-derivation works.
 */
function deriveStatus(jobStatusInput: string): string {
  const jobStatus = jobStatusInput || "";
  switch (jobStatus.toLowerCase()) {
    case "success":
      return "ready";
    case "failure":
      return "error";
    case "cancelled":
      return "cancelled";
    default:
      return "building";
  }
}

// ---------------------------------------------------------------------------
// Branch resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the branch name from (in priority order):
 *   1. The explicit `ref` input
 *   2. GITHUB_HEAD_REF — set for pull_request events (source branch)
 *   3. GITHUB_REF_NAME — set for push and other events
 */
function resolveBranch(refInput: string): string {
  if (refInput) return refInput;
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF;
  return process.env.GITHUB_REF_NAME || "";
}

// ---------------------------------------------------------------------------
// Deployment ID
// ---------------------------------------------------------------------------

/**
 * Derives a stable, idempotent deployment ID from the GitHub run context.
 * Re-running the same workflow attempt sends an upsert for the same
 * deployment record; a fresh attempt produces a new ID.
 *
 * Format: `gogitcms-{runId}-{runAttempt}`
 */
function deriveDeploymentId(): string {
  const runId = process.env.GITHUB_RUN_ID || "0";
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT || "1";
  return `gogitcms-${runId}-${runAttempt}`;
}

// ---------------------------------------------------------------------------
// Error extraction
// ---------------------------------------------------------------------------

interface DeploymentError {
  code?: string;
  message?: string;
}

/**
 * Builds the structured error array for failed deployments. Always includes
 * a link to the Actions run log; optionally includes a caller-supplied
 * message.
 */
function buildErrors(errorMessage: string): DeploymentError[] {
  const { owner, repo } = github.context.repo;
  const runId = process.env.GITHUB_RUN_ID || "0";
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT || "1";
  const runUrl = `https://github.com/${owner}/${repo}/actions/runs/${runId}/attempts/${runAttempt}`;

  const errors: DeploymentError[] = [
    { code: "ACTIONS_RUN_URL", message: runUrl },
  ];

  if (errorMessage) {
    errors.push({ code: "CUSTOM", message: errorMessage });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  try {
    // Read inputs
    const cmsUrl = core.getInput("cms-url", { required: true }).replace(/\/+$/, "");
    const providerId = core.getInput("provider-id", { required: true });
    const webhookSecret = core.getInput("webhook-secret", { required: true });
    const projectId = core.getInput("project-id", { required: true });
    const statusInput = core.getInput("status");
    const jobStatusInput = core.getInput("job-status");
    const deploymentUrl = core.getInput("deployment-url");
    const refInput = core.getInput("ref");
    const deploymentType = core.getInput("deployment-type");
    const errorMessage = core.getInput("error-message");

    // Derive values
    const status = statusInput || deriveStatus(jobStatusInput);
    const branch = resolveBranch(refInput);
    const commit = process.env.GITHUB_SHA || "";
    const deploymentId = deriveDeploymentId();

    if (!branch) {
      core.setFailed("Could not resolve branch name. Set the `ref` input explicitly.");
      return;
    }

    // Build the canonical webhook payload (see spec §7.3)
    const payload: Record<string, unknown> = {
      project_id: projectId,
      branch,
      commit,
      deployment_id: deploymentId,
      status,
    };

    if (deploymentUrl) {
      payload.deployment_url = deploymentUrl;
    }
    if (deploymentType) {
      payload.deployment_type = deploymentType;
    }
    if (status === "error") {
      payload.errors = buildErrors(errorMessage);
    }

    // POST to the generic webhook endpoint
    const url = `${cmsUrl}/api/v1/webhooks/deployment/${providerId}`;
    core.info(`Sending deployment notification to ${url}`);
    core.info(`  status=${status} branch=${branch} commit=${commit.slice(0, 7)} deploymentId=${deploymentId}`);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${webhookSecret}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      core.setFailed(
        `CMS webhook returned ${response.status}: ${body.slice(0, 500)}`,
      );
      return;
    }

    core.info(`Deployment notification accepted (${response.status})`);

    // Set outputs
    core.setOutput("deployment-id", deploymentId);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(String(error));
    }
  }
}

run();
