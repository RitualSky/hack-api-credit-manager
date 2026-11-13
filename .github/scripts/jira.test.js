const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, afterEach, test } = require("node:test");
const {
  adf,
  buildApiUrl,
  jira,
  main,
  requireConfig,
  sanitizeForLog,
  startSubtask,
  transition,
  writeOutput,
} = require("./jira");

const originalFetch = global.fetch;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jira-tests-"));
const apiBaseUrl = new URL(
  "https://gianfrancocarrasco1901.atlassian.net/rest/api/3/",
);
const config = {
  apiBaseUrl,
  email: "ci@example.test",
  apiToken: "test-token",
  projectKey: "SCRUM",
};

afterEach(() => {
  global.fetch = originalFetch;
});

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setFetch(handler) {
  const calls = [];
  global.fetch = async (target, options) => {
    const call = { url: new URL(target), options };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return calls;
}

function jiraEnv(overrides = {}) {
  return {
    JIRA_EMAIL: "ci@example.test",
    JIRA_API_TOKEN: "test-token",
    JIRA_PROJECT_KEY: "SCRUM",
    GITHUB_OUTPUT: path.join(tempDir, "github-output"),
    GITHUB_WORKFLOW: "CI",
    GITHUB_REF_NAME: "feature/test",
    GITHUB_RUN_ID: "42",
    RUN_URL: "https://github.com/acme/repo/actions/runs/42",
    ...overrides,
  };
}

function setTransitionFetch(currentStatus, transitions = []) {
  return setFetch(({ url, options }) => {
    if (url.pathname.endsWith("/transitions") && options.method === "POST") {
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/transitions")) {
      return jsonResponse({ transitions });
    }
    if (url.pathname.includes("/issue/")) {
      return jsonResponse({ fields: { status: { name: currentStatus } } });
    }
    throw new Error(`Unexpected Jira request: ${options.method} ${url.pathname}`);
  });
}

test("requires Jira credentials and uses the fixed tenant origin", () => {
  assert.throws(() => requireConfig({}), /JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY/);
  const valid = requireConfig({
    ...jiraEnv(),
    JIRA_BASE_URL: "https://attacker.example",
  });
  assert.equal(valid.apiBaseUrl.href, apiBaseUrl.href);
  assert.equal(valid.projectKey, "SCRUM");
});

test("builds API URLs only within the configured Jira endpoint", () => {
  assert.equal(buildApiUrl("/issue/SCRUM-1?fields=status", apiBaseUrl).href,
    "https://gianfrancocarrasco1901.atlassian.net/rest/api/3/issue/SCRUM-1?fields=status");
  assert.equal(buildApiUrl("issue/SCRUM-1", apiBaseUrl).pathname,
    "/rest/api/3/issue/SCRUM-1");
  assert.throws(() => buildApiUrl("", apiBaseUrl), /non-empty string/);
  assert.throws(() => buildApiUrl(null, apiBaseUrl), /non-empty string/);
  assert.throws(() => buildApiUrl("//evil.example/path", apiBaseUrl), /Invalid Jira API path/);
  assert.throws(() => buildApiUrl("\\\\evil.example\\path", apiBaseUrl), /Invalid Jira API path/);
  assert.throws(() => buildApiUrl("https://evil.example/issue", apiBaseUrl), /outside the configured API origin/);
  assert.throws(() => buildApiUrl("../admin", apiBaseUrl), /outside the configured API origin/);
});

test("sends authenticated requests and parses JSON or empty responses", async () => {
  const calls = setFetch(() => jsonResponse({ issue: "SCRUM-1" }));
  const result = await jira("/issue", { headers: { "X-Test": "yes", Authorization: "ignored" } }, config);
  assert.deepEqual(result, { issue: "SCRUM-1" });
  assert.equal(
    calls[0].url.href,
    "https://gianfrancocarrasco1901.atlassian.net/rest/api/3/issue",
  );
  assert.equal(
    calls[0].options.headers.Authorization,
    `Basic ${Buffer.from("ci@example.test:test-token").toString("base64")}`,
  );
  assert.equal(calls[0].options.headers["X-Test"], "yes");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.redirect, "error");

  setFetch(() => new Response(null, { status: 204 }));
  assert.deepEqual(await jira("/issue", {}, config), {});
});

test("reports Jira HTTP failures", async () => {
  setFetch(() => new Response("denied", { status: 403 }));
  await assert.rejects(jira("/issue", { method: "POST" }, config), /POST .*failed \(403\): denied/);
  setFetch(() => new Response("denied", { status: 500 }));
  await assert.rejects(jira("/issue", {}, config), /GET .*failed \(500\): denied/);
});

test("creates linked ADF paragraphs with or without URL prefixes", () => {
  const document = adf([
    "plain text",
    "https://github.com/acme/repo",
    "Logs: http://example.test/run",
    "http://first.test then https://second.test",
    "https://first.test then http://second.test",
  ]);
  assert.equal(document.content[0].content[0].text, "plain text");
  assert.equal(document.content[1].content[0].marks[0].attrs.href, "https://github.com/acme/repo");
  assert.equal(document.content[2].content[1].marks[0].attrs.href, "http://example.test/run");
  assert.equal(document.content[3].content[0].marks[0].attrs.href, "http://first.test then https://second.test");
  assert.equal(document.content[4].content[0].marks[0].attrs.href, "https://first.test then http://second.test");
});

test("writes GitHub outputs and fails explicitly when unavailable", () => {
  const output = path.join(tempDir, "output.txt");
  writeOutput("issue_key", "SCRUM-1", output);
  assert.equal(fs.readFileSync(output, "utf8"), "issue_key=SCRUM-1\n");
  assert.throws(() => writeOutput("issue_key", "SCRUM-1", ""), /GITHUB_OUTPUT is unavailable/);
});

test("does not transition an issue already in the target state", async () => {
  const calls = setTransitionFetch("en CURSO");
  await transition("SCRUM-1", "En curso", config);
  assert.equal(calls.length, 1);
});

test("transitions an issue and rejects unavailable transitions", async () => {
  const calls = setTransitionFetch("To Do", [{ id: "2", to: { name: "Done" } }]);
  await transition("SCRUM-1", "Done", config);
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(calls[2].options.body).transition.id, "2");

  setTransitionFetch("To Do", []);
  await assert.rejects(transition("SCRUM-1", "Done", config), /No Jira transition to "Done"/);
});

test("creates a parent issue, transitions it, and records the output", async () => {
  const output = path.join(tempDir, "parent-output.txt");
  const calls = setFetch(({ url, options }) => {
    if (options.method === "POST" && url.pathname.endsWith("/issue")) {
      return jsonResponse({ key: "SCRUM-10" }, 201);
    }
    if (url.pathname.endsWith("/transitions") && options.method === "POST") {
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/transitions")) {
      return jsonResponse({ transitions: [{ id: "in-progress", to: { name: "En curso" } }] });
    }
    return jsonResponse({ fields: { status: { name: "To Do" } } });
  });
  await main("create-parent", jiraEnv({ GITHUB_OUTPUT: output }));
  assert.equal(fs.readFileSync(output, "utf8"), "issue_key=SCRUM-10\n");
  const createBody = JSON.parse(calls[0].options.body);
  assert.equal(createBody.fields.issuetype.name, "Tarea");
  assert.match(createBody.fields.summary, /CI #42/);
  assert.equal(JSON.parse(calls[3].options.body).transition.id, "in-progress");

  const fallbackOutput = path.join(tempDir, "parent-fallback-output.txt");
  const fallbackEnv = jiraEnv({ GITHUB_OUTPUT: fallbackOutput });
  delete fallbackEnv.GITHUB_REF_NAME;
  delete fallbackEnv.GITHUB_RUN_ID;
  delete fallbackEnv.GITHUB_WORKFLOW;
  setFetch(({ url, options }) => {
    if (options.method === "POST" && url.pathname.endsWith("/issue")) {
      return jsonResponse({ key: "SCRUM-12" }, 201);
    }
    if (url.pathname.endsWith("/transitions") && options.method === "POST") {
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/transitions")) {
      return jsonResponse({ transitions: [{ id: "in-progress", to: { name: "En curso" } }] });
    }
    return jsonResponse({ fields: { status: { name: "To Do" } } });
  });
  await main("create-parent", fallbackEnv);
});

test("creates a subtask and rejects missing parent or subtask type", async () => {
  await assert.rejects(startSubtask(config, {}), /JIRA_PARENT_KEY is unavailable/);

  let callCount = 0;
  setFetch(() => {
    callCount += 1;
    return callCount === 1 ? jsonResponse({ id: "100" }) : jsonResponse([]);
  });
  await assert.rejects(startSubtask(config, jiraEnv({ JIRA_PARENT_KEY: "SCRUM-1" })),
    /No sub-task issue type is configured/);

  const output = path.join(tempDir, "subtask-output.txt");
  const calls = setFetch(({ url, options }) => {
    if (url.pathname.endsWith("/project/SCRUM")) return jsonResponse({ id: "100" });
    if (url.pathname.endsWith("/issuetype/project")) return jsonResponse([{ id: "5", subtask: true }]);
    if (options.method === "POST" && url.pathname.endsWith("/issue")) return jsonResponse({ key: "SCRUM-11" }, 201);
    if (url.pathname.endsWith("/transitions") && options.method === "POST") return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/transitions")) return jsonResponse({ transitions: [{ id: "start", to: { name: "En curso" } }] });
    return jsonResponse({ fields: { status: { name: "To Do" } } });
  });
  const subtaskEnv = jiraEnv({
    JIRA_PARENT_KEY: "SCRUM-1",
    JIRA_JOB_NAME: "Build",
    GITHUB_OUTPUT: output,
  });
  delete subtaskEnv.GITHUB_WORKFLOW;
  await main("start-subtask", subtaskEnv);
  assert.equal(fs.readFileSync(output, "utf8"), "issue_key=SCRUM-11\n");
  const createBody = JSON.parse(calls[2].options.body);
  assert.equal(createBody.fields.parent.key, "SCRUM-1");
  assert.equal(createBody.fields.issuetype.id, "5");
});

test("finishes subtasks with result comments and status transitions", async () => {
  for (const [result, expectedLabel, expectedStatus] of [
    ["success", "Exitoso", "Finalizado"],
    ["cancelled", "Cancelado", "Fallido"],
    ["failure", "Fallido", "Fallido"],
  ]) {
    let comment;
    const calls = setFetch(({ url, options }) => {
      if (url.pathname.endsWith("/comment")) {
        comment = JSON.parse(options.body);
        return jsonResponse({ id: "comment-1" }, 201);
      }
      return jsonResponse({ fields: { status: { name: expectedStatus } } });
    });
    await main("finish-subtask", jiraEnv({
      JIRA_ISSUE_KEY: "SCRUM-20",
      JOB_RESULT: result,
    }));
    assert.match(JSON.stringify(comment), new RegExp(expectedLabel));
    assert.ok(JSON.stringify(comment).includes("https://github.com/acme/repo/actions/runs/42"));
    assert.equal(calls.length, 2);
  }
});

test("finishes the parent based on failed or skipped jobs", async () => {
  for (const [jobResults, expectedLabel, expectedStatus] of [
    [undefined, "Exitoso", "Finalizado"],
    [{ build: { result: "success" }, zap: { result: "skipped" } }, "Exitoso", "Finalizado"],
    [{ unit: { result: "failure" }, deploy: { result: "cancelled" } }, "Fallido", "Fallido"],
  ]) {
    let comment;
    const calls = setFetch(({ url, options }) => {
      if (url.pathname.endsWith("/comment")) {
        comment = JSON.parse(options.body);
        return jsonResponse({ id: "comment-2" }, 201);
      }
      return jsonResponse({ fields: { status: { name: expectedStatus } } });
    });
    const env = jiraEnv({
      JIRA_ISSUE_KEY: "SCRUM-30",
    });
    if (jobResults) env.JOB_RESULTS = JSON.stringify(jobResults);
    await main("finish-parent", env);
    assert.match(JSON.stringify(comment), new RegExp(expectedLabel));
    if (expectedLabel === "Fallido") assert.match(JSON.stringify(comment), /unit: failure, deploy: cancelled/);
    assert.equal(calls.length, 2);
  }
});

test("skips Jira for forked PRs and rejects unknown commands", async () => {
  const output = path.join(tempDir, "disabled-output.txt");
  await main("create-parent", { JIRA_TRACKING_DISABLED: "true", GITHUB_OUTPUT: output });
  assert.equal(fs.readFileSync(output, "utf8"), "issue_key=\n");
  await assert.rejects(main("unknown"), /Unsupported Jira command/);
});

test("removes control characters from logged values", () => {
  assert.equal(sanitizeForLog("SCRUM-1\r\nforged line\t!"), "SCRUM-1 forged line !");
  assert.equal(sanitizeForLog(undefined), "undefined");
});

test("handles the executable entrypoint error path", () => {
  const helperPath = path.join(__dirname, "jira.js");
  const result = spawnSync(process.execPath, [helperPath, "unknown"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported Jira command/);
});
