const fs = require("node:fs");

const REQUEST_TIMEOUT_MS = 30_000;
const JIRA_API_BASE_URL =
  "https://gianfrancocarrasco1901.atlassian.net/rest/api/3/";
const JIRA_BROWSE_BASE_URL = "https://gianfrancocarrasco1901.atlassian.net/browse/";

function requireConfig(env = process.env) {
  const missing = [];
  if (!env.JIRA_EMAIL) missing.push("JIRA_EMAIL");
  if (!env.JIRA_API_TOKEN) missing.push("JIRA_API_TOKEN");
  if (!env.JIRA_PROJECT_KEY) missing.push("JIRA_PROJECT_KEY");
  if (missing.length) {
    throw new Error(`Missing Jira configuration: ${missing.join(", ")}`);
  }

  return {
    apiBaseUrl: new URL(JIRA_API_BASE_URL),
    email: env.JIRA_EMAIL,
    apiToken: env.JIRA_API_TOKEN,
    projectKey: env.JIRA_PROJECT_KEY,
  };
}

function buildApiUrl(path, apiBaseUrl) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Jira API path must be a non-empty string");
  }

  const route = path.startsWith("/") ? path.slice(1) : path;
  if (route.startsWith("/") || route.includes("\\")) {
    throw new Error("Invalid Jira API path");
  }

  const requestUrl = new URL(route, apiBaseUrl);
  const isTrustedRequest =
    requestUrl.origin === apiBaseUrl.origin &&
    requestUrl.pathname.startsWith(apiBaseUrl.pathname);
  if (!isTrustedRequest) throw new Error("Jira API URL is outside the configured API origin");

  return requestUrl;
}

async function jira(path, options = {}, config = requireConfig()) {
  const requestUrl = buildApiUrl(path, config.apiBaseUrl);
  const authorization =
    "Basic " + Buffer.from(config.email + ":" + config.apiToken).toString("base64");
  const headers = {
    ...options.headers,
    Authorization: authorization,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const response = await fetch(requestUrl, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "error",
    headers,
  });
  const body = await response.text();
  if (!response.ok) {
    const method = options.method || "GET";
    throw new Error(
      `Jira API ${method} ${requestUrl.pathname} failed (${response.status}): ${body}`,
    );
  }
  return body ? JSON.parse(body) : {};
}

function adf(lines) {
  return {
    type: "doc",
    version: 1,
    content: lines.map((line) => {
      const httpsIndex = line.indexOf("https://");
      const httpIndex = line.indexOf("http://");
      let linkIndex = httpsIndex;
      if (linkIndex === -1 || (httpIndex !== -1 && httpIndex < linkIndex)) {
        linkIndex = httpIndex;
      }

      if (linkIndex === -1) {
        return { type: "paragraph", content: [{ type: "text", text: line }] };
      }

      const prefix = line.slice(0, linkIndex);
      const url = line.slice(linkIndex);
      const content = [];
      if (prefix) content.push({ type: "text", text: prefix });
      content.push({
        type: "text",
        text: url,
        marks: [{ type: "link", attrs: { href: url } }],
      });
      return { type: "paragraph", content };
    }),
  };
}

function sanitizeForLog(value) {
  return String(value).replaceAll(/\p{Cc}+/gu, " ");
}

function writeOutput(name, value, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) throw new Error("GITHUB_OUTPUT is unavailable");
  fs.appendFileSync(outputPath, `${name}=${value}\n`);
}

function getPullRequestNumberFromEvent(env) {
  if (env.PR_NUMBER) return String(env.PR_NUMBER);
  if (env.GITHUB_EVENT_NAME !== "pull_request" || !env.GITHUB_EVENT_PATH) return "";

  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const number = event.pull_request && event.pull_request.number;
  return number ? String(number) : "";
}

function githubApiUrl(path, env) {
  const apiBaseUrl = new URL(env.GITHUB_API_URL || "https://api.github.com");
  const route = path.startsWith("/") ? path.slice(1) : path;
  const requestUrl = new URL(route, `${apiBaseUrl.href.replace(/\/+$/, "")}/`);
  if (requestUrl.origin !== apiBaseUrl.origin) {
    throw new Error("GitHub API URL is outside the configured API origin");
  }
  return requestUrl;
}

async function github(path, options = {}, env = process.env) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is unavailable");
  const requestUrl = githubApiUrl(path, env);
  const response = await fetch(requestUrl, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "error",
    headers: {
      ...options.headers,
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
  });
  const body = await response.text();
  if (!response.ok) {
    const method = options.method || "GET";
    throw new Error(
      `GitHub API ${method} ${requestUrl.pathname} failed (${response.status}): ${body}`,
    );
  }
  return body ? JSON.parse(body) : {};
}

async function resolvePullRequestNumber(env = process.env) {
  const eventPullNumber = getPullRequestNumberFromEvent(env);
  if (eventPullNumber || !env.GITHUB_REPOSITORY || !env.GITHUB_SHA || !env.GITHUB_TOKEN) {
    return eventPullNumber;
  }

  const repository = encodeURIComponent(env.GITHUB_REPOSITORY).replace("%2F", "/");
  const commit = encodeURIComponent(env.GITHUB_SHA);
  const pullRequests = await github(
    `/repos/${repository}/commits/${commit}/pulls?per_page=100`,
    {},
    env,
  );
  const associated = pullRequests.find((pullRequest) => pullRequest.merged_at) || pullRequests[0];
  return associated ? String(associated.number) : "";
}

function pullRequestMarker(runId, stage) {
  const safeStage = String(stage).replaceAll(/[^a-zA-Z0-9_-]/g, "-");
  return `<!-- ci-audit:${runId || "unknown"}:${safeStage} -->`;
}

async function upsertPullRequestComment(prNumber, marker, body, env = process.env) {
  if (!prNumber || env.PR_COMMENT_DISABLED === "true") return;
  const repository = env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is unavailable");

  const encodedRepository = encodeURIComponent(repository).replace("%2F", "/");
  const commentsPath = `/repos/${encodedRepository}/issues/${encodeURIComponent(prNumber)}/comments`;
  let page = 1;
  let existing;
  while (page <= 100) {
    const comments = await github(`${commentsPath}?per_page=100&page=${page}`, {}, env);
    existing = comments.find((comment) => comment.body && comment.body.includes(marker));
    if (existing || comments.length < 100) break;
    page += 1;
  }

  const commentBody = `${marker}\n${body}`;
  if (existing) {
    await github(
      `/repos/${encodedRepository}/issues/comments/${encodeURIComponent(existing.id)}`,
      { method: "PATCH", body: JSON.stringify({ body: commentBody }) },
      env,
    );
    return;
  }

  await github(
    commentsPath,
    { method: "POST", body: JSON.stringify({ body: commentBody }) },
    env,
  );
}

function jiraIssueUrl(issueKey) {
  return `${JIRA_BROWSE_BASE_URL}${encodeURIComponent(issueKey)}`;
}

async function addParentIssuePullRequestComment(issueKey, prNumber, env) {
  if (!prNumber) return;
  const runUrl = env.RUN_URL;
  const body = [
    "## Seguimiento de CI/CD",
    `Issue padre de Jira: [${issueKey}](${jiraIssueUrl(issueKey)})`,
    `Ejecución: [ver logs y artefactos](${runUrl})`,
  ].join("\n\n");
  await upsertPullRequestComment(
    prNumber,
    pullRequestMarker(env.GITHUB_RUN_ID, "jira-parent"),
    body,
    env,
  );
}

async function transition(issueKey, targetStatus, config) {
  const encodedIssueKey = encodeURIComponent(issueKey);
  const issue = await jira(`/issue/${encodedIssueKey}?fields=status`, {}, config);
  const currentStatus = issue.fields.status.name;
  if (currentStatus.toLowerCase() === targetStatus.toLowerCase()) return;

  const { transitions } = await jira(
    `/issue/${encodedIssueKey}/transitions`,
    {},
    config,
  );
  const match = transitions.find(
    (item) => item.to.name.toLowerCase() === targetStatus.toLowerCase(),
  );
  if (!match) {
    throw new Error(`No Jira transition to "${targetStatus}" is available for ${issueKey}`);
  }

  await jira(
    `/issue/${encodedIssueKey}/transitions`,
    {
      method: "POST",
      body: JSON.stringify({ transition: { id: match.id } }),
    },
    config,
  );
}

async function createParent(config, env = process.env) {
  const runUrl = env.RUN_URL;
  const branch = env.GITHUB_REF_NAME || "unknown";
  const runId = env.GITHUB_RUN_ID || "unknown";
  const workflow = env.GITHUB_WORKFLOW || "pipeline";
  const pullRequestNumber = await resolvePullRequestNumber(env);
  const issue = await jira(
    "/issue",
    {
      method: "POST",
      body: JSON.stringify({
        fields: {
          project: { key: config.projectKey },
          issuetype: { name: "Tarea" },
          summary: `GitHub Actions ${workflow} #${runId}`,
          description: adf([
            `Workflow: ${workflow}`,
            `Branch: ${branch}`,
            `Run: ${runUrl}`,
          ]),
        },
      }),
    },
    config,
  );
  writeOutput("issue_key", issue.key, env.GITHUB_OUTPUT);
  writeOutput("pr_number", pullRequestNumber, env.GITHUB_OUTPUT);
  await transition(issue.key, "En curso", config);
  await addParentIssuePullRequestComment(issue.key, pullRequestNumber, env);
  console.log(`Created Jira parent issue ${sanitizeForLog(issue.key)}`);
}

async function startSubtask(config, env = process.env) {
  const parentKey = env.JIRA_PARENT_KEY;
  if (!parentKey) throw new Error("JIRA_PARENT_KEY is unavailable");

  const encodedProjectKey = encodeURIComponent(config.projectKey);
  const project = await jira(`/project/${encodedProjectKey}`, {}, config);
  const projectId = encodeURIComponent(project.id);
  const issueTypes = await jira(`/issuetype/project?projectId=${projectId}`, {}, config);
  const subtaskType = issueTypes.find((type) => type.subtask);
  if (!subtaskType) {
    throw new Error(`No sub-task issue type is configured for ${config.projectKey}`);
  }

  const jobName = env.JIRA_JOB_NAME;
  const runUrl = env.RUN_URL;
  const workflow = env.GITHUB_WORKFLOW || "pipeline";
  const issue = await jira(
    "/issue",
    {
      method: "POST",
      body: JSON.stringify({
        fields: {
          project: { key: config.projectKey },
          parent: { key: parentKey },
          issuetype: { id: subtaskType.id },
          summary: `${jobName}: ${workflow}`,
          description: adf([
            `Job: ${jobName}`,
            `Workflow run: ${runUrl}`,
          ]),
        },
      }),
    },
    config,
  );
  writeOutput("issue_key", issue.key, env.GITHUB_OUTPUT);
  await transition(issue.key, "En curso", config);
  console.log(
    `Created Jira sub-task ${sanitizeForLog(issue.key)} for ${sanitizeForLog(jobName)}`,
  );
}

async function addResultComment(issueKey, result, runUrl, details, config) {
  const content = [
    `Resultado: ${result}`,
    ...details,
    `Logs: ${runUrl}`,
  ];
  await jira(
    `/issue/${encodeURIComponent(issueKey)}/comment`,
    {
      method: "POST",
      body: JSON.stringify({ body: adf(content) }),
    },
    config,
  );
}

function artifactNames(env) {
  return (env.EVIDENCE_ARTIFACTS || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function subtaskResultLines(issueKey, parentKey, result, runUrl, env) {
  const jobName = env.JIRA_JOB_NAME || env.GITHUB_JOB || "Etapa";
  const parentLine = parentKey
    ? `Issue padre: ${parentKey}: ${jiraIssueUrl(parentKey)}`
    : "";
  const artifacts = artifactNames(env);
  const stageNote = env.STAGE_NOTE ? [`Nota: ${env.STAGE_NOTE}`] : [];
  return [
    `Etapa: ${jobName}`,
    `Resultado: ${result}`,
    ...(parentLine ? [parentLine] : []),
    `Subtarea: ${issueKey}: ${jiraIssueUrl(issueKey)}`,
    `Evidencia (logs y artefactos): ${runUrl}`,
    ...(artifacts.length ? [`Artefactos: ${artifacts.join(", ")}`] : []),
    ...stageNote,
  ];
}

async function updateSubtaskDescription(issueKey, lines, config) {
  const encodedIssueKey = encodeURIComponent(issueKey);
  const issue = await jira(`/issue/${encodedIssueKey}?fields=description`, {}, config);
  const description = issue.fields.description;
  const existingContent =
    description && description.type === "doc" && Array.isArray(description.content)
      ? description.content
      : [];
  await jira(
    `/issue/${encodedIssueKey}`,
    {
      method: "PUT",
      body: JSON.stringify({
        fields: {
          description: {
            type: "doc",
            version: 1,
            content: [...existingContent, ...adf(lines).content],
          },
        },
      }),
    },
    config,
  );
}

function pullRequestStageComment(issueKey, parentKey, result, runUrl, env) {
  const jobName = env.JIRA_JOB_NAME || env.GITHUB_JOB || "Etapa";
  const artifacts = artifactNames(env);
  const stageNote = env.STAGE_NOTE ? [`Nota: ${env.STAGE_NOTE}`] : [];
  const statusIcon = result === "Exitoso" ? "✅" : result === "Cancelado" ? "⚪" : "❌";
  return [
    `## ${statusIcon} ${jobName}: ${result}`,
    ...(parentKey
      ? [`Issue padre Jira: [${parentKey}](${jiraIssueUrl(parentKey)})`]
      : []),
    ...(issueKey
      ? [`Subtarea Jira: [${issueKey}](${jiraIssueUrl(issueKey)})`]
      : []),
    `Evidencia: [ver logs y artefactos de esta ejecución](${runUrl})`,
    ...(artifacts.length ? [`Artefactos: ${artifacts.join(", ")}`] : []),
    ...stageNote,
  ].join("\n\n");
}

async function finishSubtask(config, env = process.env) {
  const issueKey = env.JIRA_ISSUE_KEY;
  const result = env.JOB_RESULT;
  if (!result) throw new Error("JOB_RESULT is unavailable");
  const succeeded = result === "success";
  let label = "Fallido";
  if (succeeded) label = "Exitoso";
  else if (result === "cancelled") label = "Cancelado";

  if (issueKey) {
    if (!config) throw new Error("Jira configuration is required to finish a subtask");
    const lines = subtaskResultLines(
      issueKey,
      env.JIRA_PARENT_KEY,
      label,
      env.RUN_URL,
      env,
    );
    await updateSubtaskDescription(issueKey, lines, config);
    await addResultComment(issueKey, label, env.RUN_URL, lines, config);
    await transition(issueKey, succeeded ? "Finalizado" : "Fallido", config);
  }

  const prNumber = env.PR_NUMBER || (await resolvePullRequestNumber(env));
  if (prNumber && env.PR_COMMENT_DISABLED !== "true") {
    const jobName = env.JIRA_JOB_NAME || env.GITHUB_JOB || "Etapa";
    await upsertPullRequestComment(
      prNumber,
      pullRequestMarker(env.GITHUB_RUN_ID, jobName),
      pullRequestStageComment(
        issueKey,
        env.JIRA_PARENT_KEY,
        label,
        env.RUN_URL,
        env,
      ),
      env,
    );
  }
}

async function finishParent(config, env = process.env) {
  const issueKey = env.JIRA_ISSUE_KEY;
  const results = JSON.parse(env.JOB_RESULTS || "{}");
  const failedJobs = Object.entries(results)
    .filter(([, job]) => job.result === "failure" || job.result === "cancelled")
    .map(([name, job]) => `${name}: ${job.result}`);
  const succeeded = failedJobs.length === 0;
  const label = succeeded ? "Exitoso" : "Fallido";
  const details = failedJobs.length
    ? [`Jobs con errores: ${failedJobs.join(", ")}`]
    : [];

  await addResultComment(issueKey, label, env.RUN_URL, details, config);
  await transition(issueKey, succeeded ? "Finalizado" : "Fallido", config);

  const prNumber = env.PR_NUMBER || (await resolvePullRequestNumber(env));
  if (prNumber && env.PR_COMMENT_DISABLED !== "true") {
    const jobLines = Object.entries(results).map(
      ([name, job]) => `- ${name}: ${job.result}`,
    );
    const body = [
      `## ${succeeded ? "✅" : "❌"} Resultado final del workflow: ${label}`,
      `Issue padre Jira: [${issueKey}](${jiraIssueUrl(issueKey)})`,
      ...(jobLines.length ? [`### Etapas\n${jobLines.join("\n")}`] : []),
      `Evidencia: [ver ejecución, logs y artefactos](${env.RUN_URL})`,
    ].join("\n\n");
    await upsertPullRequestComment(
      prNumber,
      pullRequestMarker(env.GITHUB_RUN_ID, "jira-final"),
      body,
      env,
    );
  }
}

async function main(command = process.argv[2], env = process.env) {
  if (command === "create-parent" && env.JIRA_TRACKING_DISABLED === "true") {
    writeOutput("issue_key", "", env.GITHUB_OUTPUT);
    const pullRequestNumber = await resolvePullRequestNumber(env);
    writeOutput("pr_number", pullRequestNumber, env.GITHUB_OUTPUT);
    console.log("Jira tracking is unavailable for this forked pull request; continuing without Jira.");
    return;
  }
  if (command === "create-parent") {
    const config = requireConfig(env);
    await createParent(config, env);
    return;
  }
  if (command === "start-subtask") {
    const config = requireConfig(env);
    await startSubtask(config, env);
    return;
  }
  if (command === "finish-subtask") {
    const config = env.JIRA_ISSUE_KEY ? requireConfig(env) : null;
    await finishSubtask(config, env);
    return;
  }
  if (command === "finish-parent") {
    const config = requireConfig(env);
    await finishParent(config, env);
    return;
  }
  throw new Error(`Unsupported Jira command: ${command}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(sanitizeForLog(error.message));
    process.exitCode = 1;
  });
}

module.exports = {
  adf,
  addParentIssuePullRequestComment,
  artifactNames,
  buildApiUrl,
  createParent,
  finishParent,
  finishSubtask,
  github,
  githubApiUrl,
  jira,
  main,
  pullRequestMarker,
  pullRequestStageComment,
  resolvePullRequestNumber,
  requireConfig,
  sanitizeForLog,
  startSubtask,
  subtaskResultLines,
  transition,
  updateSubtaskDescription,
  upsertPullRequestComment,
  writeOutput,
};
