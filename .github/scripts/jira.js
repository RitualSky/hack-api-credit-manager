const fs = require("node:fs");

const baseUrl = process.env.JIRA_BASE_URL?.replace(/\/+$/, "");
const email = process.env.JIRA_EMAIL;
const apiToken = process.env.JIRA_API_TOKEN;
const projectKey = process.env.JIRA_PROJECT_KEY;

function requireConfig() {
  const missing = [];
  if (!baseUrl) missing.push("JIRA_BASE_URL");
  if (!email) missing.push("JIRA_EMAIL");
  if (!apiToken) missing.push("JIRA_API_TOKEN");
  if (!projectKey) missing.push("JIRA_PROJECT_KEY");
  if (missing.length) {
    throw new Error(`Missing Jira configuration: ${missing.join(", ")}`);
  }
}

async function jira(path, options = {}) {
  const response = await fetch(`${baseUrl}/rest/api/3${path}`, {
    signal: AbortSignal.timeout(30_000),
    ...options,
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Jira API ${options.method || "GET"} ${path} failed (${response.status}): ${body}`);
  }
  return body ? JSON.parse(body) : {};
}

function adf(lines) {
  return {
    type: "doc",
    version: 1,
    content: lines.map((line) => {
      const match = line.match(/^(.*?)(https?:\/\/\S+)$/);
      const content = match
        ? [
            ...(match[1] ? [{ type: "text", text: match[1] }] : []),
            {
              type: "text",
              text: match[2],
              marks: [{ type: "link", attrs: { href: match[2] } }],
            },
          ]
        : [{ type: "text", text: line }];
      return { type: "paragraph", content };
    }),
  };
}

function writeOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is unavailable");
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function transition(issueKey, targetStatus) {
  const issue = await jira(`/issue/${encodeURIComponent(issueKey)}?fields=status`);
  if (issue.fields.status.name.toLowerCase() === targetStatus.toLowerCase()) return;

  const { transitions } = await jira(`/issue/${encodeURIComponent(issueKey)}/transitions`);
  const match = transitions.find(
    (item) => item.to.name.toLowerCase() === targetStatus.toLowerCase(),
  );
  if (!match) {
    throw new Error(`No Jira transition to "${targetStatus}" is available for ${issueKey}`);
  }

  await jira(`/issue/${encodeURIComponent(issueKey)}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: match.id } }),
  });
}

async function createParent() {
  const runUrl = process.env.RUN_URL;
  const branch = process.env.GITHUB_REF_NAME || "unknown";
  const runId = process.env.GITHUB_RUN_ID || "unknown";
  const issue = await jira("/issue", {
    method: "POST",
    body: JSON.stringify({
      fields: {
        project: { key: projectKey },
        issuetype: { name: "Task" },
        summary: `GitHub Actions ${process.env.GITHUB_WORKFLOW || "pipeline"} #${runId}`,
        description: adf([
          `Workflow: ${process.env.GITHUB_WORKFLOW || "pipeline"}`,
          `Branch: ${branch}`,
          `Run: ${runUrl}`,
        ]),
      },
    }),
  });
  writeOutput("issue_key", issue.key);
  await transition(issue.key, "In Progress");
  console.log(`Created Jira parent issue ${issue.key}`);
}

async function startSubtask() {
  const parentKey = process.env.JIRA_PARENT_KEY;
  if (!parentKey) throw new Error("JIRA_PARENT_KEY is unavailable");

  const project = await jira(`/project/${encodeURIComponent(projectKey)}`);
  const issueTypes = await jira(`/issuetype/project?projectId=${encodeURIComponent(project.id)}`);
  const subtaskType = issueTypes.find((type) => type.subtask);
  if (!subtaskType) throw new Error(`No sub-task issue type is configured for ${projectKey}`);

  const jobName = process.env.JIRA_JOB_NAME;
  const runUrl = process.env.RUN_URL;
  const issue = await jira("/issue", {
    method: "POST",
    body: JSON.stringify({
      fields: {
        project: { key: projectKey },
        parent: { key: parentKey },
        issuetype: { id: subtaskType.id },
        summary: `${jobName}: ${process.env.GITHUB_WORKFLOW || "pipeline"}`,
        description: adf([
          `Job: ${jobName}`,
          `Workflow run: ${runUrl}`,
        ]),
      },
    }),
  });
  writeOutput("issue_key", issue.key);
  await transition(issue.key, "In Progress");
  console.log(`Created Jira sub-task ${issue.key} for ${jobName}`);
}

async function addResultComment(issueKey, result, runUrl, details = []) {
  const content = [
    `Resultado: ${result}`,
    ...details,
    `Logs: ${runUrl}`,
  ];
  await jira(`/issue/${encodeURIComponent(issueKey)}/comment`, {
    method: "POST",
    body: JSON.stringify({ body: adf(content) }),
  });
}

async function finishSubtask() {
  const issueKey = process.env.JIRA_ISSUE_KEY;
  const result = process.env.JOB_RESULT;
  const succeeded = result === "success";
  const label = succeeded ? "Exitoso" : result === "cancelled" ? "Cancelado" : "Fallido";
  await addResultComment(issueKey, label, process.env.RUN_URL);
  await transition(issueKey, succeeded ? "Done" : "Failed");
}

async function finishParent() {
  const issueKey = process.env.JIRA_ISSUE_KEY;
  const results = JSON.parse(process.env.JOB_RESULTS || "{}");
  const failedJobs = Object.entries(results)
    .filter(([, job]) => job.result === "failure" || job.result === "cancelled")
    .map(([name, job]) => `${name}: ${job.result}`);
  const succeeded = failedJobs.length === 0;
  const label = succeeded ? "Exitoso" : "Fallido";

  await addResultComment(
    issueKey,
    label,
    process.env.RUN_URL,
    failedJobs.length ? [`Jobs con errores: ${failedJobs.join(", ")}`] : [],
  );
  await transition(issueKey, succeeded ? "Done" : "Failed");
}

async function main() {
  const command = process.argv[2];
  if (command === "create-parent" && process.env.JIRA_TRACKING_DISABLED === "true") {
    writeOutput("issue_key", "");
    console.log("Jira tracking is unavailable for this forked pull request; continuing without Jira.");
    return;
  }
  if (command === "create-parent") {
    requireConfig();
    await createParent();
    return;
  }
  if (command === "start-subtask") {
    requireConfig();
    await startSubtask();
    return;
  }
  if (command === "finish-subtask") {
    requireConfig();
    await finishSubtask();
    return;
  }
  if (command === "finish-parent") {
    requireConfig();
    await finishParent();
    return;
  }
  throw new Error(`Unsupported Jira command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
