const fs = require("node:fs");

const REQUEST_TIMEOUT_MS = 30_000;
const JIRA_API_BASE_URL =
  "https://gianfrancocarrasco1901.atlassian.net/rest/api/3/";

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

function writeOutput(name, value, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) throw new Error("GITHUB_OUTPUT is unavailable");
  fs.appendFileSync(outputPath, `${name}=${value}\n`);
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
  await transition(issue.key, "En curso", config);
  console.log(`Created Jira parent issue ${issue.key}`);
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
  console.log(`Created Jira sub-task ${issue.key} for ${jobName}`);
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

async function finishSubtask(config, env = process.env) {
  const issueKey = env.JIRA_ISSUE_KEY;
  const result = env.JOB_RESULT;
  const succeeded = result === "success";
  let label = "Fallido";
  if (succeeded) label = "Exitoso";
  else if (result === "cancelled") label = "Cancelado";

  await addResultComment(issueKey, label, env.RUN_URL, [], config);
  await transition(issueKey, succeeded ? "Finalizado" : "Fallido", config);
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
}

async function main(command = process.argv[2], env = process.env) {
  if (command === "create-parent" && env.JIRA_TRACKING_DISABLED === "true") {
    writeOutput("issue_key", "", env.GITHUB_OUTPUT);
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
    const config = requireConfig(env);
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
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  adf,
  buildApiUrl,
  createParent,
  finishParent,
  finishSubtask,
  jira,
  main,
  requireConfig,
  startSubtask,
  transition,
  writeOutput,
};
