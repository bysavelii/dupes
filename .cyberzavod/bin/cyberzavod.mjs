#!/usr/bin/env node

// src/cli.ts
import { homedir, tmpdir } from "node:os";
import { parseArgs } from "node:util";

// ../../adapters/claude/src/commands/draft.ts
import { mkdir as mkdir3, readFile as readFile3, writeFile as writeFile3 } from "node:fs/promises";
import path5 from "node:path";

// ../../adapters/claude/src/capture/builds.ts
var IDLE_GAP_MS = 2 * 60 * 1e3;
function runOf(event) {
  return event.type === "draft_prompt" || event.type === "draft_intervention" ? void 0 : event.run;
}
function projectOfEvent(event) {
  switch (event.type) {
    case "draft_prompt":
    case "draft_message":
    case "draft_intervention":
    case "draft_run":
      return void 0;
    default:
      return event.project;
  }
}
function namedBuild(event, buildOfRun, firstBuild) {
  const canNameBuild = event.type === "draft_prompt" || event.type === "draft_message" || event.type === "draft_intervention";
  if (canNameBuild && event.build !== void 0) return event.build;
  const run = runOf(event);
  return run === void 0 ? void 0 : buildOfRun.get(run) ?? firstBuild;
}
function firstBuildsOfProjects(builds) {
  const firstBuilds = /* @__PURE__ */ new Map();
  for (const { id, project } of builds) {
    if (project !== "" && !firstBuilds.has(project)) firstBuilds.set(project, id);
  }
  return firstBuilds;
}
function eventBuilds(draft) {
  const firstBuild = draft.builds[0]?.id;
  if (firstBuild === void 0) throw new Error("\u0432 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0435 \u043D\u0435\u0442 \u0441\u0431\u043E\u0440\u043E\u043A");
  const runBuilds = draft.builds.flatMap(
    ({ id, runs }) => runs.map((run) => [run, id])
  );
  const buildOfRun = new Map(runBuilds);
  const projectOfBuild = new Map(draft.builds.map(({ id, project }) => [id, project]));
  const firstBuildOfProject = firstBuildsOfProjects(draft.builds);
  const lastBuildOfProject = /* @__PURE__ */ new Map();
  let current = firstBuild;
  return draft.events.map((event) => {
    const named = namedBuild(event, buildOfRun, firstBuild);
    if (named !== void 0) current = named;
    const project = projectOfEvent(event);
    const byProject = project === void 0 ? void 0 : lastBuildOfProject.get(project) ?? firstBuildOfProject.get(project);
    const owner = named ?? byProject ?? current;
    const ownerProject = projectOfBuild.get(owner);
    if (ownerProject !== void 0 && ownerProject !== "") {
      lastBuildOfProject.set(ownerProject, owner);
    }
    return owner;
  });
}
function unassignedRuns(draft) {
  const assigned = new Set(draft.builds.flatMap(({ runs }) => runs));
  const seen = /* @__PURE__ */ new Set();
  return draft.events.flatMap((event) => {
    if (event.type !== "draft_run" || assigned.has(event.run) || seen.has(event.run)) return [];
    seen.add(event.run);
    return [event];
  });
}
function projectsWithoutBuild(draft) {
  const withBuild = new Set(draft.builds.map(({ project }) => project));
  const missing = /* @__PURE__ */ new Set();
  for (const event of draft.events) {
    const project = projectOfEvent(event);
    if (project !== void 0 && !withBuild.has(project)) missing.add(project);
  }
  return [...missing];
}
function isTimed(event) {
  return event.type !== "usage" && event.type !== "build_start" && event.type !== "build_end";
}
function spanOf(event) {
  return event.type === "draft_run" ? { from: event.t, to: Math.max(event.t, event.until) } : { from: event.t, to: event.t };
}
function mergedSpans(events) {
  const merged = [];
  const spans = events.filter(isTimed).map(spanOf);
  for (const span of spans.sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last !== void 0 && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }
  return merged;
}
function buildTimeline(events) {
  const spans = mergedSpans(events);
  const first = spans[0];
  const last = spans.at(-1);
  if (first === void 0 || last === void 0) return void 0;
  const cuts = spans.slice(1).flatMap((span, index) => {
    const gap = span.from - (spans[index]?.to ?? span.from);
    return gap > IDLE_GAP_MS ? [{ before: span.from, cut: gap - IDLE_GAP_MS }] : [];
  });
  const cutBefore = (t) => cuts.filter(({ before }) => before <= t).reduce((sum, { cut }) => sum + cut, 0);
  const at = (t) => t - first.from - cutBefore(t);
  return { start: first.from, end: at(last.to), at };
}

// ../core/src/guards.ts
function isObject(value) {
  return typeof value === "object" && value !== null;
}
function isLine(value) {
  return typeof value === "string" && value.trim() !== "" && !/[\r\n]/.test(value);
}

// ../core/src/stage.ts
var STAGES = ["planning", "implementation", "review", "verification", "record"];
function isStage(value) {
  return STAGES.includes(value);
}
var WorkflowError = class extends Error {
};
function parseWorkflow(raw) {
  if (!isObject(raw)) throw new WorkflowError("\u043F\u0440\u043E\u0446\u0435\u0441\u0441 \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u043C");
  const { name, stages } = raw;
  if (!isLine(name)) throw new WorkflowError("name \u0434\u043E\u043B\u0436\u043D\u043E \u0431\u044B\u0442\u044C \u043D\u0435\u043F\u0443\u0441\u0442\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439");
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new WorkflowError("stages \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C \u043D\u0435\u043F\u0443\u0441\u0442\u044B\u043C \u0441\u043F\u0438\u0441\u043A\u043E\u043C");
  }
  const unknownStage = stages.find((stage) => !isStage(stage));
  if (unknownStage !== void 0) {
    throw new WorkflowError(`\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u044D\u0442\u0430\u043F ${String(unknownStage)}`);
  }
  const hasDuplicates = new Set(stages).size !== stages.length;
  if (hasDuplicates) throw new WorkflowError("\u044D\u0442\u0430\u043F\u044B \u043F\u043E\u0432\u0442\u043E\u0440\u044F\u044E\u0442\u0441\u044F");
  return { name, stages };
}

// ../core/src/harness.ts
var STAGE_ACCESS = ["read", "write"];
var HarnessError = class extends Error {
};
var FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;
var FRONTMATTER_LINE = /^([a-z]+):\s*(.*)$/;
function frontmatterOf(text, stage) {
  const match = FRONTMATTER.exec(text);
  if (match === null) throw new HarnessError(`\u044D\u0442\u0430\u043F ${stage}: \u043D\u0435\u0442 \u0448\u0430\u043F\u043A\u0438 \u043C\u0435\u0436\u0434\u0443 \u0441\u0442\u0440\u043E\u043A\u0430\u043C\u0438 ---`);
  const fields = /* @__PURE__ */ new Map();
  for (const line of (match[1] ?? "").split("\n")) {
    const field2 = FRONTMATTER_LINE.exec(line);
    if (field2 === null) throw new HarnessError(`\u044D\u0442\u0430\u043F ${stage}: \u0441\u0442\u0440\u043E\u043A\u0430 \u0448\u0430\u043F\u043A\u0438 \xAB${line}\xBB \u043D\u0435 \u043F\u043E\u043B\u0435`);
    fields.set(field2[1] ?? "", (field2[2] ?? "").trim());
  }
  return { fields, body: text.slice(match[0].length).trim() };
}
function isStageAccess(value) {
  return STAGE_ACCESS.includes(value);
}
function roleOf(fields, stage) {
  const name = fields.get("role");
  if (name === void 0) return void 0;
  if (!/^[a-z][a-z-]*$/.test(name)) {
    throw new HarnessError(`\u044D\u0442\u0430\u043F ${stage}: role \u2014 \u0441\u0442\u0440\u043E\u0447\u043D\u044B\u0435 \u043B\u0430\u0442\u0438\u043D\u0441\u043A\u0438\u0435 \u0431\u0443\u043A\u0432\u044B \u0438 \xAB-\xBB`);
  }
  const access2 = fields.get("access");
  if (!isStageAccess(access2)) {
    throw new HarnessError(`\u044D\u0442\u0430\u043F ${stage}: access \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C ${STAGE_ACCESS.join(" \u0438\u043B\u0438 ")}`);
  }
  return { name, access: access2 };
}
function parseStageGuide(stage, text) {
  const { fields, body } = frontmatterOf(text.replace(/\r\n/g, "\n"), stage);
  const title = fields.get("title");
  const description = fields.get("description");
  if (!isLine(title) || !isLine(description)) {
    throw new HarnessError(`\u044D\u0442\u0430\u043F ${stage}: \u0432 \u0448\u0430\u043F\u043A\u0435 \u043D\u0443\u0436\u043D\u044B title \u0438 description`);
  }
  const role = roleOf(fields, stage);
  return role === void 0 ? { stage, title, description, body } : { stage, title, description, role, body };
}
var MARKDOWN = ".md";
var JSON_EXTENSION = ".json";
var PRINCIPLES = "principles/";
var STAGES_DIRECTORY = "stages/";
var WORKFLOWS = "workflows/";
var CONDUCTOR = "conductor.md";
function requiredFile(files, name) {
  const text = files[name];
  if (text === void 0) throw new HarnessError(`\u0432 harness \u043D\u0435\u0442 \u0444\u0430\u0439\u043B\u0430 ${name}`);
  return text;
}
function compareNames(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
function filesIn(files, directory, extension) {
  const matching = Object.entries(files).filter(
    ([path20]) => path20.startsWith(directory) && path20.endsWith(extension)
  );
  const named = matching.map(([path20, text]) => [
    path20.slice(directory.length, -extension.length),
    text
  ]);
  const direct = named.filter(([name]) => !name.includes("/"));
  return direct.sort(([left], [right]) => compareNames(left, right));
}
function workflowFrom(name, text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new HarnessError(`\u043F\u0440\u043E\u0446\u0435\u0441\u0441 ${name}: \u043D\u0435 JSON`, { cause: err });
  }
  const workflow = parseWorkflow(raw);
  if (workflow.name !== name) {
    throw new HarnessError(`\u043F\u0440\u043E\u0446\u0435\u0441\u0441 ${name}: name \u0434\u043E\u043B\u0436\u0435\u043D \u0441\u043E\u0432\u043F\u0430\u0434\u0430\u0442\u044C \u0441 \u0438\u043C\u0435\u043D\u0435\u043C \u0444\u0430\u0439\u043B\u0430`);
  }
  return workflow;
}
function parseHarness(files) {
  const stages = Object.fromEntries(
    STAGES.map((stage) => [
      stage,
      parseStageGuide(stage, requiredFile(files, `${STAGES_DIRECTORY}${stage}${MARKDOWN}`))
    ])
  );
  const principles = filesIn(files, PRINCIPLES, MARKDOWN).map(([name, text]) => ({
    name,
    text: text.trim()
  }));
  const workflows = filesIn(files, WORKFLOWS, JSON_EXTENSION).map(
    ([name, text]) => workflowFrom(name, text)
  );
  return { principles, stages, workflows, conductor: requiredFile(files, CONDUCTOR).trim() };
}

// ../core/src/agent.ts
var DEFAULT_MODEL = "default";
var AgentConfigError = class extends Error {
};
var AGENT_FIELDS = ["provider", "agent", "model"];
function parseAgentConfig(raw) {
  if (!isObject(raw)) throw new AgentConfigError("\u0430\u0433\u0435\u043D\u0442 \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u043C");
  const config = {};
  for (const field2 of AGENT_FIELDS) {
    const value = raw[field2];
    if (value === void 0) continue;
    if (!isLine(value)) throw new AgentConfigError(`${field2} \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043D\u0435\u043F\u0443\u0441\u0442\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439`);
    config[field2] = value;
  }
  return config;
}

// ../core/src/record.ts
var RECORD_VERSION = 1;
var FOREMAN = "foreman";
var INTERVENTION_REASONS = [
  "question",
  "plan_review",
  "rework_limit",
  "stop_gate"
];
var RecordError = class extends Error {
};
function isSpeaker(value) {
  return value === FOREMAN || isStage(value);
}
function isInterventionReason(value) {
  return INTERVENTION_REASONS.includes(value);
}
function isLines(value) {
  return Array.isArray(value) && value.every(isLine);
}
function isText(value) {
  return typeof value === "string" && value.trim() !== "";
}
var ID_PATTERN = /^[\w-]+$/;
function isRecordId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}
function isHarnessVersion(value) {
  return isLine(value);
}
var LEGACY_SESSION_LANGUAGE = "ru";
var LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}$/;
function isLanguageCode(value) {
  return typeof value === "string" && LANGUAGE_CODE_PATTERN.test(value);
}
function isInstant(value) {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}
function parsePrompt(raw, t, fail) {
  const { goal, requirements, model } = raw;
  if (!isLine(goal)) throw fail("goal \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043D\u0435\u043F\u0443\u0441\u0442\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439 \u0431\u0435\u0437 \u043F\u0435\u0440\u0435\u0432\u043E\u0434\u043E\u0432 \u0441\u0442\u0440\u043E\u043A\u0438");
  if (!isLines(requirements)) {
    throw fail("requirements \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C \u0441\u043F\u0438\u0441\u043A\u043E\u043C \u043D\u0435\u043F\u0443\u0441\u0442\u044B\u0445 \u0441\u0442\u0440\u043E\u043A \u0431\u0435\u0437 \u043F\u0435\u0440\u0435\u0432\u043E\u0434\u043E\u0432 \u0441\u0442\u0440\u043E\u043A\u0438");
  }
  const prompt = { t, type: "prompt", goal, requirements: [...requirements] };
  if (model === void 0) return prompt;
  if (!isLine(model)) throw fail("model \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u043D\u0435\u043F\u0443\u0441\u0442\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439 \u0431\u0435\u0437 \u043F\u0435\u0440\u0435\u0432\u043E\u0434\u043E\u0432 \u0441\u0442\u0440\u043E\u043A\u0438");
  return { ...prompt, model };
}
function parseMessage(raw, t, fail) {
  const { from, to, line, text } = raw;
  if (!isSpeaker(from)) throw fail(`\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u0433\u043E\u0432\u043E\u0440\u044F\u0449\u0438\u0439 ${String(from)}`);
  if (!isSpeaker(to)) throw fail(`\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u0430\u0434\u0440\u0435\u0441\u0430\u0442 ${String(to)}`);
  if (from === to) throw fail(`${from} \u043D\u0435 \u043C\u043E\u0436\u0435\u0442 \u0433\u043E\u0432\u043E\u0440\u0438\u0442\u044C \u0441\u0430\u043C \u0441 \u0441\u043E\u0431\u043E\u0439`);
  if (!isLine(line)) throw fail("line \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u043D\u0435\u043F\u0443\u0441\u0442\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439 \u0431\u0435\u0437 \u043F\u0435\u0440\u0435\u0432\u043E\u0434\u043E\u0432 \u0441\u0442\u0440\u043E\u043A\u0438");
  if (!isText(text)) throw fail("text \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043D\u0435\u043F\u0443\u0441\u0442\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439");
  return { t, type: "message", from, to, line, text };
}
function parseIntervention(raw, t, fail) {
  const { reason, line, text } = raw;
  if (!isInterventionReason(reason)) throw fail(`\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043F\u0440\u0438\u0447\u0438\u043D\u0430 ${String(reason)}`);
  if (!isLine(line)) throw fail("line \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u043D\u0435\u043F\u0443\u0441\u0442\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439 \u0431\u0435\u0437 \u043F\u0435\u0440\u0435\u0432\u043E\u0434\u043E\u0432 \u0441\u0442\u0440\u043E\u043A\u0438");
  if (!isText(text)) throw fail("text \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043D\u0435\u043F\u0443\u0441\u0442\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439");
  return { t, type: "intervention", reason, line, text };
}
function parseStageEnter(raw, t, fail) {
  if (!isStage(raw.stage)) throw fail(`\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u044D\u0442\u0430\u043F ${String(raw.stage)}`);
  return { t, type: "stage_enter", stage: raw.stage };
}
function parseStageFail(raw, t, fail) {
  if (!isStage(raw.stage)) throw fail(`\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u044D\u0442\u0430\u043F ${String(raw.stage)}`);
  if (typeof raw.reason !== "string") throw fail("\u043D\u0435\u0442 reason");
  return { t, type: "stage_fail", stage: raw.stage, reason: raw.reason };
}
function parseUsage(raw, t, fail) {
  if (typeof raw.tokens !== "number" || raw.tokens < 0) throw fail("\u043D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u043E\u0435 tokens");
  return { t, type: "usage", tokens: raw.tokens };
}
function parseBuildEnd(raw, t, fail) {
  if (typeof raw.ok !== "boolean") throw fail("\u043D\u0435\u0442 ok");
  return { t, type: "build_end", ok: raw.ok };
}
function isEventTime(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function parseSessionEvent(raw, index) {
  const fail = (why) => new RecordError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: ${why}`);
  if (!isObject(raw)) throw fail("\u043D\u0435 \u043E\u0431\u044A\u0435\u043A\u0442");
  const { t, type } = raw;
  if (!isEventTime(t)) throw fail("\u043D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u043E\u0435 \u0432\u0440\u0435\u043C\u044F t");
  switch (type) {
    case "build_start":
      return { t, type };
    case "prompt":
      return parsePrompt(raw, t, fail);
    case "message":
      return parseMessage(raw, t, fail);
    case "intervention":
      return parseIntervention(raw, t, fail);
    case "stage_enter":
      return parseStageEnter(raw, t, fail);
    case "stage_fail":
      return parseStageFail(raw, t, fail);
    case "usage":
      return parseUsage(raw, t, fail);
    case "build_end":
      return parseBuildEnd(raw, t, fail);
    default:
      throw fail(`\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u0442\u0438\u043F ${String(type)}`);
  }
}
function parseSource(raw) {
  if (!isObject(raw)) throw new RecordError("source \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u043C");
  switch (raw.type) {
    case "manual":
      return { type: "manual" };
    case "agent":
      if (!isLine(raw.provider)) throw new RecordError("\u0443 source \u043D\u0435\u0442 provider");
      if (!isLine(raw.agent)) throw new RecordError("\u0443 source \u043D\u0435\u0442 agent");
      return { type: "agent", provider: raw.provider, agent: raw.agent };
    default:
      throw new RecordError(`\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u0438\u0441\u0442\u043E\u0447\u043D\u0438\u043A ${String(raw.type)}`);
  }
}
function parseHeader(raw) {
  if (raw.version !== RECORD_VERSION) {
    throw new RecordError(`\u043D\u0435\u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u043C\u0430\u044F \u0432\u0435\u0440\u0441\u0438\u044F ${String(raw.version)}`);
  }
  if (!isRecordId(raw.id)) throw new RecordError("id \u0434\u043E\u043B\u0436\u0435\u043D \u0441\u043E\u0441\u0442\u043E\u044F\u0442\u044C \u0438\u0437 \u0431\u0443\u043A\u0432, \u0446\u0438\u0444\u0440, \xAB_\xBB \u0438 \xAB-\xBB");
  if (!isRecordId(raw.projectId)) {
    throw new RecordError("projectId \u0434\u043E\u043B\u0436\u0435\u043D \u0441\u043E\u0441\u0442\u043E\u044F\u0442\u044C \u0438\u0437 \u0431\u0443\u043A\u0432, \u0446\u0438\u0444\u0440, \xAB_\xBB \u0438 \xAB-\xBB");
  }
  if (!isInstant(raw.timestamp)) {
    throw new RecordError("timestamp \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u0432\u0440\u0435\u043C\u0435\u043D\u0435\u043C ISO 8601 \u043F\u043E UTC, \u043A\u0430\u043A \u0443 toISOString");
  }
  const header = {
    version: RECORD_VERSION,
    id: raw.id,
    timestamp: raw.timestamp,
    projectId: raw.projectId,
    source: parseSource(raw.source)
  };
  if (raw.sessionId === void 0) return header;
  if (!isLine(raw.sessionId)) throw new RecordError("sessionId \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043D\u0435\u043F\u0443\u0441\u0442\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439");
  return { ...header, sessionId: raw.sessionId };
}
function parseEvents(raw) {
  if (!Array.isArray(raw)) throw new RecordError("\u043D\u0435\u0442 events");
  const events = raw.map(parseSessionEvent);
  if (events[0]?.type !== "build_start") {
    throw new RecordError("\u0441\u0435\u0441\u0441\u0438\u044F \u0434\u043E\u043B\u0436\u043D\u0430 \u043D\u0430\u0447\u0438\u043D\u0430\u0442\u044C\u0441\u044F \u0441 build_start");
  }
  if (events.at(-1)?.type !== "build_end") {
    throw new RecordError("\u0441\u0435\u0441\u0441\u0438\u044F \u0434\u043E\u043B\u0436\u043D\u0430 \u0437\u0430\u043A\u0430\u043D\u0447\u0438\u0432\u0430\u0442\u044C\u0441\u044F build_end");
  }
  events.forEach((event, index) => {
    const previous = events[index - 1];
    if (previous !== void 0 && event.t < previous.t) {
      throw new RecordError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: \u0432\u0440\u0435\u043C\u044F \u0438\u0434\u0451\u0442 \u043D\u0430\u0437\u0430\u0434`);
    }
  });
  return events;
}
function parseSessionData(raw) {
  if (!isObject(raw)) throw new RecordError("data \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u043C");
  const { title, workflow, harness: harness2, language = LEGACY_SESSION_LANGUAGE } = raw;
  if (!isLine(title)) {
    throw new RecordError("title \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043D\u0435\u043F\u0443\u0441\u0442\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439 \u0431\u0435\u0437 \u043F\u0435\u0440\u0435\u0432\u043E\u0434\u043E\u0432 \u0441\u0442\u0440\u043E\u043A\u0438");
  }
  if (!isLanguageCode(language)) {
    throw new RecordError("language \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043A\u043E\u0434\u043E\u043C \u044F\u0437\u044B\u043A\u0430 ISO 639: ru, en");
  }
  if (!isLine(workflow)) throw new RecordError("workflow \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043D\u0435\u043F\u0443\u0441\u0442\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439");
  if (!isHarnessVersion(harness2)) {
    throw new RecordError("harness \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u043D\u0435\u043F\u0443\u0441\u0442\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439 \u0431\u0435\u0437 \u043F\u0435\u0440\u0435\u0432\u043E\u0434\u043E\u0432 \u0441\u0442\u0440\u043E\u043A\u0438");
  }
  return { title, language, workflow, harness: harness2, events: parseEvents(raw.events) };
}
function parseDecisionData(raw) {
  if (!isObject(raw)) throw new RecordError("data \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u043C");
  const { title, description } = raw;
  if (!isLine(title)) {
    throw new RecordError("title \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043D\u0435\u043F\u0443\u0441\u0442\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439 \u0431\u0435\u0437 \u043F\u0435\u0440\u0435\u0432\u043E\u0434\u043E\u0432 \u0441\u0442\u0440\u043E\u043A\u0438");
  }
  if (typeof description !== "string") throw new RecordError("description \u0434\u043E\u043B\u0436\u043D\u043E \u0431\u044B\u0442\u044C \u0441\u0442\u0440\u043E\u043A\u043E\u0439");
  return { title, description };
}
function parseNoteData(raw) {
  if (!isObject(raw)) throw new RecordError("data \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u043C");
  if (!isText(raw.text)) throw new RecordError("text \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043D\u0435\u043F\u0443\u0441\u0442\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439");
  return { text: raw.text };
}
function parseRecord(raw) {
  if (!isObject(raw)) throw new RecordError("\u0437\u0430\u043F\u0438\u0441\u044C \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u043C");
  const header = parseHeader(raw);
  switch (raw.type) {
    case "session":
      return { ...header, type: "session", data: parseSessionData(raw.data) };
    case "decision":
      return { ...header, type: "decision", data: parseDecisionData(raw.data) };
    case "note":
      return { ...header, type: "note", data: parseNoteData(raw.data) };
    default:
      throw new RecordError(`\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u0442\u0438\u043F \u0437\u0430\u043F\u0438\u0441\u0438 ${String(raw.type)}`);
  }
}

// ../core/src/project-config.ts
var ProjectConfigError = class extends Error {
};
function isLines2(value) {
  return Array.isArray(value) && value.every(isLine);
}
function parseAgents(raw) {
  if (raw === void 0) return {};
  if (!isObject(raw)) throw new ProjectConfigError("agents \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u043C");
  const agents = {};
  for (const [stage, agent] of Object.entries(raw)) {
    if (!isStage(stage)) throw new ProjectConfigError(`agents: \u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u044D\u0442\u0430\u043F ${stage}`);
    try {
      agents[stage] = parseAgentConfig(agent);
    } catch (err) {
      throw new ProjectConfigError(`agents.${stage}: ${err.message}`, { cause: err });
    }
  }
  return agents;
}
function parseVerification(raw) {
  if (raw === void 0) return { commands: [], paths: [] };
  if (!isObject(raw)) throw new ProjectConfigError("verification \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u043C");
  const { commands = [], paths = [] } = raw;
  if (!isLines2(commands)) {
    throw new ProjectConfigError("verification.commands \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C \u0441\u043F\u0438\u0441\u043A\u043E\u043C \u0441\u0442\u0440\u043E\u043A");
  }
  if (!isLines2(paths)) throw new ProjectConfigError("verification.paths \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C \u0441\u043F\u0438\u0441\u043A\u043E\u043C \u0441\u0442\u0440\u043E\u043A");
  return { commands: [...commands], paths: [...paths] };
}
function parseStack(raw) {
  if (raw === void 0) return void 0;
  if (!isObject(raw)) throw new ProjectConfigError("stack \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u043C");
  const { languages = [], frameworks = [], packageManager } = raw;
  if (!isLines2(languages) || !isLines2(frameworks)) {
    throw new ProjectConfigError("stack.languages \u0438 stack.frameworks \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C \u0441\u043F\u0438\u0441\u043A\u0430\u043C\u0438 \u0441\u0442\u0440\u043E\u043A");
  }
  const stack = { languages: [...languages], frameworks: [...frameworks] };
  if (packageManager === void 0) return stack;
  if (!isLine(packageManager)) throw new ProjectConfigError("stack.packageManager \u2014 \u0441\u0442\u0440\u043E\u043A\u0430");
  return { ...stack, packageManager };
}
function parseProjectConfig(raw) {
  if (!isObject(raw)) throw new ProjectConfigError("\u043A\u043E\u043D\u0444\u0438\u0433 \u043F\u0440\u043E\u0435\u043A\u0442\u0430 \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u043C");
  const { projectId, harness: harness2, workflow, journal } = raw;
  if (!isRecordId(projectId)) {
    throw new ProjectConfigError("projectId \u0434\u043E\u043B\u0436\u0435\u043D \u0441\u043E\u0441\u0442\u043E\u044F\u0442\u044C \u0438\u0437 \u0431\u0443\u043A\u0432, \u0446\u0438\u0444\u0440, \xAB_\xBB \u0438 \xAB-\xBB");
  }
  if (!isHarnessVersion(harness2)) throw new ProjectConfigError("harness \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u0441\u0442\u0440\u043E\u043A\u043E\u0439");
  if (!isLine(workflow)) throw new ProjectConfigError("workflow \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043D\u0435\u043F\u0443\u0441\u0442\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439");
  if (!isLine(journal)) throw new ProjectConfigError("journal \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043F\u0443\u0442\u0451\u043C \u043A \u043A\u0430\u0442\u0430\u043B\u043E\u0433\u0443");
  const config = {
    projectId,
    harness: harness2,
    workflow,
    journal,
    agents: parseAgents(raw.agents),
    verification: parseVerification(raw.verification)
  };
  const stack = parseStack(raw.stack);
  return stack === void 0 ? config : { ...config, stack };
}

// ../../adapters/claude/src/capture/leaks.ts
var LEAK_PATTERNS = [
  // Локальные 127.x и 0.0.0.0 не выдают ничего о серверах — пропускаем.
  { kind: "IP-\u0430\u0434\u0440\u0435\u0441", pattern: /\b(?!127\.|0\.0\.0\.0\b)\d{1,3}(?:\.\d{1,3}){3}\b/ },
  // Пустые группы — сокращённая запись `2001:db8::1`.
  { kind: "IPv6-\u0430\u0434\u0440\u0435\u0441", pattern: /\b(?:[\da-f]{0,4}:){3,7}[\da-f]{1,4}\b/i },
  // Домен верхнего уровня из букв: `vite@8.3.2` и `action@v4.6.0` — версии, а не адреса.
  { kind: "\u043F\u043E\u0447\u0442\u0430 \u0438\u043B\u0438 \u0430\u0434\u0440\u0435\u0441 \u0432\u0438\u0434\u0430 user@host", pattern: /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/i },
  {
    kind: "\u0432\u0445\u043E\u0434 \u043D\u0430 \u0441\u0435\u0440\u0432\u0435\u0440",
    pattern: /\b(?:root|admin|deploy|ubuntu|debian)@[\w.-]+/
  },
  {
    kind: "\u0442\u043E\u043A\u0435\u043D",
    pattern: /\b(?:gh[pousr]_|github_pat_|sk-|sk_live_|xox[abp]-|AKIA|AIza)[\w-]{8,}/
  },
  // У npm-токена ровно 36 знаков после префикса: `npm_config_store_dir` — переменная, не токен.
  { kind: "\u0442\u043E\u043A\u0435\u043D", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: "\u043F\u0430\u0440\u043E\u043B\u044C \u0432 \u0430\u0434\u0440\u0435\u0441\u0435", pattern: /\b[a-z][\w+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
  { kind: "JWT", pattern: /\beyJ[\w-]{8,}\.[\w-]{8,}\./ },
  { kind: "\u0437\u0430\u043A\u0440\u044B\u0442\u044B\u0439 \u043A\u043B\u044E\u0447", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // Путь в начале слова, а не часть адреса вроде `example.com/home/docs`.
  { kind: "\u043F\u0443\u0442\u044C \u0441 \u0438\u043C\u0435\u043D\u0435\u043C \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F", pattern: /(?<![\w.])\/(?:Users|home)\/[\w.-]+/ }
];
function findLeaks(text) {
  const kinds = LEAK_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ kind }) => kind);
  return [...new Set(kinds)];
}

// ../../adapters/claude/src/capture/draft.ts
var MESSAGE_SOURCES = ["assignment", "report", "answer"];
function isInterventionReason2(value) {
  return INTERVENTION_REASONS.includes(value);
}
function isMessageSource(value) {
  return MESSAGE_SOURCES.includes(value);
}
var DraftError = class extends Error {
};
var HEADER_FIELD_NAMES = {
  title: "\u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A",
  language: "\u044F\u0437\u044B\u043A",
  project: "\u043F\u0440\u043E\u0435\u043A\u0442",
  harness: "\u0432\u0435\u0440\u0441\u0438\u044F harness",
  workflow: "\u043F\u0440\u043E\u0446\u0435\u0441\u0441"
};
var CLAUDE_SOURCE = { type: "agent", provider: "anthropic", agent: "claude" };
function isObject2(value) {
  return typeof value === "object" && value !== null;
}
function isStrings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function parseDraftPrompt(raw, index) {
  const { t, said, goal, requirements, model, joined, build } = raw;
  if (typeof t !== "number" || typeof said !== "string" || typeof goal !== "string") {
    throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: \u0443 \u043F\u0440\u043E\u043C\u043F\u0442\u0430 \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C t, said \u0438 goal`);
  }
  if (!isStrings(requirements)) {
    throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: requirements \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C \u0441\u043F\u0438\u0441\u043A\u043E\u043C \u0441\u0442\u0440\u043E\u043A`);
  }
  if (model !== void 0 && typeof model !== "string") {
    throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: model \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u0441\u0442\u0440\u043E\u043A\u043E\u0439`);
  }
  if (joined !== void 0 && typeof joined !== "boolean") {
    throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: joined \u0434\u043E\u043B\u0436\u043D\u043E \u0431\u044B\u0442\u044C true \u0438\u043B\u0438 false`);
  }
  if (build !== void 0 && typeof build !== "string") {
    throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: build \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u0441\u0442\u0440\u043E\u043A\u043E\u0439`);
  }
  return {
    t,
    type: "draft_prompt",
    said,
    goal,
    requirements: [...requirements],
    ...model === void 0 ? {} : { model },
    ...joined === void 0 ? {} : { joined },
    ...build === void 0 ? {} : { build }
  };
}
function parseDraftMessage(raw, index) {
  const { t, from, to, source, said, line, text, run, build } = raw;
  if (typeof t !== "number" || typeof said !== "string") {
    throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: \u0443 \u0440\u0435\u043F\u043B\u0438\u043A\u0438 \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C t \u0438 said`);
  }
  if (!isSpeaker(from) || !isSpeaker(to)) {
    throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: \u0443 \u0440\u0435\u043F\u043B\u0438\u043A\u0438 \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C from \u0438 to`);
  }
  if (!isMessageSource(source)) {
    throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: \u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 source ${String(source)}`);
  }
  if (typeof line !== "string" || typeof text !== "string") {
    throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: line \u0438 text \u0440\u0435\u043F\u043B\u0438\u043A\u0438 \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C \u0441\u0442\u0440\u043E\u043A\u0430\u043C\u0438`);
  }
  if (run !== void 0 && typeof run !== "string") {
    throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: run \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u0441\u0442\u0440\u043E\u043A\u043E\u0439`);
  }
  if (build !== void 0 && typeof build !== "string") {
    throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: build \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u0441\u0442\u0440\u043E\u043A\u043E\u0439`);
  }
  return {
    t,
    type: "draft_message",
    from,
    to,
    source,
    said,
    line,
    text,
    ...run === void 0 ? {} : { run },
    ...build === void 0 ? {} : { build }
  };
}
function parseDraftIntervention(raw, index) {
  const { t, reason, said, line, text, build } = raw;
  if (typeof t !== "number" || typeof said !== "string") {
    throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: \u0443 \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u0430 \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C t \u0438 said`);
  }
  if (!isInterventionReason2(reason)) {
    throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: \u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043F\u0440\u0438\u0447\u0438\u043D\u0430 ${String(reason)}`);
  }
  if (typeof line !== "string" || typeof text !== "string") {
    throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: line \u0438 text \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u0430 \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C \u0441\u0442\u0440\u043E\u043A\u0430\u043C\u0438`);
  }
  if (build !== void 0 && typeof build !== "string") {
    throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: build \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u0441\u0442\u0440\u043E\u043A\u043E\u0439`);
  }
  return {
    t,
    type: "draft_intervention",
    reason,
    said,
    line,
    text,
    ...build === void 0 ? {} : { build }
  };
}
function parseDraftRun(raw, index) {
  const { t, run, agent, until } = raw;
  if (typeof t !== "number" || typeof run !== "string" || typeof agent !== "string") {
    throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: \u0443 \u0437\u0430\u043F\u0443\u0441\u043A\u0430 \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C t, run \u0438 agent`);
  }
  if (typeof until !== "number") {
    throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: until \u0437\u0430\u043F\u0443\u0441\u043A\u0430 \u0434\u043E\u043B\u0436\u043D\u043E \u0431\u044B\u0442\u044C \u0447\u0438\u0441\u043B\u043E\u043C`);
  }
  return { t, type: "draft_run", run, agent, until };
}
function parseDraftCheck(raw, index) {
  const { t, ok } = raw;
  if (typeof t !== "number" || typeof ok !== "boolean") {
    throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: \u0443 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C t \u0438 ok`);
  }
  return { t, type: "draft_check", ok, ...parseEventMarks(raw, index) };
}
function parseEventMarks(raw, index) {
  const { run, project } = isObject2(raw) ? raw : { run: void 0, project: void 0 };
  if (run !== void 0 && typeof run !== "string") {
    throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: run \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u0441\u0442\u0440\u043E\u043A\u043E\u0439`);
  }
  if (project !== void 0 && typeof project !== "string") {
    throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: project \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u0441\u0442\u0440\u043E\u043A\u043E\u0439`);
  }
  return {
    ...run === void 0 ? {} : { run },
    ...project === void 0 ? {} : { project }
  };
}
function parseDraftEvent(raw, index) {
  if (isObject2(raw)) {
    switch (raw.type) {
      case "draft_prompt":
        return parseDraftPrompt(raw, index);
      case "draft_message":
        return parseDraftMessage(raw, index);
      case "draft_intervention":
        return parseDraftIntervention(raw, index);
      case "draft_run":
        return parseDraftRun(raw, index);
      case "draft_check":
        return parseDraftCheck(raw, index);
    }
  }
  return { ...parseSessionEvent(raw, index), ...parseEventMarks(raw, index) };
}
function parseBuild(raw, index) {
  if (!isObject2(raw)) throw new DraftError(`\u0441\u0431\u043E\u0440\u043A\u0430 #${index}: \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u043C`);
  const { id, project, harness: harness2, workflow, title, language = "", runs } = raw;
  if (!isRecordId(id)) {
    throw new DraftError(`\u0441\u0431\u043E\u0440\u043A\u0430 #${index}: id \u0434\u043E\u043B\u0436\u0435\u043D \u0441\u043E\u0441\u0442\u043E\u044F\u0442\u044C \u0438\u0437 \u0431\u0443\u043A\u0432, \u0446\u0438\u0444\u0440, \xAB_\xBB \u0438 \xAB-\xBB`);
  }
  if (typeof project !== "string" || typeof harness2 !== "string" || typeof workflow !== "string" || typeof title !== "string" || typeof language !== "string") {
    throw new DraftError(
      `\u0441\u0431\u043E\u0440\u043A\u0430 ${id}: project, harness, workflow, title \u0438 language \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C \u0441\u0442\u0440\u043E\u043A\u0430\u043C\u0438`
    );
  }
  if (!isStrings(runs)) throw new DraftError(`\u0441\u0431\u043E\u0440\u043A\u0430 ${id}: runs \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C \u0441\u043F\u0438\u0441\u043A\u043E\u043C \u0441\u0442\u0440\u043E\u043A`);
  return { id, project, harness: harness2, workflow, title, language, runs: [...runs] };
}
function parseBuilds(raw) {
  if (!Array.isArray(raw.builds) || raw.builds.length === 0) {
    throw new DraftError("\u0443 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0430 \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u0445\u043E\u0442\u044F \u0431\u044B \u043E\u0434\u043D\u0430 \u0441\u0431\u043E\u0440\u043A\u0430 \u0432 builds");
  }
  return raw.builds.map(parseBuild);
}
function checkBuildIds(builds) {
  const seen = /* @__PURE__ */ new Set();
  for (const { id } of builds) {
    if (seen.has(id)) throw new DraftError(`\u0441\u0431\u043E\u0440\u043A\u0430 ${id} \u0443\u043A\u0430\u0437\u0430\u043D\u0430 \u0432 builds \u0434\u0432\u0430\u0436\u0434\u044B`);
    seen.add(id);
  }
}
function checkRunsAreUnique(builds) {
  const owners = /* @__PURE__ */ new Map();
  const claims = builds.flatMap((build) => build.runs.map((run) => ({ run, buildId: build.id })));
  for (const { run, buildId } of claims) {
    const owner = owners.get(run);
    if (owner !== void 0 && owner !== buildId) {
      throw new DraftError(`\u0437\u0430\u043F\u0443\u0441\u043A ${run} \u0443\u043A\u0430\u0437\u0430\u043D \u0432 \u0434\u0432\u0443\u0445 \u0441\u0431\u043E\u0440\u043A\u0430\u0445: ${owner} \u0438 ${buildId}`);
    }
    owners.set(run, buildId);
  }
}
function isEditable(event) {
  return event.type === "draft_prompt" || event.type === "draft_message" || event.type === "draft_intervention";
}
function checkEventBuilds(builds, events) {
  const known = new Set(builds.map(({ id }) => id));
  events.forEach((event, index) => {
    if (!isEditable(event)) return;
    if (event.build !== void 0 && !known.has(event.build)) {
      throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: \u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u0441\u0431\u043E\u0440\u043A\u0430 ${event.build}`);
    }
  });
}
function parseDraft(raw) {
  if (!isObject2(raw)) throw new DraftError("\u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u043C");
  const { id, startedAt, events } = raw;
  if (typeof id !== "string" || typeof startedAt !== "string") {
    throw new DraftError("\u0443 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0430 \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C id \u0438 startedAt");
  }
  const builds = parseBuilds(raw);
  checkBuildIds(builds);
  checkRunsAreUnique(builds);
  if (!Array.isArray(events)) throw new DraftError("\u0443 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0430 \u043D\u0435\u0442 events");
  const parsedEvents = events.map(parseDraftEvent);
  checkEventBuilds(builds, parsedEvents);
  return { id, startedAt, builds, events: parsedEvents };
}
function sameSaid(a, b) {
  return a.type === b.type && a.t === b.t && a.said === b.said;
}
function editableEventsOf(draft) {
  return draft.events.filter(isEditable);
}
function isEdited(event) {
  switch (event.type) {
    case "draft_prompt":
      return event.goal !== "" || event.requirements.length > 0 || event.joined === true || event.build !== void 0;
    case "draft_message":
    case "draft_intervention":
      return event.line !== "" || event.text !== "" || event.build !== void 0;
    default:
      return event;
  }
}
function editedEventsOf(draft) {
  return editableEventsOf(draft).filter(isEdited);
}
function filledOr(earlier, fresh) {
  return earlier === "" ? fresh : earlier;
}
function buildMark(earlier) {
  return earlier.build === void 0 ? {} : { build: earlier.build };
}
function carryOverPrompt(earlier, fresh) {
  const model = fresh.model ?? earlier.model;
  return {
    ...fresh,
    goal: earlier.goal,
    requirements: [...earlier.requirements],
    ...model === void 0 ? {} : { model },
    ...earlier.joined === void 0 ? {} : { joined: earlier.joined },
    ...buildMark(earlier)
  };
}
function carryOverMessage(earlier, fresh) {
  return { ...fresh, line: earlier.line, text: earlier.text, ...buildMark(earlier) };
}
function carryOverIntervention(earlier, fresh) {
  return { ...fresh, line: earlier.line, text: earlier.text, ...buildMark(earlier) };
}
function carryOverEvent(event, edited) {
  if (!isEditable(event)) return event;
  const earlier = edited.find((candidate) => sameSaid(candidate, event));
  if (earlier === void 0) return event;
  if (event.type === "draft_prompt" && earlier.type === "draft_prompt") {
    return carryOverPrompt(earlier, event);
  }
  if (event.type === "draft_message" && earlier.type === "draft_message") {
    return carryOverMessage(earlier, event);
  }
  if (event.type === "draft_intervention" && earlier.type === "draft_intervention") {
    return carryOverIntervention(earlier, event);
  }
  return event;
}
function carryOverBuilds(previous, next) {
  const fresh = next.builds[0];
  return previous.builds.map(
    (build) => fresh?.id === build.id ? {
      ...build,
      project: filledOr(build.project, fresh.project),
      harness: filledOr(build.harness, fresh.harness),
      workflow: filledOr(build.workflow, fresh.workflow)
    } : build
  );
}
function carryOverEdits(previous, next) {
  const edited = editedEventsOf(previous);
  const events = next.events.map((event) => carryOverEvent(event, edited));
  return { ...next, builds: carryOverBuilds(previous, next), events };
}
function unfilledHeader(draft) {
  const fields = Object.keys(HEADER_FIELD_NAMES);
  return draft.builds.flatMap((build) => {
    const names = fields.filter((field2) => build[field2] === "").map((f) => HEADER_FIELD_NAMES[f]);
    return names.length === 0 ? [] : [`\u0441\u0431\u043E\u0440\u043A\u0430 ${build.id}: ${names.join(", ")}`];
  });
}
function orphanedEdits(previous, next) {
  const nextEvents = editableEventsOf(next);
  return editedEventsOf(previous).filter(
    (event) => !nextEvents.some((candidate) => sameSaid(event, candidate))
  );
}
function orphanedRuns(draft) {
  const runs = draft.events.flatMap((event) => event.type === "draft_run" ? [event.run] : []);
  const known = new Set(runs);
  return draft.builds.flatMap((build) => build.runs).filter((run) => !known.has(run));
}
function reroutedMessages(previous, next) {
  const earlier = previous.events.filter((event) => event.type === "draft_message");
  return next.events.flatMap((event) => {
    if (event.type !== "draft_message" || event.line === "") return [];
    const was = earlier.find((candidate) => sameSaid(candidate, event));
    return was !== void 0 && (was.from !== event.from || was.to !== event.to) ? [event] : [];
  });
}
function toPublishedPrompt(prompt, t) {
  const { goal, requirements, model } = prompt;
  return { t, type: "prompt", goal, requirements, ...model === void 0 ? {} : { model } };
}
function toPublishedIntervention(intervention, t) {
  const { reason, line, text } = intervention;
  return { t, type: "intervention", reason, line, text };
}
function toPublishedMessage(message, t) {
  const { from, to, line, text } = message;
  return { t, type: "message", from, to, line, text };
}
function toPublishedEvents(events, at) {
  const published = [];
  let hasPrompt = false;
  let currentStage;
  events.forEach((event, index) => {
    switch (event.type) {
      case "draft_prompt":
        if (event.joined !== true) {
          hasPrompt = true;
          published.push(toPublishedPrompt(event, at(event.t)));
        } else if (!hasPrompt) {
          throw new DraftError(`\u0441\u043E\u0431\u044B\u0442\u0438\u0435 #${index}: \u0441\u043A\u043B\u0435\u0435\u043D\u043D\u043E\u043C\u0443 \u043F\u0440\u043E\u043C\u043F\u0442\u0443 \u043D\u0435\u0442 \u043F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0435\u0433\u043E \u043F\u0440\u043E\u043C\u043F\u0442\u0430`);
        }
        return;
      case "prompt":
        hasPrompt = true;
        published.push(toPublishedPrompt(event, at(event.t)));
        return;
      case "draft_message":
      case "message":
        published.push(toPublishedMessage(event, at(event.t)));
        return;
      case "draft_intervention":
      case "intervention":
        published.push(toPublishedIntervention(event, at(event.t)));
        return;
      case "stage_enter":
        if (event.stage === currentStage) return;
        currentStage = event.stage;
        published.push({ t: at(event.t), type: "stage_enter", stage: event.stage });
        return;
      case "stage_fail":
        published.push({
          t: at(event.t),
          type: "stage_fail",
          stage: event.stage,
          reason: event.reason
        });
        return;
      case "draft_run":
      case "draft_check":
      case "build_start":
      case "build_end":
      case "usage":
        return;
      default:
        return event;
    }
  });
  return published;
}
function textsOf(event) {
  switch (event.type) {
    case "prompt":
      return [
        event.goal,
        ...event.requirements,
        ...event.model === void 0 ? [] : [event.model]
      ];
    case "stage_fail":
      return [event.reason];
    case "message":
    case "intervention":
      return [event.line, event.text];
    case "build_start":
    case "stage_enter":
    case "usage":
    case "build_end":
      return [];
    default:
      return event;
  }
}
function checksPassed(events) {
  return events.findLast((event) => event.type === "draft_check")?.ok ?? true;
}
function totalTokens(events) {
  const usages = events.filter((event) => event.type === "usage");
  return usages.length === 0 ? void 0 : usages.reduce((sum, { tokens }) => sum + tokens, 0);
}
function buildOf(draft, buildId) {
  const build = draft.builds.find(({ id }) => id === buildId);
  if (build === void 0) throw new DraftError(`\u0432 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0435 \u043D\u0435\u0442 \u0441\u0431\u043E\u0440\u043A\u0438 ${buildId}`);
  return build;
}
function checkNoLeaks({ data }, buildId) {
  const texts = [data.title, data.harness, data.workflow, ...data.events.flatMap(textsOf)];
  const leaks = texts.flatMap((text) => findLeaks(text).map((kind) => `${kind} \u0432 \xAB${text}\xBB`));
  if (leaks.length > 0) {
    throw new DraftError(
      `\u0432 \u0442\u0435\u043A\u0441\u0442\u0435 \u0434\u043B\u044F \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438 \u0441\u0431\u043E\u0440\u043A\u0438 ${buildId} \u0435\u0441\u0442\u044C \u0442\u043E, \u0447\u0442\u043E \u043D\u0435\u043B\u044C\u0437\u044F \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0442\u044C: ${leaks.join("; ")}`
    );
  }
}
function publishBuild(draft, buildId) {
  const build = buildOf(draft, buildId);
  const owners = eventBuilds(draft);
  const events = draft.events.filter((_event, index) => owners[index] === buildId);
  const timeline = buildTimeline(events);
  if (timeline === void 0) throw new DraftError(`\u0432 \u0441\u0431\u043E\u0440\u043A\u0435 ${buildId} \u043D\u0435\u0442 \u0441\u043E\u0431\u044B\u0442\u0438\u0439`);
  const tokens = totalTokens(events);
  const usage2 = tokens === void 0 ? [] : [{ t: timeline.end, type: "usage", tokens }];
  const published = [
    { t: 0, type: "build_start" },
    ...toPublishedEvents(events, timeline.at),
    ...usage2,
    { t: timeline.end, type: "build_end", ok: checksPassed(events) }
  ];
  const record = parseRecord({
    version: RECORD_VERSION,
    type: "session",
    id: build.id,
    timestamp: new Date(Date.parse(draft.startedAt) + timeline.start).toISOString(),
    projectId: build.project,
    source: CLAUDE_SOURCE,
    data: {
      title: build.title,
      language: build.language,
      workflow: build.workflow,
      harness: build.harness,
      events: published
    }
  });
  if (record.type !== "session") {
    throw new DraftError(`\u0441\u0431\u043E\u0440\u043A\u0430 ${buildId} \u043E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u043B\u0430\u0441\u044C \u043D\u0435 \u0441\u0435\u0441\u0441\u0438\u0435\u0439`);
  }
  checkNoLeaks(record, buildId);
  return record;
}

// ../../adapters/claude/src/capture/raw-event.ts
var RawLogError = class extends Error {
};
var MAX_COMMAND_LENGTH = 200;
var UNKNOWN = "unknown";
var MAX_VERDICT_LENGTH = 40;
var VERDICT_MARKUP = /[*_`#]/g;
var TRAILING_PUNCTUATION = /[.:!]+$/;
var HARNESS_NOTE_START = "[";
var SUBAGENT_REPORT = /^<agent-message from="([^"]+)">\s*\[Subagent hand-back\]/;
var REPORT_START = "The report follows:";
var SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
var QUESTION_TOOL = "AskUserQuestion";
var ANSWER_SEPARATOR = " \u2014 ";
function isPayload(value) {
  return typeof value === "object" && value !== null;
}
function stringField(payload, key) {
  const value = payload[key];
  return typeof value === "string" ? value : void 0;
}
function toolEvent(payload, ts, ok) {
  const input = isPayload(payload.tool_input) ? payload.tool_input : {};
  const command = stringField(input, "command");
  return withOptional(
    {
      ts,
      kind: "tool",
      tool: stringField(payload, "tool_name") ?? UNKNOWN,
      ok
    },
    {
      command: command?.slice(0, MAX_COMMAND_LENGTH),
      file: stringField(input, "file_path") ?? stringField(input, "notebook_path"),
      cwd: stringField(payload, "cwd"),
      agentId: stringField(payload, "agent_id")
    }
  );
}
function answersOf(payload) {
  for (const source of [payload.tool_response, payload.tool_input]) {
    const answers = isPayload(source) ? source.answers : void 0;
    if (!isPayload(answers)) continue;
    const pairs = Object.entries(answers).filter(
      (pair) => typeof pair[1] === "string" && pair[1].trim() !== ""
    );
    if (pairs.length > 0) return pairs;
  }
  return [];
}
function questionAnswerEvent(payload, ts) {
  if (stringField(payload, "tool_name") !== QUESTION_TOOL) return void 0;
  const answers = answersOf(payload);
  if (answers.length === 0) return void 0;
  const text = answers.map(([question, answer]) => `${question}${ANSWER_SEPARATOR}${answer}`);
  return withOptional(
    { ts, kind: "question_answer", text: text.join("\n") },
    { agentId: stringField(payload, "agent_id") }
  );
}
function withoutVerdictMarkup(line) {
  return line.replace(VERDICT_MARKUP, "").trim().replace(TRAILING_PUNCTUATION, "");
}
function verdictOf(reply) {
  const lines = reply?.split("\n").map(withoutVerdictMarkup);
  const firstLine = lines?.find((line) => line !== "" && !line.startsWith(HARNESS_NOTE_START));
  return firstLine !== void 0 && firstLine.length <= MAX_VERDICT_LENGTH ? firstLine : void 0;
}
function agentName(payload) {
  return stringField(payload, "agent_type") || UNKNOWN;
}
function withOptional(event, fields) {
  const present = Object.entries(fields).filter(([, value]) => value !== void 0);
  return { ...event, ...Object.fromEntries(present) };
}
function subagentReport(text, ts) {
  const agentId = SUBAGENT_REPORT.exec(text)?.[1];
  if (agentId === void 0) return void 0;
  const reportStart = text.indexOf(REPORT_START);
  const report = reportStart === -1 ? void 0 : text.slice(reportStart + REPORT_START.length);
  return withOptional(
    { ts, kind: "subagent_report", agentId },
    { verdict: verdictOf(report) }
  );
}
function fromHookPayload(payload, ts) {
  if (!isPayload(payload)) return null;
  switch (stringField(payload, "hook_event_name")) {
    case "SessionStart":
      return { ts, kind: "session_start" };
    case "UserPromptSubmit": {
      const text = stringField(payload, "prompt");
      if (text === void 0) return null;
      return subagentReport(text, ts) ?? { ts, kind: "prompt", text };
    }
    case "PostToolUse":
      return questionAnswerEvent(payload, ts) ?? toolEvent(payload, ts, true);
    case "PostToolUseFailure":
      return toolEvent(payload, ts, false);
    case "SubagentStart":
      return withOptional(
        { ts, kind: "subagent_start", agent: agentName(payload) },
        { agentId: stringField(payload, "agent_id") }
      );
    case "SubagentStop":
      return withOptional(
        { ts, kind: "subagent_stop", agent: agentName(payload) },
        {
          agentId: stringField(payload, "agent_id"),
          transcriptPath: stringField(payload, "agent_transcript_path"),
          verdict: verdictOf(stringField(payload, "last_assistant_message"))
        }
      );
    case "Stop":
      return withOptional(
        { ts, kind: "stop" },
        { transcriptPath: stringField(payload, "transcript_path") }
      );
    default:
      return null;
  }
}
function stampProject(event, config) {
  return {
    ...event,
    project: config.projectId,
    harness: config.harness,
    workflow: config.workflow
  };
}
function markAfterStopGate(event) {
  return { ...event, afterStopGate: true };
}
function isSafeSessionId(value) {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}
function isUnstamped(value) {
  return value.project === void 0 && value.harness === void 0 && value.workflow === void 0;
}
function isStamped(value) {
  return typeof value.project === "string" && typeof value.harness === "string" && typeof value.workflow === "string";
}
var RAW_EVENT_SHAPES = {
  session_start: (value) => isUnstamped(value) || isStamped(value),
  prompt: (value) => typeof value.text === "string" && (value.afterStopGate === void 0 || value.afterStopGate === true),
  question_answer: (value) => typeof value.text === "string",
  tool: (value) => typeof value.tool === "string" && typeof value.ok === "boolean",
  subagent_start: (value) => typeof value.agent === "string",
  subagent_stop: (value) => typeof value.agent === "string",
  subagent_report: (value) => typeof value.agentId === "string",
  stop: () => true
};
function isRawEventKind(kind) {
  return Object.hasOwn(RAW_EVENT_SHAPES, kind);
}
function isRawEvent(value) {
  if (!isPayload(value) || typeof value.ts !== "number" || typeof value.kind !== "string") {
    return false;
  }
  return isRawEventKind(value.kind) && RAW_EVENT_SHAPES[value.kind](value);
}
function parseRawLog(content) {
  const events = [];
  content.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRawEvent(value)) throw new RawLogError(`\u0441\u0442\u0440\u043E\u043A\u0430 ${index + 1}: \u043D\u0435 \u0441\u043E\u0431\u044B\u0442\u0438\u0435 \u0436\u0443\u0440\u043D\u0430\u043B\u0430`);
    events.push(value);
  });
  return events;
}

// ../../adapters/claude/src/capture/to-draft.ts
import path from "node:path";
var TOOL_STAGES = {
  Edit: "implementation",
  Write: "implementation",
  MultiEdit: "implementation",
  NotebookEdit: "implementation",
  ExitPlanMode: "planning"
};
var PATH_ARGUMENT = String.raw`"[^"]*"|'[^']*'|\S+`;
var COMMAND_STAGES = [
  { pattern: /^make check\b/, stage: "verification" },
  { pattern: /^pnpm (?:-r |--filter \S+ )?(?:run )?(?:check|test|lint)\b/, stage: "verification" },
  {
    pattern: /^(?:pnpm exec |npx )?(?:vitest|eslint|prettier --check)(?:\s|$)/,
    stage: "verification"
  },
  { pattern: /^go test\b/, stage: "verification" },
  { pattern: /^golangci-lint run\b/, stage: "verification" },
  { pattern: /^node --test\b/, stage: "verification" },
  { pattern: new RegExp(`^git (?:-C (?:${PATH_ARGUMENT}) )?(?:commit|push)\\b`), stage: "record" }
];
var COMMAND_SEPARATOR = /\s*(?:&&|\|\||;|\||\n)\s*/;
var LEADING_ENV_ASSIGNMENTS = /^(?:\w+=\S*\s+)*/;
var CHANGE_DIRECTORY = /^cd(?:\s|$)/;
var CHANGE_DIRECTORY_TARGET = new RegExp(`^cd\\s+(${PATH_ARGUMENT})$`);
var UNTRACKABLE_DIRECTORY_CHANGE = /^(?:\(|(?:pushd|\{|then|do|else|command\s+cd)(?:\s|$))/;
var GIT_DIRECTORY_TARGET = new RegExp(`^git -C (${PATH_ARGUMENT})\\s`);
var UNRESOLVABLE_DIRECTORY = /[~$`]/;
var LEFTOVER_QUOTING = /["'\\]/;
var QUOTED_TEXT = String.raw`'[^']*'|"(?:[^"\\$]|\\.|\$\([^()"]*\)|\$(?!\())*"|\\.`;
var HEREDOC_START_OR_QUOTED_TEXT = new RegExp(
  String.raw`(?<!<)<<(?!<)(-?)\s*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|\\?([A-Za-z_]\w*))|${QUOTED_TEXT}`,
  "g"
);
var LEADING_TABS = /^\t+/;
var PREVIOUS_DIRECTORY = "-";
var PARENT_SEGMENT = "..";
var SURROUNDING_QUOTES = /^(["'])(.*)\1$/;
var AGENT_STAGES = {
  Plan: "planning",
  analyst: "planning",
  coder: "implementation",
  tester: "verification",
  reviewer: "review"
};
var VERDICTS = {
  tester: {
    "\u041F\u0420\u041E\u0412\u0415\u0420\u041A\u0418 \u041F\u0420\u041E\u0419\u0414\u0415\u041D\u042B": { passed: true },
    \u0413\u041E\u0422\u041E\u0412\u041E: { passed: true },
    \u0414\u0415\u0424\u0415\u041A\u0422: { passed: false, reason: "\u0442\u0435\u0441\u0442\u0438\u0440\u043E\u0432\u0449\u0438\u043A \u043D\u0430\u0448\u0451\u043B \u0434\u0435\u0444\u0435\u043A\u0442" }
  },
  reviewer: {
    \u041F\u0420\u0418\u041D\u042F\u0422\u041E: { passed: true },
    "\u041D\u0410 \u0414\u041E\u0420\u0410\u0411\u041E\u0422\u041A\u0423": { passed: false, reason: "\u0440\u0435\u0432\u044C\u044E \u0432\u0435\u0440\u043D\u0443\u043B\u043E \u043D\u0430 \u0434\u043E\u0440\u0430\u0431\u043E\u0442\u043A\u0443" }
  }
};
var AGENT_HUMAN_CALLS = {
  analyst: "plan_review"
};
var REWORK_CALL = "rework_limit";
var ANSWER_CALL = "question";
var STOP_GATE_CALL = "stop_gate";
var SERVICE_MESSAGE_PREFIXES = [
  "[Subagent hand-back]",
  "[SYSTEM NOTIFICATION",
  "<task-notification>",
  "<agent-message",
  "<system-reminder>"
];
var SHORT_SESSION_LENGTH = 8;
var ISO_DATE_LENGTH = 10;
var TEST_FAILURE_REASON = "\u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u043D\u0435 \u043F\u0440\u043E\u0448\u043B\u0438";
var BEFORE_FIRST_ANCHOR = -1;
function stageOfAgent(agent) {
  return agent !== void 0 && Object.hasOwn(AGENT_STAGES, agent) ? AGENT_STAGES[agent] : void 0;
}
function modelAnswering(replies, promptTs) {
  return replies.find((reply) => reply.ts >= promptTs)?.model;
}
var SESSION_PLACE = { in: "session" };
var UNKNOWN_PLACE = { in: "unknown" };
function withoutQuotes(word) {
  return SURROUNDING_QUOTES.exec(word)?.[2] ?? word;
}
function placeAfterMove(place, directory) {
  const isUnresolvable = directory === "" || directory === PREVIOUS_DIRECTORY || UNRESOLVABLE_DIRECTORY.test(directory);
  if (isUnresolvable) return UNKNOWN_PLACE;
  if (path.posix.isAbsolute(directory)) {
    return { in: "directory", directory: path.posix.resolve(directory) };
  }
  switch (place.in) {
    case "directory":
      return { in: "directory", directory: path.posix.resolve(place.directory, directory) };
    case "session":
      return directory.split("/").includes(PARENT_SEGMENT) ? UNKNOWN_PLACE : SESSION_PLACE;
    case "unknown":
      return UNKNOWN_PLACE;
    default:
      return place;
  }
}
function placeAfterShellMove(place, word) {
  const directory = withoutQuotes(word);
  return LEFTOVER_QUOTING.test(directory) ? UNKNOWN_PLACE : placeAfterMove(place, directory);
}
function startPlaceOf(cwd) {
  return cwd === void 0 ? SESSION_PLACE : placeAfterMove(UNKNOWN_PLACE, cwd);
}
function placeAfterChangeDirectory(program, place) {
  const target = CHANGE_DIRECTORY_TARGET.exec(program)?.[1];
  return target === void 0 ? UNKNOWN_PLACE : placeAfterShellMove(place, target);
}
function placeOfProgram(program, place) {
  const target = GIT_DIRECTORY_TARGET.exec(program)?.[1];
  return target === void 0 ? place : placeAfterShellMove(place, target);
}
function heredocsStartedBy(line) {
  return [...line.matchAll(HEREDOC_START_OR_QUOTED_TEXT)].flatMap(
    ([, dash, single, double, bare]) => {
      const delimiter = single ?? double ?? bare;
      return delimiter === void 0 ? [] : [{ delimiter, indented: dash === "-" }];
    }
  );
}
function endsHeredoc(line, end) {
  return (end.indented ? line.replace(LEADING_TABS, "") : line) === end.delimiter;
}
function withoutHeredocBodies(command) {
  const kept = [];
  const awaited = [];
  for (const line of command.split("\n")) {
    const [end] = awaited;
    const isHeredocBody = end !== void 0;
    if (end !== void 0 && endsHeredoc(line, end)) awaited.shift();
    if (isHeredocBody) continue;
    kept.push(line);
    awaited.push(...heredocsStartedBy(line));
  }
  return kept.join("\n");
}
function stagesOfCommand(command, start) {
  const placed = [];
  let place = start;
  for (const segment of withoutHeredocBodies(command).split(COMMAND_SEPARATOR)) {
    const program = segment.trim().replace(LEADING_ENV_ASSIGNMENTS, "");
    if (UNTRACKABLE_DIRECTORY_CHANGE.test(program)) {
      place = UNKNOWN_PLACE;
      continue;
    }
    if (CHANGE_DIRECTORY.test(program)) {
      place = placeAfterChangeDirectory(program, place);
      continue;
    }
    const rule = COMMAND_STAGES.find(({ pattern }) => pattern.test(program));
    if (rule !== void 0) {
      placed.push({ stage: rule.stage, place: placeOfProgram(program, place) });
    }
  }
  return placed;
}
function stagesReachedByTool(event) {
  const start = startPlaceOf(event.cwd);
  const byTool = TOOL_STAGES[event.tool];
  if (byTool !== void 0) {
    const place = event.file === void 0 ? start : placeAfterMove(start, path.posix.dirname(event.file));
    return [{ stage: byTool, place }];
  }
  if (event.tool !== "Bash" || event.command === void 0) return [];
  const stages = stagesOfCommand(event.command, start);
  return event.ok ? stages : stages.slice(0, 1);
}
function isHumanPrompt(text) {
  const start = text.trimStart();
  return !SERVICE_MESSAGE_PREFIXES.some((prefix) => start.startsWith(prefix));
}
function humanCallOfAgent(agent) {
  return Object.hasOwn(AGENT_HUMAN_CALLS, agent) ? AGENT_HUMAN_CALLS[agent] : void 0;
}
function verdictFor(agent, line) {
  if (line === void 0 || !Object.hasOwn(VERDICTS, agent)) return void 0;
  const verdicts = VERDICTS[agent];
  return verdicts !== void 0 && Object.hasOwn(verdicts, line) ? verdicts[line] : void 0;
}
function agentWindowKey(event) {
  return event.agentId ?? event.agent;
}
function stationWindows() {
  const running = /* @__PURE__ */ new Set();
  return {
    observe(event) {
      switch (event.kind) {
        case "subagent_start":
          if (stageOfAgent(event.agent) === void 0) return false;
          running.add(agentWindowKey(event));
          return true;
        case "subagent_stop":
          return running.delete(agentWindowKey(event));
        default:
          return false;
      }
    },
    isStationCall(event) {
      if (event.agentId !== void 0) return running.has(event.agentId);
      if (event.cwd !== void 0) return false;
      return running.size > 0;
    }
  };
}
function stageAt(events, t) {
  let stage = STAGES[0];
  for (const event of events) {
    if (event.t > t) break;
    if (event.type === "stage_enter") stage = event.stage;
  }
  return stage;
}
function agentsByIdOf(events) {
  const agents = /* @__PURE__ */ new Map();
  for (const event of events) {
    if (event.kind === "subagent_start" && event.agentId !== void 0) {
      agents.set(event.agentId, event.agent);
    }
  }
  return agents;
}
function runMark(run) {
  return run === void 0 ? {} : { run };
}
function messageOfRemark({ kind, t, stage, said, run }) {
  return {
    t,
    type: "draft_message",
    from: stage,
    to: FOREMAN,
    source: kind,
    said,
    line: "",
    text: "",
    ...runMark(run)
  };
}
function assignmentRemarks(assignments, agentsById, at) {
  return assignments.flatMap((assignment) => {
    const agent = assignment.via === "spawn" ? assignment.agentType : agentsById.get(assignment.agentId);
    const stage = stageOfAgent(agent);
    return stage === void 0 ? [] : [
      {
        kind: "assignment",
        t: at(assignment.ts),
        stage,
        said: assignment.text,
        ...runMark(assignment.agentId)
      }
    ];
  });
}
function reportRemarks(reports, agentsById, at) {
  return reports.flatMap((report) => {
    const stage = stageOfAgent(agentsById.get(report.agentId));
    return stage === void 0 ? [] : [{ kind: "report", t: at(report.ts), stage, said: report.text, run: report.agentId }];
  });
}
function turnsOf(events) {
  const starts = events.filter((event) => event.kind === "prompt" && isHumanPrompt(event.text)).map((event) => event.ts);
  return starts.map((from, index) => ({ from, to: starts[index + 1] ?? Number.POSITIVE_INFINITY }));
}
function answerRemarks(events, answers, stageOnTime, at) {
  return turnsOf(events).flatMap((turn) => {
    const answer = answers.findLast(({ ts }) => ts >= turn.from && ts < turn.to);
    if (answer === void 0) return [];
    const t = at(answer.ts);
    return [{ kind: "answer", t, stage: stageOnTime(t), said: answer.text }];
  });
}
function recipientOfReport(remarks, index, stage) {
  for (const next of remarks.slice(index + 1)) {
    if (next.kind === "answer") return FOREMAN;
    if (next.kind === "assignment" && next.stage !== stage) return next.stage;
  }
  return FOREMAN;
}
function giverOfAssignment(remarks, index, stage) {
  const report = remarks.slice(0, index).findLast((previous) => previous.kind === "report" && previous.stage !== stage);
  return report?.stage ?? FOREMAN;
}
function routeOf(remark, remarks, index) {
  const { kind, stage } = remark;
  switch (kind) {
    case "assignment":
      return { from: stage, to: giverOfAssignment(remarks, index, stage) };
    case "report":
      return { from: stage, to: recipientOfReport(remarks, index, stage) };
    case "answer":
      return { from: stage, to: FOREMAN };
    default:
      return kind;
  }
}
function startsTurn(event) {
  return event.type === "draft_prompt" || event.type === "draft_intervention" && event.reason !== ANSWER_CALL;
}
function splitIntoTurns(items, promptTimes) {
  const turns = [[], ...promptTimes.map(() => [])];
  for (const item of items) {
    const turn = promptTimes.filter((promptTime) => promptTime <= item.remark.t).length;
    turns[turn]?.push(item);
  }
  return turns;
}
function mergeMessages(events, messages) {
  const merged = [];
  let pending = [...messages].sort((a, b) => a.t - b.t);
  for (const event of events) {
    const earlier = pending.filter((message) => message.t < event.t);
    merged.push(...earlier, event);
    pending = pending.slice(earlier.length);
  }
  return [...merged, ...pending];
}
function remarkOfMessage(message, buildEvents) {
  const { source, t, from, said } = message;
  return {
    kind: source,
    t,
    said,
    stage: source === "answer" ? stageAt(buildEvents, t) : stageOfSpeaker(from)
  };
}
function stageOfSpeaker(speaker) {
  return speaker === FOREMAN ? STAGES[0] : speaker;
}
function routeMessages(draft) {
  const owners = eventBuilds(draft);
  const events = [...draft.events];
  for (const build of draft.builds) {
    for (const { index, message } of routedMessagesOfBuild(draft, owners, build.id)) {
      events[index] = message;
    }
  }
  return { ...draft, events };
}
function routedMessagesOfBuild(draft, owners, buildId) {
  const own = draft.events.flatMap(
    (event, index) => owners[index] === buildId ? [{ event, index }] : []
  );
  const buildEvents = own.map(({ event }) => event);
  const promptTimes = buildEvents.flatMap((event) => startsTurn(event) ? [event.t] : []);
  const spoken = own.flatMap(
    ({ event, index }) => event.type === "draft_message" ? [{ message: event, index, remark: remarkOfMessage(event, buildEvents) }] : []
  );
  return splitIntoTurns(spoken, promptTimes).flatMap((turn) => {
    const remarks = turn.map(({ remark }) => remark);
    return turn.map(({ message, index, remark }, position) => ({
      index,
      message: { ...message, ...routeOf(remark, remarks, position) }
    }));
  });
}
function projectOf(events) {
  for (const event of events) {
    if (event.kind !== "session_start") continue;
    const { project, harness: harness2, workflow } = event;
    if (project !== void 0 && harness2 !== void 0 && workflow !== void 0) {
      return { project, harness: harness2, workflow };
    }
  }
  return { project: "", harness: "", workflow: "" };
}
function projectOfPlace(place, sessionProject, projectsByDirectory) {
  switch (place.in) {
    case "directory":
      return projectsByDirectory?.get(place.directory);
    case "session":
      return sessionProject === "" ? void 0 : sessionProject;
    case "unknown":
      return void 0;
    default:
      return place;
  }
}
function directoryOutsideProjects(place, projectsByDirectory) {
  if (place.in !== "directory" || projectsByDirectory === void 0) return void 0;
  return projectsByDirectory.has(place.directory) ? void 0 : place.directory;
}
function projectMark(project) {
  return project === void 0 ? {} : { project };
}
function isBuildAnchor(event) {
  return event.type === "draft_prompt" || event.type === "draft_intervention" || event.run !== void 0;
}
function draftIntervention(t, reason, said) {
  return { t, type: "draft_intervention", reason, said, line: "", text: "" };
}
function withSessionUsages(events, usages) {
  const anchors = events.flatMap(
    (event, index) => isBuildAnchor(event) ? [{ t: event.t, index }] : []
  );
  const sums = /* @__PURE__ */ new Map();
  for (const { ts, tokens } of usages) {
    const anchor = anchors.findLast((candidate) => candidate.t <= ts);
    const key = anchor?.index ?? BEFORE_FIRST_ANCHOR;
    const sum = sums.get(key);
    sums.set(key, { t: anchor?.t ?? 0, tokens: (sum?.tokens ?? 0) + tokens });
  }
  const toEvent = (sum) => sum === void 0 ? [] : [{ t: sum.t, type: "usage", tokens: sum.tokens }];
  return [
    ...toEvent(sums.get(BEFORE_FIRST_ANCHOR)),
    ...events.flatMap((event, index) => [event, ...toEvent(sums.get(index))])
  ];
}
var DraftEventCollector = class {
  draftEvents = [];
  windows = stationWindows();
  // Этап, на котором инструменты основной сессии оставили сборку каждого проекта: правок много,
  // а этап один. Проект без пометки — тоже ключ. Станция сбрасывает этапы: после неё первая
  // команда снова входит на свой этап.
  stagesByProject = /* @__PURE__ */ new Map();
  // Окно запуска станции тянется до конца журнала, пока не пришла остановка.
  openRuns = /* @__PURE__ */ new Map();
  // Вердикт станции приходит с её остановкой (терминальный Claude Code) или отдельным
  // отчётом по agent_id (десктопное приложение). Каждый запуск судится один раз; повторный
  // запуск того же агента после SendMessage — новый запуск со своим вердиктом.
  agentsStarted = /* @__PURE__ */ new Map();
  judgedRuns = /* @__PURE__ */ new Set();
  // Токены запуска ставятся на его последнюю остановку: транскрипт один на все его старты.
  lastStops = /* @__PURE__ */ new Map();
  sessionProject;
  // Что остановило автоматику (`pendingCall`) и чего она теперь ждёт от человека
  // (`awaitingHuman`): остановка основной сессии делает первое вторым, старт станции сбрасывает
  // оба, промпт человека забирает.
  pendingCall;
  awaitingHuman;
  events;
  meta;
  at;
  endTs;
  constructor(events, meta, at, endTs) {
    this.events = events;
    this.meta = meta;
    this.at = at;
    this.endTs = endTs;
    this.sessionProject = projectOf(events).project;
    for (const event of events) {
      if (event.kind === "subagent_stop" && event.agentId !== void 0) {
        this.lastStops.set(event.agentId, event);
      }
    }
  }
  collect() {
    for (const event of this.events) this.collectEvent(event);
    return this.draftEvents;
  }
  collectEvent(event) {
    switch (event.kind) {
      case "prompt":
        return this.collectPrompt(event.ts, event.text, event.afterStopGate === true);
      case "subagent_start":
        return this.collectSubagentStart(event);
      case "subagent_stop":
        return this.collectSubagentStop(event);
      case "subagent_report": {
        const agent = this.agentsStarted.get(event.agentId);
        if (agent !== void 0) {
          this.judge({ agent, run: event.agentId, line: event.verdict, ts: event.ts });
        }
        return;
      }
      case "tool":
        return this.collectTool(event);
      case "question_answer":
        this.draftEvents.push(draftIntervention(this.at(event.ts), ANSWER_CALL, event.text));
        return;
      case "stop":
        this.awaitingHuman = this.pendingCall;
        return;
      case "session_start":
        return;
      default:
        return event;
    }
  }
  collectPrompt(ts, text, isAfterStopGate) {
    if (!isHumanPrompt(text)) return;
    const reason = isAfterStopGate ? STOP_GATE_CALL : this.awaitingHuman;
    this.pendingCall = void 0;
    this.awaitingHuman = void 0;
    if (reason !== void 0) {
      this.draftEvents.push(draftIntervention(this.at(ts), reason, text));
      return;
    }
    const model = modelAnswering(this.meta.replies ?? [], ts);
    this.draftEvents.push({
      t: this.at(ts),
      type: "draft_prompt",
      said: text,
      goal: "",
      requirements: [],
      ...model === void 0 ? {} : { model }
    });
  }
  collectSubagentStart(event) {
    if (event.agentId !== void 0) this.agentsStarted.set(event.agentId, event.agent);
    const run = agentWindowKey(event);
    this.judgedRuns.delete(run);
    const stage = stageOfAgent(event.agent);
    if (stage === void 0) return;
    this.pendingCall = void 0;
    this.awaitingHuman = void 0;
    this.windows.observe(event);
    this.stagesByProject.clear();
    this.draftEvents.push({ t: this.at(event.ts), type: "stage_enter", stage, run });
    const window = {
      t: this.at(event.ts),
      type: "draft_run",
      run,
      agent: event.agent,
      until: this.at(this.endTs)
    };
    this.draftEvents.push(window);
    this.openRuns.set(run, window);
  }
  collectSubagentStop(event) {
    const run = agentWindowKey(event);
    if (this.windows.observe(event)) this.stagesByProject.clear();
    const window = this.openRuns.get(run);
    if (window !== void 0) window.until = this.at(event.ts);
    this.openRuns.delete(run);
    if (stageOfAgent(event.agent) !== void 0) this.pendingCall = humanCallOfAgent(event.agent);
    this.judge({ agent: event.agent, run, line: event.verdict, ts: event.ts });
    this.countRunTokens(event);
  }
  collectTool(event) {
    if (this.windows.isStationCall(event)) return;
    for (const { stage, place } of stagesReachedByTool(event)) {
      const { projectsByDirectory } = this.meta;
      if (directoryOutsideProjects(place, projectsByDirectory) !== void 0) continue;
      const mark = projectMark(projectOfPlace(place, this.sessionProject, projectsByDirectory));
      this.enterStageByTool(stage, mark.project, event.ts);
      if (stage === "verification") this.collectVerification(event, mark);
    }
  }
  collectVerification(event, mark) {
    const t = this.at(event.ts);
    this.draftEvents.push({ t, type: "draft_check", ok: event.ok, ...mark });
    if (!event.ok) {
      this.draftEvents.push({
        t,
        type: "stage_fail",
        stage: "verification",
        reason: TEST_FAILURE_REASON,
        ...mark
      });
    }
  }
  enterStageByTool(stage, project, ts) {
    if (this.stagesByProject.get(project) === stage) return;
    this.stagesByProject.set(project, stage);
    this.draftEvents.push({
      t: this.at(ts),
      type: "stage_enter",
      stage,
      ...projectMark(project)
    });
  }
  judge({ agent, run, line, ts }) {
    const stage = stageOfAgent(agent);
    const verdict = verdictFor(agent, line);
    if (stage === void 0 || verdict === void 0 || this.judgedRuns.has(run)) return;
    this.judgedRuns.add(run);
    this.draftEvents.push({ t: this.at(ts), type: "draft_check", ok: verdict.passed, run });
    if (!verdict.passed) {
      this.pendingCall = REWORK_CALL;
      this.draftEvents.push({
        t: this.at(ts),
        type: "stage_fail",
        stage,
        reason: verdict.reason,
        run
      });
    }
  }
  countRunTokens(event) {
    const { agentId } = event;
    const tokens = agentId === void 0 ? void 0 : this.meta.runTokens?.get(agentId);
    const isLastStop = agentId !== void 0 && this.lastStops.get(agentId) === event;
    if (agentId === void 0 || tokens === void 0 || !isLastStop) return;
    const run = stageOfAgent(event.agent) === void 0 ? void 0 : agentId;
    this.draftEvents.push({ t: this.at(event.ts), type: "usage", tokens, ...runMark(run) });
  }
};
function messagesOf(events, meta, draftEvents, atWithinBuild) {
  const agentsById = agentsByIdOf(events);
  const stageOnTime = (t) => stageAt(draftEvents, t);
  const remarks = [
    ...assignmentRemarks(meta.assignments ?? [], agentsById, atWithinBuild),
    ...reportRemarks(meta.reports ?? [], agentsById, atWithinBuild),
    ...answerRemarks(events, meta.answers ?? [], stageOnTime, atWithinBuild)
  ];
  return remarks.sort((a, b) => a.t - b.t).map(messageOfRemark);
}
function toDraft(rawEvents, meta) {
  const events = [...rawEvents].sort((a, b) => a.ts - b.ts);
  const startTs = events[0]?.ts ?? 0;
  const endTs = events.at(-1)?.ts ?? startTs;
  const at = (ts) => ts - startTs;
  const atWithinBuild = (ts) => Math.min(Math.max(at(ts), 0), at(endTs));
  const draftEvents = new DraftEventCollector(events, meta, at, endTs).collect();
  const messages = messagesOf(events, meta, draftEvents, atWithinBuild);
  const sessionUsages = (meta.sessionUsages ?? []).map(({ ts, tokens }) => ({ ts: at(ts), tokens })).filter(({ ts }) => ts >= 0 && ts <= at(endTs));
  const startedAt = new Date(startTs).toISOString();
  const day = startedAt.slice(0, ISO_DATE_LENGTH);
  const id = `${day}-${meta.sessionId.slice(0, SHORT_SESSION_LENGTH)}`;
  return routeMessages({
    id,
    startedAt,
    builds: [{ id, ...projectOf(events), title: "", language: "", runs: [] }],
    events: withSessionUsages(mergeMessages(draftEvents, messages), sessionUsages)
  });
}
function sessionTranscriptPaths(events) {
  const paths = /* @__PURE__ */ new Set();
  for (const event of events) {
    if (event.kind === "stop" && event.transcriptPath !== void 0) {
      paths.add(event.transcriptPath);
    }
  }
  return [...paths];
}
function toolDirectories(events) {
  const directories = events.filter((event) => event.kind === "tool").flatMap((event) => stagesReachedByTool(event)).flatMap(({ place }) => place.in === "directory" ? [place.directory] : []);
  return [...new Set(directories)];
}
function directoriesOutsideProjects(rawEvents, projectsByDirectory) {
  const windows = stationWindows();
  const directories = /* @__PURE__ */ new Set();
  for (const event of [...rawEvents].sort((a, b) => a.ts - b.ts)) {
    if (event.kind !== "tool") {
      windows.observe(event);
      continue;
    }
    if (windows.isStationCall(event)) continue;
    const outside = stagesReachedByTool(event).flatMap(({ place }) => {
      const directory = directoryOutsideProjects(place, projectsByDirectory);
      return directory === void 0 ? [] : [directory];
    });
    for (const directory of outside) directories.add(directory);
  }
  return [...directories];
}
function runTranscriptPaths(events) {
  const paths = /* @__PURE__ */ new Map();
  for (const event of events) {
    if (event.kind === "subagent_stop" && event.agentId !== void 0 && event.transcriptPath !== void 0) {
      paths.set(event.agentId, event.transcriptPath);
    }
  }
  return paths;
}
function sessionTranscriptPath(events) {
  let transcriptPath;
  for (const event of events) {
    if (event.kind === "stop" && event.transcriptPath !== void 0) {
      transcriptPath = event.transcriptPath;
    }
  }
  return transcriptPath;
}
function stationTranscriptPaths(events) {
  const paths = /* @__PURE__ */ new Set();
  for (const event of events) {
    if (event.kind === "subagent_stop" && event.transcriptPath !== void 0 && stageOfAgent(event.agent) !== void 0) {
      paths.add(event.transcriptPath);
    }
  }
  return [...paths];
}

// ../../adapters/claude/src/capture/transcript.ts
var SERVICE_MODEL_PREFIX = "<";
function isObject3(value) {
  return typeof value === "object" && value !== null;
}
function entryOf(line) {
  try {
    const entry = JSON.parse(line);
    return isObject3(entry) ? entry : null;
  } catch {
    return null;
  }
}
function timestampOf(entry) {
  const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isNaN(ts) ? void 0 : ts;
}
function usageOf(line) {
  const entry = entryOf(line);
  const message = entry?.message;
  if (entry === null || !isObject3(message)) return null;
  const { id, usage: usage2 } = message;
  if (typeof id !== "string" || !isObject3(usage2)) return null;
  const ts = timestampOf(entry);
  return { messageId: id, usage: usage2, ...ts === void 0 ? {} : { ts } };
}
function replyOf(line) {
  const entry = entryOf(line);
  if (entry === null || !isObject3(entry.message)) return null;
  const { model } = entry.message;
  if (typeof model !== "string" || model.startsWith(SERVICE_MODEL_PREFIX)) return null;
  const ts = timestampOf(entry);
  return ts === void 0 ? null : { ts, model };
}
function tokensOf(usage2) {
  return (usage2.input_tokens ?? 0) + (usage2.output_tokens ?? 0) + (usage2.cache_creation_input_tokens ?? 0);
}
function messageUsages(transcript) {
  const byMessage = /* @__PURE__ */ new Map();
  for (const line of transcript.split("\n")) {
    const parsed = usageOf(line);
    if (parsed === null) continue;
    const ts = parsed.ts ?? byMessage.get(parsed.messageId)?.ts;
    byMessage.set(parsed.messageId, { usage: parsed.usage, ...ts === void 0 ? {} : { ts } });
  }
  return [...byMessage.values()].map(({ ts, usage: usage2 }) => ({
    tokens: tokensOf(usage2),
    ...ts === void 0 ? {} : { ts }
  }));
}
function countTokens(transcript) {
  return messageUsages(transcript).reduce((total, { tokens }) => total + tokens, 0);
}
function tokenUsages(transcript) {
  return messageUsages(transcript).flatMap(({ ts, tokens }) => ts === void 0 ? [] : [{ ts, tokens }]).sort((a, b) => a.ts - b.ts);
}
function modelReplies(transcript) {
  return transcript.split("\n").map(replyOf).filter((reply) => reply !== null).sort((a, b) => a.ts - b.ts);
}
var PARAGRAPH_SEPARATOR = "\n\n";
var ASSISTANT_ROLE = "assistant";
var USER_ROLE = "user";
var SERVICE_ENTRY_PREFIXES = ["<system-reminder>", "[SYSTEM NOTIFICATION"];
var AGENT_TOOL = "Agent";
var SEND_MESSAGE_TOOL = "SendMessage";
var HANDBACK_TOOL = "SubagentHandback";
function entryOfLine(line) {
  const entry = entryOf(line);
  if (entry === null || !isObject3(entry.message)) return null;
  const role = entry.type;
  if (role !== ASSISTANT_ROLE && role !== USER_ROLE) return null;
  const ts = timestampOf(entry);
  if (ts === void 0) return null;
  return {
    role,
    ts,
    message: entry.message,
    ...typeof entry.uuid === "string" ? { uuid: entry.uuid } : {},
    ...typeof entry.agentId === "string" ? { agentId: entry.agentId } : {},
    ...isObject3(entry.toolUseResult) ? { toolUseResult: entry.toolUseResult } : {}
  };
}
function entriesOf(transcript) {
  const seen = /* @__PURE__ */ new Set();
  const entries = [];
  for (const line of transcript.split("\n")) {
    const entry = entryOfLine(line);
    if (entry === null) continue;
    const isRepeat = entry.uuid !== void 0 && seen.has(entry.uuid);
    if (isRepeat) continue;
    if (entry.uuid !== void 0) seen.add(entry.uuid);
    entries.push(entry);
  }
  return entries;
}
function isModelEntry(entry) {
  if (entry.role !== ASSISTANT_ROLE) return false;
  const { model } = entry.message;
  return typeof model !== "string" || !model.startsWith(SERVICE_MODEL_PREFIX);
}
function blocksOf(entry) {
  const { content } = entry.message;
  return Array.isArray(content) ? content.filter(isObject3) : [];
}
function textPartsOf(entry) {
  const parts = [];
  for (const block of blocksOf(entry)) {
    const { text } = block;
    if (block.type === "text" && typeof text === "string" && text.trim() !== "") {
      parts.push({ ts: entry.ts, text: text.trim() });
    }
  }
  return parts;
}
function textsOfEntries(entries) {
  const byMessage = /* @__PURE__ */ new Map();
  entries.forEach((entry, index) => {
    if (!isModelEntry(entry)) return;
    const { id } = entry.message;
    const key = typeof id === "string" ? id : `entry-${index}`;
    const parts = byMessage.get(key) ?? [];
    byMessage.set(key, [...parts, ...textPartsOf(entry)]);
  });
  return [...byMessage.values()].filter((parts) => parts.length > 0).map((parts) => ({
    ts: parts.at(-1)?.ts ?? 0,
    text: parts.map((part) => part.text).join(PARAGRAPH_SEPARATOR)
  }));
}
function assistantTexts(transcript) {
  return textsOfEntries(entriesOf(transcript)).sort((a, b) => a.ts - b.ts);
}
function resultCallIdsOf(entry) {
  return blocksOf(entry).flatMap((block) => {
    const { tool_use_id: callId } = block;
    return block.type === "tool_result" && typeof callId === "string" ? [callId] : [];
  });
}
function agentIdsByCall(entries) {
  const agentIds = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const agentId = entry.toolUseResult?.agentId;
    if (entry.role !== USER_ROLE || typeof agentId !== "string") continue;
    for (const callId of resultCallIdsOf(entry)) agentIds.set(callId, agentId);
  }
  return agentIds;
}
function spawnAssignmentOf(input, callId, ts, agentIds) {
  const { subagent_type: agentType, prompt } = input;
  if (typeof agentType !== "string" || typeof prompt !== "string") return null;
  const agentId = typeof callId === "string" ? agentIds.get(callId) : void 0;
  return {
    ts,
    text: prompt,
    via: "spawn",
    agentType,
    ...agentId === void 0 ? {} : { agentId }
  };
}
function messageAssignmentOf(input, ts) {
  const { to: agentId, message } = input;
  if (typeof agentId !== "string" || typeof message !== "string") return null;
  return { ts, text: message, via: "message", agentId };
}
function assignmentOf(block, ts, agentIds) {
  const { name, input, id } = block;
  if (block.type !== "tool_use" || !isObject3(input)) return null;
  if (name === AGENT_TOOL) return spawnAssignmentOf(input, id, ts, agentIds);
  if (name === SEND_MESSAGE_TOOL) return messageAssignmentOf(input, ts);
  return null;
}
function agentAssignments(transcript) {
  const entries = entriesOf(transcript);
  const agentIds = agentIdsByCall(entries);
  return entries.filter(isModelEntry).flatMap((entry) => blocksOf(entry).map((block) => assignmentOf(block, entry.ts, agentIds))).filter((assignment) => assignment !== null).sort((a, b) => a.ts - b.ts);
}
function startsRun(entry) {
  if (entry.role !== USER_ROLE) return false;
  const { content } = entry.message;
  return typeof content === "string" && !SERVICE_ENTRY_PREFIXES.some((p) => content.startsWith(p));
}
function runsOf(entries) {
  const runs = [];
  for (const entry of entries) {
    if (startsRun(entry)) runs.push([]);
    runs.at(-1)?.push(entry);
  }
  return runs;
}
function handbackOf(entry) {
  const handbacks = blocksOf(entry).flatMap((block) => {
    const { input } = block;
    const isHandback = block.type === "tool_use" && block.name === HANDBACK_TOOL;
    return isHandback && isObject3(input) && typeof input.message === "string" ? [{ ts: entry.ts, text: input.message }] : [];
  });
  return handbacks.at(-1) ?? null;
}
function reportOfRun(run) {
  const handbacks = run.map(handbackOf).filter((handback) => handback !== null);
  const lastText = textsOfEntries(run).sort((a, b) => a.ts - b.ts).at(-1);
  return handbacks.at(-1) ?? lastText ?? null;
}
function agentReports(transcript) {
  return runsOf(entriesOf(transcript)).flatMap((run) => {
    const agentId = run.find((entry) => entry.agentId !== void 0)?.agentId;
    const report = reportOfRun(run);
    return agentId === void 0 || report === null ? [] : [{ ...report, agentId }];
  }).sort((a, b) => a.ts - b.ts);
}

// ../storage/src/project.ts
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path2 from "node:path";
var MARKER_DIRECTORY = ".cyberzavod";
var PROJECT_CONFIG_FILE = path2.join(MARKER_DIRECTORY, "project.json");
var TOOL_FILE = `${MARKER_DIRECTORY}/bin/cyberzavod.mjs`;
var DEFAULT_JOURNAL = `${MARKER_DIRECTORY}/journal`;
var ProjectFileError = class extends Error {
};
var FILE_NOT_FOUND = "ENOENT";
var NOT_A_DIRECTORY = "ENOTDIR";
function hasErrorCode(err, code) {
  return err instanceof Error && "code" in err && err.code === code;
}
function isNotFound(err) {
  return hasErrorCode(err, FILE_NOT_FOUND);
}
function isMissing(err) {
  return isNotFound(err) || hasErrorCode(err, NOT_A_DIRECTORY);
}
async function readProjectConfig(root) {
  const configPath = path2.join(root, PROJECT_CONFIG_FILE);
  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch (err) {
    if (isMissing(err)) return void 0;
    throw new ProjectFileError(`${configPath} \u043D\u0435 \u0447\u0438\u0442\u0430\u0435\u0442\u0441\u044F`, { cause: err });
  }
  try {
    return parseProjectConfig(JSON.parse(text));
  } catch (err) {
    throw new ProjectFileError(`${configPath}: ${err.message}`, { cause: err });
  }
}
async function findProjectRoot(directory) {
  for (let current = path2.resolve(directory); ; current = path2.dirname(current)) {
    if (await isFile(path2.join(current, PROJECT_CONFIG_FILE))) return current;
    if (path2.dirname(current) === current) return void 0;
  }
}
async function isFile(file) {
  try {
    const stats = await stat(file);
    return stats.isFile();
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}
async function writeProjectConfig(root, config) {
  await mkdir(path2.join(root, MARKER_DIRECTORY), { recursive: true });
  await writeFile(path2.join(root, PROJECT_CONFIG_FILE), `${JSON.stringify(config, null, 2)}
`);
}

// ../storage/src/journal.ts
import { mkdir as mkdir2, readdir, readFile as readFile2, writeFile as writeFile2 } from "node:fs/promises";
import path3 from "node:path";
var RECORD_COLLECTIONS = {
  session: "sessions",
  decision: "decisions",
  note: "notes"
};
var CAPTURE_DIRECTORY = "capture";
var RECORD_EXTENSION = ".json";
var JournalError = class extends Error {
};
function journalDirectory(root, config) {
  return path3.resolve(root, ...config.journal.split("/"));
}
async function recordFilesIn(directory) {
  try {
    const names = await readdir(directory);
    return names.filter((name) => name.endsWith(RECORD_EXTENSION)).sort();
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}
async function readRecord(file) {
  try {
    const text = await readFile2(file, "utf8");
    return parseRecord(JSON.parse(text));
  } catch (err) {
    throw new JournalError(`\u0437\u0430\u043F\u0438\u0441\u044C ${file} \u043D\u0435 \u043F\u0440\u043E\u0448\u043B\u0430 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0443: ${err.message}`, {
      cause: err
    });
  }
}
var DirectoryRecordStore = class {
  #directory;
  /**
   * Открывает журнал в каталоге; каталог создаётся при первой записи.
   * @param {string} directory Абсолютный путь журнала.
   */
  constructor(directory) {
    this.#directory = directory;
  }
  /**
   * Перечисляет все записи журнала.
   * @returns {Promise<JournalRecord[]>} Записи по коллекциям, внутри коллекции — по имени файла.
   * @throws {JournalError} Если файл записи битый.
   */
  async list() {
    const records = [];
    for (const collection of Object.values(RECORD_COLLECTIONS)) {
      const directory = path3.join(this.#directory, collection);
      for (const name of await recordFilesIn(directory)) {
        records.push(await readRecord(path3.join(directory, name)));
      }
    }
    return records;
  }
  /**
   * Сохраняет запись в файл `<коллекция>/<id>.json`.
   * @param {JournalRecord} record Проверенная запись.
   * @returns {Promise<void>} Готово, когда файл записан.
   */
  async write(record) {
    const file = this.pathOf(record);
    await mkdir2(path3.dirname(file), { recursive: true });
    await writeFile2(file, `${JSON.stringify(record, null, 2)}
`);
  }
  /**
   * Где лежит или ляжет запись.
   * @param {JournalRecord} record Запись.
   * @returns {string} Абсолютный путь файла записи.
   */
  pathOf(record) {
    return path3.join(this.#directory, RECORD_COLLECTIONS[record.type], `${record.id}.json`);
  }
};

// ../storage/src/harness.ts
function workflowOf(harness2, name) {
  const workflow = harness2.workflows.find((candidate) => candidate.name === name);
  if (workflow === void 0) {
    const known = harness2.workflows.map((candidate) => candidate.name).join(", ");
    throw new HarnessError(`\u043F\u0440\u043E\u0446\u0435\u0441\u0441\u0430 ${name} \u043D\u0435\u0442 \u0432 harness; \u0435\u0441\u0442\u044C: ${known}`);
  }
  return workflow;
}

// ../../adapters/claude/src/paths.ts
import { readdir as readdir2, stat as stat2 } from "node:fs/promises";
import path4 from "node:path";
function captureDirectories(journal) {
  const capture = path4.join(journal, CAPTURE_DIRECTORY, "claude");
  return { raw: path4.join(capture, "raw"), drafts: path4.join(capture, "drafts") };
}
async function locateProject(directory) {
  const root = await findProjectRoot(directory);
  if (root === void 0) return void 0;
  const config = await readProjectConfig(root);
  if (config === void 0) return void 0;
  return { root, config, journal: journalDirectory(root, config) };
}
async function requireProject(directory) {
  const project = await locateProject(directory);
  if (project === void 0) {
    throw new Error(`${directory} \u043D\u0435 \u0432 \u043F\u0440\u043E\u0435\u043A\u0442\u0435 Cyberzavod: \u0441\u043D\u0430\u0447\u0430\u043B\u0430 cyberzavod init`);
  }
  return project;
}
async function findProjectId(directory) {
  try {
    return (await locateProject(directory))?.config.projectId;
  } catch (err) {
    if (!(err instanceof ProjectFileError)) throw err;
    console.warn(`\u043A\u043E\u043D\u0444\u0438\u0433 \u043F\u0440\u043E\u0435\u043A\u0442\u0430 \u043D\u0435 \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u043D: ${err.message}`);
    return void 0;
  }
}
async function filesIn2(dir) {
  try {
    return await readdir2(dir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}
async function modifiedAt(file) {
  const { mtimeMs } = await stat2(file);
  return mtimeMs;
}
async function newestFile(dir, extension) {
  const names = (await filesIn2(dir)).filter((name) => name.endsWith(extension));
  const withTimes = await Promise.all(
    names.map(async (name) => ({ name, mtime: await modifiedAt(path4.join(dir, name)) }))
  );
  const [newest] = withTimes.sort((a, b) => b.mtime - a.mtime);
  return newest === void 0 ? void 0 : path4.join(dir, newest.name);
}

// ../../adapters/claude/src/commands/draft.ts
async function readTranscript(transcriptPath) {
  try {
    return { status: "read", text: await readFile3(transcriptPath, "utf8") };
  } catch (err) {
    if (isNotFound(err)) return { status: "missing" };
    console.warn(`\u0442\u0440\u0430\u043D\u0441\u043A\u0440\u0438\u043F\u0442 ${transcriptPath} \u043D\u0435 \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u043D: ${String(err)}`);
    return { status: "failed" };
  }
}
async function readTranscripts(paths) {
  const transcripts = /* @__PURE__ */ new Map();
  let missing = 0;
  for (const transcriptPath of paths) {
    const read = await readTranscript(transcriptPath);
    if (read.status === "read") transcripts.set(transcriptPath, read.text);
    else if (read.status === "missing") missing++;
  }
  if (missing > 0) console.warn(`\u0442\u0440\u0430\u043D\u0441\u043A\u0440\u0438\u043F\u0442\u043E\u0432 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E: ${missing}, \u0438\u0445 \u0442\u043E\u043A\u0435\u043D\u044B \u043D\u0435 \u043F\u043E\u0441\u0447\u0438\u0442\u0430\u043D\u044B`);
  return transcripts;
}
async function tokensOfRuns(paths) {
  const transcripts = await readTranscripts(paths.values());
  const tokens = /* @__PURE__ */ new Map();
  for (const [agentId, transcriptPath] of paths) {
    const transcript = transcripts.get(transcriptPath);
    if (transcript !== void 0) tokens.set(agentId, countTokens(transcript));
  }
  return tokens;
}
async function usagesOfSession(paths) {
  const transcripts = await readTranscripts(paths);
  return [...transcripts.values()].flatMap(tokenUsages);
}
async function textsFromSessionTranscript(transcriptPath) {
  const none = { replies: [], answers: [], assignments: [] };
  if (transcriptPath === void 0) return none;
  try {
    const transcript = await readFile3(transcriptPath, "utf8");
    return {
      replies: modelReplies(transcript),
      answers: assistantTexts(transcript),
      assignments: agentAssignments(transcript)
    };
  } catch (err) {
    console.warn(
      `\u0442\u0440\u0430\u043D\u0441\u043A\u0440\u0438\u043F\u0442 \u0441\u0435\u0441\u0441\u0438\u0438 \u043D\u0435 \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u043D, \u043C\u043E\u0434\u0435\u043B\u0435\u0439 \u043F\u0440\u043E\u043C\u043F\u0442\u043E\u0432 \u0438 \u0440\u0435\u043F\u043B\u0438\u043A \u0441\u0435\u0441\u0441\u0438\u0438 \u043D\u0435 \u0431\u0443\u0434\u0435\u0442: ${String(err)}`
    );
    return none;
  }
}
async function reportsFromStationTranscripts(paths) {
  const reports = [];
  let missing = 0;
  for (const transcriptPath of paths) {
    const read = await readTranscript(transcriptPath);
    if (read.status === "read") reports.push(...agentReports(read.text));
    else if (read.status === "missing") missing++;
  }
  if (missing > 0) console.warn(`\u0442\u0440\u0430\u043D\u0441\u043A\u0440\u0438\u043F\u0442\u043E\u0432 \u0441\u0442\u0430\u043D\u0446\u0438\u0439 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E: ${missing}, \u0438\u0445 \u043E\u0442\u0447\u0451\u0442\u043E\u0432 \u043D\u0435 \u0431\u0443\u0434\u0435\u0442`);
  return reports;
}
async function projectsOfDirectories(directories) {
  const projects = /* @__PURE__ */ new Map();
  for (const directory of directories) {
    const id = await findProjectId(directory);
    if (id !== void 0) projects.set(directory, id);
  }
  return projects;
}
function titleOf(edit) {
  switch (edit.type) {
    case "draft_prompt":
      return edit.goal;
    case "draft_message":
      return edit.line;
    case "draft_intervention":
      return `\u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u043E (${edit.reason}): ${edit.line}`;
    default:
      return edit;
  }
}
async function readEarlierDraft(draftPath, shown) {
  let earlier;
  try {
    earlier = await readFile3(draftPath, "utf8");
  } catch (err) {
    if (isNotFound(err)) return void 0;
    throw err;
  }
  try {
    return parseDraft(JSON.parse(earlier));
  } catch (err) {
    throw new Error(`\u043F\u0440\u043E\u0448\u043B\u044B\u0439 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A ${shown} \u043D\u0435 \u0440\u0430\u0437\u043E\u0431\u0440\u0430\u043D \u2014 \u0438\u0441\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u0438\u043B\u0438 \u0443\u0434\u0430\u043B\u0438\u0442\u0435 \u0435\u0433\u043E`, {
      cause: err
    });
  }
}
function withEarlierEdits(fresh, previous) {
  if (previous === void 0) return fresh;
  for (const edit of orphanedEdits(previous, fresh)) {
    console.warn(`\u0440\u0435\u0434\u0430\u043A\u0442\u0443\u0440\u0430 \xAB${titleOf(edit)}\xBB \u043D\u0435 \u043F\u0435\u0440\u0435\u043D\u0435\u0441\u0435\u043D\u0430: \u0442\u0430\u043A\u043E\u0433\u043E \u0441\u043E\u0431\u044B\u0442\u0438\u044F \u0432 \u0436\u0443\u0440\u043D\u0430\u043B\u0435 \u043D\u0435\u0442`);
  }
  return carryOverEdits(previous, fresh);
}
function awaitsEditing(event) {
  switch (event.type) {
    case "draft_prompt":
      return event.goal === "" && event.joined !== true;
    case "draft_message":
    case "draft_intervention":
      return event.line === "" || event.text === "";
    default:
      return false;
  }
}
function describeWaiting(event) {
  const said = event.said.replace(/\s+/g, " ");
  switch (event.type) {
    case "draft_prompt":
      return said;
    case "draft_message":
      return `${event.from} \u2192 ${event.to} (${event.source}): ${said}`;
    case "draft_intervention":
      return `\u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u043E (${event.reason}): ${said}`;
    default:
      return event;
  }
}
var MS_PER_SECOND = 1e3;
var SECONDS_PER_MINUTE = 60;
var MAX_ASSIGNMENT_LINE = 100;
function clockOf(t) {
  const seconds2 = Math.floor(t / MS_PER_SECOND);
  const minutes = Math.floor(seconds2 / SECONDS_PER_MINUTE);
  return `${minutes}:${String(seconds2 % SECONDS_PER_MINUTE).padStart(2, "0")}`;
}
function assignmentLineOf(draft, run) {
  const assignment = draft.events.find(
    (event) => event.type === "draft_message" && event.run === run.run && event.source === "assignment"
  );
  if (assignment?.type !== "draft_message") return "\u0437\u0430\u0434\u0430\u043D\u0438\u0435 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E";
  const line = assignment.said.split("\n").find((text) => text.trim() !== "") ?? "";
  return line.trim().slice(0, MAX_ASSIGNMENT_LINE);
}
async function freshDraftOf(rawPath, rawEvents, projectsByDirectory) {
  return toDraft(rawEvents, {
    sessionId: path5.basename(rawPath, ".jsonl"),
    runTokens: await tokensOfRuns(runTranscriptPaths(rawEvents)),
    sessionUsages: await usagesOfSession(sessionTranscriptPaths(rawEvents)),
    ...await textsFromSessionTranscript(sessionTranscriptPath(rawEvents)),
    reports: await reportsFromStationTranscripts(stationTranscriptPaths(rawEvents)),
    projectsByDirectory
  });
}
function printCounts(draft) {
  const prompts = draft.events.filter((event) => event.type === "draft_prompt");
  const messages = draft.events.filter((event) => event.type === "draft_message");
  const interventions = draft.events.filter((event) => event.type === "draft_intervention");
  console.log(
    `\u043F\u0440\u043E\u043C\u043F\u0442\u043E\u0432: ${prompts.length}, \u0440\u0435\u043F\u043B\u0438\u043A: ${messages.length}, \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432: ${interventions.length}`
  );
}
function printBuilds(draft) {
  const owners = eventBuilds(draft);
  for (const build of draft.builds) {
    const eventCount = owners.filter((owner) => owner === build.id).length;
    console.log(
      `\u0441\u0431\u043E\u0440\u043A\u0430 ${build.id}: \u043F\u0440\u043E\u0435\u043A\u0442 ${build.project || "\u2014"}, harness ${build.harness || "\u2014"}, \u043F\u0440\u043E\u0446\u0435\u0441\u0441 ${build.workflow || "\u2014"}, \u0437\u0430\u043F\u0443\u0441\u043A\u043E\u0432: ${build.runs.length}, \u0441\u043E\u0431\u044B\u0442\u0438\u0439: ${eventCount}`
    );
  }
  for (const line of unfilledHeader(draft)) console.log(`  \u043D\u0435 \u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u043E: ${line}`);
}
function warnAboutProjects(draft, rawEvents, projects) {
  for (const project of projectsWithoutBuild(draft)) {
    console.warn(`\u043A\u043E\u043C\u0430\u043D\u0434\u044B \u043F\u0440\u043E\u0435\u043A\u0442\u0430 ${project} \u0431\u0435\u0437 \u0441\u0431\u043E\u0440\u043A\u0438: \u0434\u043E\u0441\u0442\u0430\u043D\u0443\u0442\u0441\u044F \u0441\u0431\u043E\u0440\u043A\u0435 \u043F\u043E \u0432\u0440\u0435\u043C\u0435\u043D\u0438`);
  }
  for (const directory of directoriesOutsideProjects(rawEvents, projects)) {
    console.warn(
      `\u043A\u0430\u0442\u0430\u043B\u043E\u0433 ${directory} \u043D\u0435 \u043F\u0440\u0438\u043D\u0430\u0434\u043B\u0435\u0436\u0438\u0442 \u043F\u0440\u043E\u0435\u043A\u0442\u0443 Cyberzavod: \u0435\u0433\u043E \u044D\u0442\u0430\u043F\u044B \u0438 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u043D\u0435 \u043F\u043E\u043F\u0430\u043B\u0438 \u0432 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A`
    );
  }
}
function printWaiting(draft) {
  const waiting = draft.events.filter(awaitsEditing);
  console.log(`\u0436\u0434\u0443\u0442 \u0440\u0435\u0434\u0430\u043A\u0442\u0443\u0440\u044B: ${waiting.length}`);
  for (const event of waiting) console.log(`  \u2022 ${describeWaiting(event)}`);
}
function printUnassignedRuns(draft) {
  const unassigned = unassignedRuns(draft);
  if (unassigned.length === 0) return;
  console.log(`\u0437\u0430\u043F\u0443\u0441\u043A\u0438 \u0441\u0442\u0430\u043D\u0446\u0438\u0439 \u0431\u0435\u0437 \u0441\u0431\u043E\u0440\u043A\u0438 (\u0434\u043E\u0441\u0442\u0430\u043D\u0443\u0442\u0441\u044F \u043F\u0435\u0440\u0432\u043E\u0439): ${unassigned.length}`);
  for (const run of unassigned) {
    console.log(`  \u2022 ${run.agent} ${run.run} ${clockOf(run.t)}: ${assignmentLineOf(draft, run)}`);
  }
}
function warnAboutEarlierDraft(draft, previous) {
  for (const run of orphanedRuns(draft)) {
    console.warn(`\u0437\u0430\u043F\u0443\u0441\u043A ${run} \u0443\u043A\u0430\u0437\u0430\u043D \u0432 \u0441\u0431\u043E\u0440\u043A\u0435, \u043D\u043E \u0432 \u0436\u0443\u0440\u043D\u0430\u043B\u0435 \u0435\u0433\u043E \u043D\u0435\u0442`);
  }
  for (const message of previous === void 0 ? [] : reroutedMessages(previous, draft)) {
    console.warn(
      `\u0443 \u0440\u0435\u043F\u043B\u0438\u043A\u0438 \xAB${message.line}\xBB \u043F\u043E\u043C\u0435\u043D\u044F\u043B\u0441\u044F \u043C\u0430\u0440\u0448\u0440\u0443\u0442: ${message.from} \u2192 ${message.to}, \u043F\u0435\u0440\u0435\u0447\u0438\u0442\u0430\u0439\u0442\u0435 \u0441\u0442\u0440\u043E\u043A\u0443`
    );
  }
}
function reportDraft({ draft, previous, rawEvents, projectsByDirectory, shownPath }) {
  console.log(`\u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A: ${shownPath}`);
  printCounts(draft);
  printBuilds(draft);
  warnAboutProjects(draft, rawEvents, projectsByDirectory);
  printWaiting(draft);
  printUnassignedRuns(draft);
  warnAboutEarlierDraft(draft, previous);
}
async function draftSession(options) {
  const project = await requireProject(options.projectDirectory);
  const directories = captureDirectories(project.journal);
  const shown = (file) => path5.relative(project.root, file) || ".";
  const rawPath = options.rawPath ?? await newestFile(directories.raw, ".jsonl");
  if (rawPath === void 0) {
    throw new Error(`\u0436\u0443\u0440\u043D\u0430\u043B\u043E\u0432 \u0441\u0435\u0441\u0441\u0438\u0439 \u0435\u0449\u0451 \u043D\u0435\u0442: \u0445\u0443\u043A\u0438 \u043F\u0438\u0448\u0443\u0442 \u0438\u0445 \u0432 ${shown(directories.raw)}`);
  }
  const rawEvents = parseRawLog(await readFile3(rawPath, "utf8"));
  const projectsByDirectory = await projectsOfDirectories(toolDirectories(rawEvents));
  const fresh = await freshDraftOf(rawPath, rawEvents, projectsByDirectory);
  const draftPath = path5.join(directories.drafts, `${fresh.id}.json`);
  const previous = await readEarlierDraft(draftPath, shown(draftPath));
  const draft = routeMessages(withEarlierEdits(fresh, previous));
  await mkdir3(directories.drafts, { recursive: true });
  await writeFile3(draftPath, `${JSON.stringify(draft, null, 2)}
`);
  reportDraft({ draft, previous, rawEvents, projectsByDirectory, shownPath: shown(draftPath) });
  return draftPath;
}

// ../../adapters/claude/src/commands/publish.ts
import { readFile as readFile4 } from "node:fs/promises";
import path6 from "node:path";
function isPublishProblem(err) {
  return err instanceof DraftError || err instanceof RecordError;
}
function publishBuildOrProblem(draft, buildId) {
  try {
    return publishBuild(draft, buildId);
  } catch (err) {
    if (!isPublishProblem(err)) throw err;
    return `\u0441\u0431\u043E\u0440\u043A\u0430 ${buildId}: ${err.message}`;
  }
}
function publishSelected(draft, buildId) {
  const selected = draft.builds.filter(({ id }) => buildId === void 0 || id === buildId);
  if (selected.length === 0) throw new DraftError(`\u0432 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0435 \u043D\u0435\u0442 \u0441\u0431\u043E\u0440\u043A\u0438 ${buildId}`);
  const records = [];
  const problems = [];
  for (const build of selected) {
    const published = publishBuildOrProblem(draft, build.id);
    if (typeof published === "string") problems.push(published);
    else records.push(published);
  }
  if (problems.length > 0) throw new DraftError(problems.join("\n"));
  return records;
}
async function publishSessions(options) {
  const project = await requireProject(options.projectDirectory);
  const shown = (file) => path6.relative(project.root, file) || ".";
  const draftPath = options.draftPath ?? await newestFile(captureDirectories(project.journal).drafts, ".json");
  if (draftPath === void 0) throw new Error("\u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u043E\u0432 \u0435\u0449\u0451 \u043D\u0435\u0442: \u0441\u043D\u0430\u0447\u0430\u043B\u0430 cyberzavod draft");
  const store = new DirectoryRecordStore(project.journal);
  try {
    const draftJson = JSON.parse(await readFile4(draftPath, "utf8"));
    const draft = parseDraft(draftJson);
    for (const record of publishSelected(draft, options.buildId)) {
      await store.write(record);
      console.log(`\u043E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u043D\u043E: ${shown(store.pathOf(record))}`);
    }
    return true;
  } catch (err) {
    if (!isPublishProblem(err)) throw err;
    console.error(`${shown(draftPath)} \u043D\u0435 \u0433\u043E\u0442\u043E\u0432 \u043A \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438:
${err.message}`);
    return false;
  }
}

// ../../adapters/claude/src/generate/claude.ts
var CLAUDE_PROVIDER = "anthropic";
var CLAUDE_AGENT = "claude";
var DEFAULT_MODELS = {
  planning: "opus",
  implementation: "sonnet",
  review: "opus",
  verification: "sonnet",
  record: "sonnet"
};
var STAGE_EFFORT = {
  planning: "high",
  implementation: "high",
  review: "high",
  verification: "medium",
  record: "medium"
};
var ESCALATION_MODEL = "opus";
var ROLE_TOOLS = {
  read: "Read, Grep, Glob, Bash",
  write: "Read, Edit, Write, Grep, Glob, Bash"
};
var GenerateError = class extends Error {
};
function claudeModelOf(stage, agent) {
  const {
    provider = CLAUDE_PROVIDER,
    agent: name = CLAUDE_AGENT,
    model = DEFAULT_MODEL
  } = agent ?? {};
  if (provider !== CLAUDE_PROVIDER || name !== CLAUDE_AGENT) {
    throw new GenerateError(
      `\u044D\u0442\u0430\u043F ${stage}: ${provider}/${name} \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442\u0441\u044F, \u043F\u043E\u043A\u0430 \u0435\u0441\u0442\u044C \u0442\u043E\u043B\u044C\u043A\u043E \u0430\u0434\u0430\u043F\u0442\u0435\u0440 ${CLAUDE_PROVIDER}/${CLAUDE_AGENT}`
    );
  }
  return model === DEFAULT_MODEL ? DEFAULT_MODELS[stage] : model;
}
function claudeEffortOf(stage) {
  return STAGE_EFFORT[stage];
}
function claudeToolsOf(access2) {
  return ROLE_TOOLS[access2];
}

// ../../adapters/claude/src/generate/sync.ts
import { mkdir as mkdir4, readdir as readdir3, readFile as readFile5, rm, writeFile as writeFile4 } from "node:fs/promises";
import path7 from "node:path";

// ../../adapters/claude/src/generate/files.ts
var GENERATED_MARK = "\u0421\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u043D\u043E `cyberzavod sync`";
var GENERATED_COMMENT = `<!-- ${GENERATED_MARK} \u0438\u0437 harness \u0438 .cyberzavod/project.json: \u043D\u0435 \u043F\u0440\u0430\u0432\u0438\u0442\u044C \u0432\u0440\u0443\u0447\u043D\u0443\u044E. \u041F\u0440\u0430\u0432\u0438\u043B\u0430 \u043F\u0440\u043E\u0435\u043A\u0442\u0430 \u2014 \u0432 AGENTS.md. -->`;
var RULES_FILE = "AGENTS.md";
var ENTRYPOINT_FILE = "CLAUDE.md";
function joinPath(directory, file) {
  return directory === "" ? file : `${directory}/${file}`;
}
function stageGuidesOf(project) {
  return project.workflow.stages.map((stage) => project.harness.stages[stage]);
}
function rootEntrypoint(project) {
  const { config, harness: harness2 } = project;
  const route = stageGuidesOf(project).map(({ title }) => title).join(" \u2192 ");
  const commands = config.verification.commands.map((command) => `- \`${command}\``);
  const verification = commands.length === 0 ? "\u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u043F\u0440\u043E\u0435\u043A\u0442\u0430 \u043D\u0435 \u0437\u0430\u0434\u0430\u043D\u044B: \u0432\u043F\u0438\u0448\u0438 \u0438\u0445 \u0432 `verification.commands` \u0444\u0430\u0439\u043B\u0430 `.cyberzavod/project.json`." : `\u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u043F\u0440\u043E\u0435\u043A\u0442\u0430 (\`verification.commands\` \u0432 \`.cyberzavod/project.json\`) \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C \u0437\u0435\u043B\u0451\u043D\u044B\u043C\u0438 \u043F\u0435\u0440\u0435\u0434 \u043A\u043E\u043C\u043C\u0438\u0442\u043E\u043C:

${commands.join("\n")}`;
  return [
    GENERATED_COMMENT,
    "# \u041A\u0430\u043A \u0440\u0430\u0431\u043E\u0442\u0430\u0442\u044C \u0432 \u044D\u0442\u043E\u043C \u043F\u0440\u043E\u0435\u043A\u0442\u0435",
    `\u041F\u0440\u043E\u0446\u0435\u0441\u0441 \u0440\u0430\u0437\u0440\u0430\u0431\u043E\u0442\u043A\u0438 \u0432\u0435\u0434\u0451\u0442 Cyberzavod (harness ${config.harness}, \u043F\u0440\u043E\u0446\u0435\u0441\u0441 \`${config.workflow}\`): ${route}. \u0417\u0430\u0434\u0430\u0447\u0443 \u0447\u0435\u0440\u0435\u0437 \u0432\u0435\u0441\u044C \u043F\u0440\u043E\u0446\u0435\u0441\u0441 \u043F\u0440\u043E\u0432\u043E\u0434\u0438\u0442 \`/feature <\u0437\u0430\u0434\u0430\u0447\u0430>\`; \u0440\u043E\u043B\u0438 \u044D\u0442\u0430\u043F\u043E\u0432 \u2014 \u0430\u0433\u0435\u043D\u0442\u044B \u0432 \`.claude/agents/\`.`,
    verification,
    ...harness2.principles.map(({ text }) => text),
    `@${RULES_FILE}`
  ].join("\n\n");
}
function nestedEntrypoint() {
  return `${GENERATED_COMMENT}

@${RULES_FILE}`;
}
function entrypoints(project) {
  return project.rules.map((directory) => ({
    path: joinPath(directory, ENTRYPOINT_FILE),
    content: `${directory === "" ? rootEntrypoint(project) : nestedEntrypoint()}
`
  }));
}
function agentFile(guide, role, model) {
  const content = [
    "---",
    `name: ${role.name}`,
    `description: ${guide.description} \u042D\u0442\u0430\u043F \xAB${guide.title}\xBB \u043F\u0440\u043E\u0446\u0435\u0441\u0441\u0430 /feature.`,
    `tools: ${claudeToolsOf(role.access)}`,
    `model: ${model}`,
    `effort: ${claudeEffortOf(guide.stage)}`,
    "---",
    GENERATED_COMMENT,
    "",
    guide.body,
    ""
  ].join("\n");
  return { path: `.claude/agents/${role.name}.md`, content };
}
function roleAgents(project) {
  return stageGuidesOf(project).flatMap((guide) => {
    if (guide.role === void 0) return [];
    const model = claudeModelOf(guide.stage, project.config.agents[guide.stage]);
    return [agentFile(guide, guide.role, model)];
  });
}
function stageRow(guide, project) {
  if (guide.role === void 0) return `| ${guide.title} | \u0432\u0435\u0434\u0443\u0449\u0438\u0439 \u0441\u0430\u043C | \u2014 |`;
  const model = claudeModelOf(guide.stage, project.config.agents[guide.stage]);
  return `| ${guide.title} | \`${guide.role.name}\` | ${model} |`;
}
function featureFrontmatter(project, guides) {
  const route = guides.map(({ title }) => title.toLowerCase()).join(", ");
  return [
    "---",
    "name: feature",
    `description: \u041F\u0440\u043E\u0432\u043E\u0434\u0438\u0442 \u0437\u0430\u0434\u0430\u0447\u0443 \u0447\u0435\u0440\u0435\u0437 \u043F\u0440\u043E\u0446\u0435\u0441\u0441 ${project.workflow.name} \u2014 ${route}; \u0443 \u043A\u0430\u0436\u0434\u043E\u0439 \u0440\u043E\u043B\u0438 \u0441\u0432\u043E\u044F \u043C\u043E\u0434\u0435\u043B\u044C. \u0417\u0430\u043F\u0443\u0441\u043A \u2014 /feature <\u0437\u0430\u0434\u0430\u0447\u0430>.`,
    "argument-hint: <\u0437\u0430\u0434\u0430\u0447\u0430>",
    "disable-model-invocation: true",
    "---",
    GENERATED_COMMENT
  ].join("\n");
}
function stageTable(project, guides) {
  return [
    "| \u042D\u0442\u0430\u043F | \u0420\u043E\u043B\u044C | \u041C\u043E\u0434\u0435\u043B\u044C |",
    "| --- | --- | --- |",
    ...guides.map((guide) => stageRow(guide, project))
  ].join("\n");
}
function featureSkill(project) {
  const guides = stageGuidesOf(project);
  const ownStages = guides.filter((guide) => guide.role === void 0).map((guide) => `## \u042D\u0442\u0430\u043F \xAB${guide.title}\xBB

${guide.body}`);
  const content = [
    featureFrontmatter(project, guides),
    "# \u0417\u0430\u0434\u0430\u0447\u0430 \u0447\u0435\u0440\u0435\u0437 \u043F\u0440\u043E\u0446\u0435\u0441\u0441",
    stageTable(project, guides),
    project.harness.conductor,
    `\u0411\u043E\u043B\u0435\u0435 \u0441\u0438\u043B\u044C\u043D\u0430\u044F \u043C\u043E\u0434\u0435\u043B\u044C \u0434\u043B\u044F \u0432\u0442\u043E\u0440\u043E\u0439 \u0434\u043E\u0440\u0430\u0431\u043E\u0442\u043A\u0438 \u2014 \`${ESCALATION_MODEL}\`: \u043F\u0435\u0440\u0435\u0434\u0430\u0439 \`model: "${ESCALATION_MODEL}"\` \u0432 \u0432\u044B\u0437\u043E\u0432\u0435 \u0430\u0433\u0435\u043D\u0442\u0430.`,
    ...ownStages
  ].join("\n\n");
  return { path: ".claude/skills/feature/SKILL.md", content: `${content}
` };
}
function renderTemplate(template2, project) {
  const values = {
    generated: GENERATED_COMMENT,
    cli: project.cli,
    raw: project.capture.raw,
    drafts: project.capture.drafts
  };
  return template2.replace(/\{\{(\w+)\}\}/g, (placeholder, name) => {
    const value = values[name];
    if (value === void 0) {
      throw new GenerateError(`\u0432 \u0448\u0430\u0431\u043B\u043E\u043D\u0435 \u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043F\u043E\u0434\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0430 ${placeholder}`);
    }
    return value;
  });
}
function recordingFiles(project) {
  return [
    {
      path: ".claude/skills/publish-recording/SKILL.md",
      content: renderTemplate(project.templates.publishRecording, project)
    },
    {
      path: ".claude/agents/recording-editor.md",
      content: renderTemplate(project.templates.recordingEditor, project)
    }
  ];
}
function claudeFiles(project) {
  return [
    ...entrypoints(project),
    ...roleAgents(project),
    featureSkill(project),
    ...recordingFiles(project)
  ];
}

// ../../adapters/claude/src/generate/settings.ts
var SettingsError = class extends Error {
};
var TURN_START_TIMEOUT_SECONDS = 30;
var STOP_GATE_TIMEOUT_SECONDS = 180;
var ADAPTER_DENY = [
  "Read(**/.env)",
  "Read(**/.env.*)",
  "Edit(**/.env)",
  "Edit(**/.env.*)",
  "Edit(**/capture/claude/raw/**)"
];
function isOwnHandler(handler) {
  return handler.command.includes(TOOL_FILE);
}
function hookCommand(hook) {
  return `node "$CLAUDE_PROJECT_DIR/${TOOL_FILE}" hook ${hook}`;
}
function adapterHooks() {
  const record = { type: "command", command: hookCommand("record"), async: true };
  const turnStart = {
    type: "command",
    command: hookCommand("turn-start"),
    timeout: TURN_START_TIMEOUT_SECONDS
  };
  const stopGate = {
    type: "command",
    command: hookCommand("stop"),
    timeout: STOP_GATE_TIMEOUT_SECONDS,
    statusMessage: "\u0417\u0430\u043F\u0443\u0441\u043A\u0430\u044E \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u043F\u0440\u043E\u0435\u043A\u0442\u0430\u2026"
  };
  const recordOnly = [{ hooks: [record] }];
  return {
    SessionStart: recordOnly,
    UserPromptSubmit: [{ hooks: [record, turnStart] }],
    PostToolUse: recordOnly,
    PostToolUseFailure: recordOnly,
    SubagentStart: recordOnly,
    SubagentStop: recordOnly,
    Stop: [{ hooks: [record, stopGate] }]
  };
}
var ADAPTER_HOOKS = adapterHooks();
function isObject4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isHookGroup(value) {
  return isObject4(value) && Array.isArray(value.hooks) && value.hooks.every((handler) => isObject4(handler) && typeof handler.command === "string");
}
function groupsOf(event, value) {
  if (!Array.isArray(value) || !value.every(isHookGroup)) {
    throw new SettingsError(`hooks.${event} \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u0441\u043F\u0438\u0441\u043A\u043E\u043C \u0433\u0440\u0443\u043F\u043F \u0441 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0447\u0438\u043A\u0430\u043C\u0438`);
  }
  return value;
}
function withoutOwnHandlers(groups) {
  return groups.map((group) => ({ ...group, hooks: group.hooks.filter((handler) => !isOwnHandler(handler)) })).filter((group) => group.hooks.length > 0);
}
function mergedHooks(existing, own) {
  if (existing !== void 0 && !isObject4(existing)) {
    throw new SettingsError("hooks \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u043C");
  }
  const merged = {};
  for (const [event, groups] of Object.entries(existing ?? {})) {
    merged[event] = withoutOwnHandlers(groupsOf(event, groups));
  }
  for (const [event, groups] of Object.entries(own)) {
    merged[event] = [...merged[event] ?? [], ...groups];
  }
  const nonEmpty = Object.entries(merged).filter(([, groups]) => groups.length > 0);
  return Object.fromEntries(nonEmpty);
}
function mergedPermissions(existing) {
  if (existing !== void 0 && !isObject4(existing)) {
    throw new SettingsError("permissions \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u043C");
  }
  const { deny = [] } = existing ?? {};
  if (!Array.isArray(deny) || !deny.every((rule) => typeof rule === "string")) {
    throw new SettingsError("permissions.deny \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u0441\u043F\u0438\u0441\u043A\u043E\u043C \u0441\u0442\u0440\u043E\u043A");
  }
  const missing = ADAPTER_DENY.filter((rule) => !deny.includes(rule));
  return { ...existing, deny: [...deny, ...missing] };
}
function mergeSettings(settings, hooks) {
  return {
    ...settings,
    permissions: mergedPermissions(settings.permissions),
    hooks: mergedHooks(settings.hooks, hooks)
  };
}

// ../../adapters/claude/src/generate/sync.ts
var SETTINGS_FILE = ".claude/settings.json";
var PROJECT_CLI = `node ${TOOL_FILE}`;
var RULES_FILE2 = "AGENTS.md";
var ENTRYPOINT_FILE2 = "CLAUDE.md";
var GENERATED_DIRECTORIES = [".claude/agents", ".claude/skills"];
var SKIPPED_DIRECTORIES = /* @__PURE__ */ new Set(["node_modules"]);
function toPosix(relative) {
  return relative.split(path7.sep).join("/");
}
function relativeTo(root, target) {
  return toPosix(path7.relative(root, target));
}
function fileAt(root, relative) {
  return path7.join(root, ...relative.split("/"));
}
async function readOptional(file) {
  try {
    return await readFile5(file, "utf8");
  } catch (err) {
    if (isNotFound(err)) return void 0;
    throw err;
  }
}
async function directoriesWith(root, fileName, skipped) {
  const found = [];
  const visit = async (directory) => {
    const entries = await readdir3(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === fileName)) {
      found.push(relativeTo(root, directory));
    }
    for (const entry of entries) {
      const child = path7.join(directory, entry.name);
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (SKIPPED_DIRECTORIES.has(entry.name) || child === skipped) continue;
      await visit(child);
    }
  };
  await visit(root);
  return found.sort();
}
function inDirectory(directory, fileName) {
  return directory === "" ? fileName : `${directory}/${fileName}`;
}
async function claudeProjectOf(project, installation) {
  const { harness: harness2, templates: templates2 } = installation;
  const capture = captureDirectories(project.journal);
  return {
    config: project.config,
    harness: harness2,
    workflow: workflowOf(harness2, project.config.workflow),
    rules: await directoriesWith(project.root, RULES_FILE2, project.journal),
    capture: {
      raw: relativeTo(project.root, capture.raw),
      drafts: relativeTo(project.root, capture.drafts)
    },
    cli: PROJECT_CLI,
    templates: templates2
  };
}
function parseSettings(text, file) {
  if (text === void 0) return {};
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new GenerateError("\u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u043C");
    }
    return parsed;
  } catch (err) {
    throw new GenerateError(`${file} \u043D\u0435 \u0440\u0430\u0437\u043E\u0431\u0440\u0430\u043D: ${err.message}`, { cause: err });
  }
}
function settingsText(settings) {
  return `${JSON.stringify(settings, null, 2)}
`;
}
async function settingsFile(root) {
  const current = parseSettings(await readOptional(path7.join(root, SETTINGS_FILE)), SETTINGS_FILE);
  return {
    path: SETTINGS_FILE,
    content: settingsText(mergeSettings(current, ADAPTER_HOOKS))
  };
}
function sameText(left, right) {
  return withUnixNewlines(left) === withUnixNewlines(right);
}
function withUnixNewlines(text) {
  return text.replace(/\r\n/g, "\n");
}
function isGenerated(text) {
  return text.includes(GENERATED_MARK);
}
function ignoreMissing(err) {
  if (isNotFound(err)) return [];
  throw err;
}
async function markdownFilesUnder(root, directory) {
  const entries = await readdir3(path7.join(root, directory), { recursive: true }).catch(
    ignoreMissing
  );
  const markdown = entries.filter((entry) => entry.endsWith(".md"));
  return markdown.map((entry) => `${directory}/${toPosix(entry)}`);
}
async function generatedOnDisk(root, journal) {
  const entrypointDirectories = await directoriesWith(root, ENTRYPOINT_FILE2, journal);
  const entrypoints2 = entrypointDirectories.map(
    (directory) => inDirectory(directory, ENTRYPOINT_FILE2)
  );
  const generatedFiles = await Promise.all(
    GENERATED_DIRECTORIES.map((directory) => markdownFilesUnder(root, directory))
  );
  const candidates = [...entrypoints2, ...generatedFiles.flat()];
  const generated = [];
  for (const candidate of candidates) {
    const text = await readOptional(fileAt(root, candidate));
    if (text !== void 0 && isGenerated(text)) generated.push(candidate);
  }
  return generated;
}
async function compare(root, files, force) {
  const changed = [];
  const conflicts = [];
  for (const file of files) {
    const current = await readOptional(fileAt(root, file.path));
    if (current !== void 0 && sameText(current, file.content)) continue;
    const ownedByGenerator = current === void 0 || isGenerated(current) || file.path === SETTINGS_FILE;
    if (ownedByGenerator || force) changed.push(file.path);
    else conflicts.push(file.path);
  }
  return { changed, conflicts };
}
async function writeFiles(root, files, paths) {
  for (const file of files.filter(({ path: filePath }) => paths.includes(filePath))) {
    const target = fileAt(root, file.path);
    await mkdir4(path7.dirname(target), { recursive: true });
    await writeFile4(target, file.content);
  }
}
async function syncClaude(options) {
  const project = await requireProject(options.projectDirectory);
  const claudeProject = await claudeProjectOf(project, options.installation);
  const files = [...claudeFiles(claudeProject), await settingsFile(project.root)];
  const { changed, conflicts } = await compare(project.root, files, options.force === true);
  const wanted = new Set(files.map(({ path: filePath }) => filePath));
  const onDisk = await generatedOnDisk(project.root, project.journal);
  const removed = onDisk.filter((filePath) => !wanted.has(filePath));
  const report = { changed, removed, conflicts };
  if (options.check === true) return report;
  if (conflicts.length > 0) {
    throw new GenerateError(
      `\u044D\u0442\u0438 \u0444\u0430\u0439\u043B\u044B \u043D\u0430\u043F\u0438\u0441\u0430\u043D\u044B \u043D\u0435 \u0433\u0435\u043D\u0435\u0440\u0430\u0442\u043E\u0440\u043E\u043C, \u043F\u0435\u0440\u0435\u043D\u0435\u0441\u0438\u0442\u0435 \u0438\u0445 \u0441\u043E\u0434\u0435\u0440\u0436\u0438\u043C\u043E\u0435 \u0432 AGENTS.md \u0438\u043B\u0438 \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 \u0441 --force: ${conflicts.join(", ")}`
    );
  }
  await writeFiles(project.root, files, changed);
  for (const filePath of removed) await rm(fileAt(project.root, filePath));
  return report;
}

// ../../adapters/claude/src/hooks/record.ts
import { appendFile, mkdir as mkdir5 } from "node:fs/promises";
import path9 from "node:path";

// ../../adapters/claude/src/hooks/hook.ts
var SILENT_EXIT = { exitCode: 0, stdout: "", stderr: "" };
var UNKNOWN_SESSION = "unknown";
function sessionIdOf(payload) {
  const parsed = JSON.parse(payload);
  const hasSessionId = typeof parsed === "object" && parsed !== null && "session_id" in parsed;
  const sessionId = hasSessionId ? parsed.session_id : void 0;
  return typeof sessionId === "string" && sessionId !== "" ? sessionId : UNKNOWN_SESSION;
}

// ../../adapters/claude/src/hooks/state.ts
import { unlink } from "node:fs/promises";
import path8 from "node:path";
var STATE_PREFIX = "cyberzavod";
var UNSAFE_SESSION_CHARACTERS = /[^A-Za-z0-9_-]/g;
var UNKNOWN_SESSION2 = "unknown";
function hookStatePath(tmpDir, sessionId, name) {
  const safeSession = sessionId.replace(UNSAFE_SESSION_CHARACTERS, "") || UNKNOWN_SESSION2;
  return path8.join(tmpDir, `${STATE_PREFIX}-${name}-${safeSession}`);
}
async function claimHumanCallMarker(sessionId, tmpDir) {
  const markerPath = hookStatePath(tmpDir, sessionId, "human-call");
  try {
    await unlink(markerPath);
    return true;
  } catch (err) {
    if (!isNotFound(err)) console.warn(`\u043E\u0442\u043C\u0435\u0442\u043A\u0430 ${markerPath} \u043D\u0435 \u0437\u0430\u0431\u0440\u0430\u043D\u0430: ${String(err)}`);
    return false;
  }
}

// ../../adapters/claude/src/hooks/record.ts
var RecordHookError = class extends Error {
};
function withProject(event, project) {
  return event.kind === "session_start" ? stampProject(event, project.config) : event;
}
async function withStopGateMark(event, sessionId, tmpDir) {
  if (event.kind !== "prompt" || !isHumanPrompt(event.text)) return event;
  return await claimHumanCallMarker(sessionId, tmpDir) ? markAfterStopGate(event) : event;
}
async function recordEvent(context) {
  const payload = JSON.parse(context.payload);
  const hookEvent = fromHookPayload(payload, Date.now());
  if (hookEvent === null) return SILENT_EXIT;
  let project;
  try {
    project = await locateProject(context.projectDirectory);
  } catch (err) {
    if (!(err instanceof ProjectFileError)) throw err;
    return { ...SILENT_EXIT, stderr: `\u0441\u0435\u0441\u0441\u0438\u044F \u043D\u0435 \u0437\u0430\u043F\u0438\u0441\u0430\u043D\u0430: ${err.message}
` };
  }
  if (project === void 0) return SILENT_EXIT;
  const sessionId = payload.session_id;
  if (!isSafeSessionId(sessionId)) {
    throw new RecordHookError(`\u043D\u0435\u0434\u043E\u043F\u0443\u0441\u0442\u0438\u043C\u044B\u0439 session_id: ${String(sessionId)}`);
  }
  const stampedEvent = withProject(hookEvent, project);
  const event = await withStopGateMark(stampedEvent, sessionId, context.tmpDir);
  const { raw } = captureDirectories(project.journal);
  await mkdir5(raw, { recursive: true });
  await appendFile(path9.join(raw, `${sessionId}.jsonl`), `${JSON.stringify(event)}
`);
  return SILENT_EXIT;
}

// ../../adapters/claude/src/hooks/stop-gate.ts
import { readFile as readFile6, rm as rm2, writeFile as writeFile5 } from "node:fs/promises";

// ../../adapters/claude/src/hooks/checks.ts
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
var WHOLE_REPOSITORY = ".";
var COMMAND_SEPARATOR2 = " && ";
function checksOf(config) {
  const { commands, paths } = config.verification;
  if (commands.length === 0) return void 0;
  return {
    command: commands.join(COMMAND_SEPARATOR2),
    paths: paths.length === 0 ? [WHOLE_REPOSITORY] : paths
  };
}
function runChecks(checks, root, outputFile) {
  const output = openSync(outputFile, "w");
  try {
    const result = spawnSync(checks.command, {
      cwd: root,
      shell: true,
      stdio: ["ignore", output, output]
    });
    const printed = readFileSync(outputFile, "utf8");
    if (result.error !== void 0) {
      return { passed: false, output: `${printed}${result.error.message}
` };
    }
    return { passed: result.status === 0, output: printed };
  } finally {
    closeSync(output);
    rmSync(outputFile, { force: true });
  }
}

// ../../adapters/claude/src/hooks/fingerprint.ts
import { createHash } from "node:crypto";
import { spawnSync as spawnSync2 } from "node:child_process";
import { readFileSync as readFileSync2 } from "node:fs";
import path10 from "node:path";
var GitError = class extends Error {
};
var FINGERPRINT_ALGORITHM = "sha256";
var GIT_OUTPUT_LIMIT_BYTES = 256 * 1024 * 1024;
var NUL = "\0";
function gitOutput(root, args) {
  const result = spawnSync2("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_LIMIT_BYTES
  });
  if (result.error !== void 0) {
    throw new GitError(`git ${args.join(" ")}: ${result.error.message}`, { cause: result.error });
  }
  return result.stdout;
}
function untrackedFiles(root, paths) {
  const listed = gitOutput(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...paths
  ]);
  return listed.split(NUL).filter((file) => file !== "");
}
function codeFingerprint(root, paths) {
  const hash = createHash(FINGERPRINT_ALGORITHM);
  hash.update(gitOutput(root, ["rev-parse", "HEAD"]));
  hash.update(gitOutput(root, ["diff", "HEAD", "--", ...paths]));
  for (const file of untrackedFiles(root, paths)) {
    hash.update(`${file}${NUL}`);
    hash.update(readFileSync2(path10.join(root, file)));
  }
  return hash.digest("hex");
}
function hasUncommittedChanges(root, paths) {
  return gitOutput(root, ["status", "--porcelain", "--", ...paths]).trim() !== "";
}

// ../../adapters/claude/src/hooks/stop-gate.ts
var MAX_BLOCKS = 3;
var OUTPUT_TAIL_LINES = 40;
var BLOCK_EXIT_CODE = 2;
var RELEASE_EXIT_CODE = 0;
var RELEASE = { kind: "release" };
async function readConfig(root) {
  try {
    return { config: await readProjectConfig(root) };
  } catch (err) {
    if (err instanceof ProjectFileError) return { broken: err };
    throw err;
  }
}
async function readState(file) {
  try {
    return await readFile6(file, "utf8");
  } catch (err) {
    if (isNotFound(err)) return void 0;
    throw err;
  }
}
async function codeChangedThisTurn(session, checks) {
  const turnStart = await readState(session.statePath("turn-start"));
  if (turnStart === void 0) return hasUncommittedChanges(session.root, checks.paths);
  return turnStart !== codeFingerprint(session.root, checks.paths);
}
async function countedBlock(counter) {
  try {
    const stored = await readState(counter);
    const blocks = Number.parseInt(stored ?? "0", 10);
    const next = (Number.isNaN(blocks) ? 0 : blocks) + 1;
    await writeFile5(counter, String(next));
    return next;
  } catch {
    return void 0;
  }
}
async function written(file, text) {
  try {
    await writeFile5(file, text);
    return true;
  } catch {
    return false;
  }
}
function tailOf(output) {
  const lines = output.trimEnd().split("\n");
  return lines.slice(-OUTPUT_TAIL_LINES).join("\n");
}
async function callHuman(session, blocks) {
  const message = `\u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u043A\u0440\u0430\u0441\u043D\u044B\u0435 \u043F\u043E\u0441\u043B\u0435 ${MAX_BLOCKS} \u043F\u043E\u043F\u044B\u0442\u043E\u043A \u0438\u0441\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u2014 \u0430\u0433\u0435\u043D\u0442 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D, \u043D\u0443\u0436\u0435\u043D \u0447\u0435\u043B\u043E\u0432\u0435\u043A.`;
  const marked = await written(session.statePath("human-call"), String(blocks));
  return {
    kind: "release-with-message",
    message: marked ? message : `${message} \u041E\u0442\u043C\u0435\u0442\u043A\u0430 \u0434\u043B\u044F \u0437\u0430\u043F\u0438\u0441\u0438 \u043D\u0435 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0430.`
  };
}
async function verdictOnRedChecks(session, checks, output) {
  const counter = session.statePath("stop-blocks");
  const blocks = await countedBlock(counter);
  if (blocks === void 0) {
    return {
      kind: "release-with-message",
      message: `\u0425\u0443\u043A \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0438 \u043D\u0435 \u0441\u043C\u043E\u0433 \u0437\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u0441\u0447\u0451\u0442\u0447\u0438\u043A \u043F\u043E\u043F\u044B\u0442\u043E\u043A (${counter}) \u2014 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u043A\u0440\u0430\u0441\u043D\u044B\u0435, \u0430\u0433\u0435\u043D\u0442 \u043E\u0442\u043F\u0443\u0449\u0435\u043D \u0431\u0435\u0437 \u043F\u043E\u0432\u0442\u043E\u0440\u043E\u0432.`
    };
  }
  if (blocks > MAX_BLOCKS) return callHuman(session, blocks);
  return {
    kind: "block",
    message: `${checks.command} \u043D\u0435 \u043F\u0440\u043E\u0445\u043E\u0434\u0438\u0442 \u2014 \u0437\u0430\u043A\u043E\u043D\u0447\u0438\u0442\u044C \u0440\u0430\u0431\u043E\u0442\u0443 \u043D\u0435\u043B\u044C\u0437\u044F (\u043F\u043E\u043F\u044B\u0442\u043A\u0430 ${blocks} \u0438\u0437 ${MAX_BLOCKS}). \u0418\u0441\u043F\u0440\u0430\u0432\u044C:
${tailOf(output)}
`
  };
}
async function codeChangedOrGitMissing(session, checks) {
  try {
    return await codeChangedThisTurn(session, checks);
  } catch (err) {
    if (err instanceof GitError) return err;
    throw err;
  }
}
async function verdictOf2(session) {
  const reading = await readConfig(session.root);
  if ("broken" in reading) {
    return {
      kind: "release-with-message",
      message: `\u041A\u043E\u043D\u0444\u0438\u0433 ${PROJECT_CONFIG_FILE} \u043D\u0435 \u0447\u0438\u0442\u0430\u0435\u0442\u0441\u044F \u2014 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u044B, \u0430\u0433\u0435\u043D\u0442 \u043E\u0442\u043F\u0443\u0449\u0435\u043D. ${reading.broken.message}`
    };
  }
  const checks = reading.config === void 0 ? void 0 : checksOf(reading.config);
  if (checks === void 0) return RELEASE;
  const changed = await codeChangedOrGitMissing(session, checks);
  if (changed instanceof GitError) {
    return {
      kind: "release-with-message",
      message: `\u0425\u0443\u043A \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0438 \u043D\u0435 \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u043B git \u2014 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u044B, \u0430\u0433\u0435\u043D\u0442 \u043E\u0442\u043F\u0443\u0449\u0435\u043D. ${changed.message}`
    };
  }
  if (!changed) return RELEASE;
  const run = runChecks(checks, session.root, session.statePath("checks-output"));
  if (run.passed) return RELEASE;
  return verdictOnRedChecks(session, checks, run.output);
}
async function removeState(file) {
  await rm2(file, { force: true, recursive: true });
}
async function endTurn(session) {
  await removeState(session.statePath("turn-start"));
  await removeState(session.statePath("stop-blocks"));
}
async function outcomeOf(session, verdict) {
  switch (verdict.kind) {
    case "release":
      await endTurn(session);
      return SILENT_EXIT;
    case "release-with-message":
      await endTurn(session);
      return {
        exitCode: RELEASE_EXIT_CODE,
        stdout: `${JSON.stringify({ systemMessage: verdict.message })}
`,
        stderr: ""
      };
    case "block":
      return { exitCode: BLOCK_EXIT_CODE, stdout: "", stderr: verdict.message };
  }
}
async function gateStop(context) {
  const sessionId = sessionIdOf(context.payload);
  const session = {
    root: context.projectDirectory,
    statePath: (name) => hookStatePath(context.tmpDir, sessionId, name)
  };
  return outcomeOf(session, await verdictOf2(session));
}

// ../../adapters/claude/src/hooks/turn-start.ts
import { existsSync } from "node:fs";
import { rm as rm3, writeFile as writeFile6 } from "node:fs/promises";
async function configOrNothing(root) {
  try {
    return await readProjectConfig(root);
  } catch (err) {
    if (err instanceof ProjectFileError) return void 0;
    throw err;
  }
}
async function startTurn(context) {
  const config = await configOrNothing(context.projectDirectory);
  const checks = config === void 0 ? void 0 : checksOf(config);
  if (checks === void 0) return SILENT_EXIT;
  const sessionId = sessionIdOf(context.payload);
  const turnStart = hookStatePath(context.tmpDir, sessionId, "turn-start");
  if (existsSync(turnStart)) return SILENT_EXIT;
  await rm3(hookStatePath(context.tmpDir, sessionId, "stop-blocks"), { force: true });
  await writeFile6(turnStart, codeFingerprint(context.projectDirectory, checks.paths));
  return SILENT_EXIT;
}

// ../../adapters/claude/src/hooks/index.ts
var HOOK_NAMES = ["record", "turn-start", "stop"];
var HOOKS = {
  record: recordEvent,
  "turn-start": startTurn,
  stop: gateStop
};
function isHookName(name) {
  return HOOK_NAMES.includes(name);
}
async function runHook(name, context) {
  return HOOKS[name](context);
}

// src/errors.ts
var CommandError = class extends Error {
};

// src/sharing/http.ts
async function sendRequest(fetchImplementation, url, init) {
  try {
    return await fetchImplementation(url, init);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CommandError(`\u043D\u0435\u0442 \u0441\u0432\u044F\u0437\u0438 \u0441 ${new URL(url).origin}: ${reason}`, { cause: err });
  }
}
async function readJsonBody(response) {
  const text = await response.text();
  if (text.trim() === "") return void 0;
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function isObject5(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/sharing/api.ts
var ApiError = class extends Error {
  code;
  status;
  /**
   * Ошибка, о которой сообщил сервер.
   * @param {string} message Текст ошибки по-русски из ответа сервера.
   * @param {string} code Код ошибки из ответа сервера, например `limit_reached`.
   * @param {number} status HTTP-статус ответа.
   */
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
};
var UNAUTHORIZED_CODE = "unauthorized";
var LIMIT_REACHED_CODE = "limit_reached";
var INVALID_RESPONSE_CODE = "invalid_response";
var HTTP_ERROR_CODE = "http_error";
var NEW_RECORDING_STATUS = 201;
function isString(value) {
  return typeof value === "string";
}
function invalidResponse(what, status) {
  return new ApiError(`\u0441\u0435\u0440\u0432\u0435\u0440 \u0432\u0435\u0440\u043D\u0443\u043B \u043D\u0435\u043E\u0436\u0438\u0434\u0430\u043D\u043D\u044B\u0439 \u043E\u0442\u0432\u0435\u0442: ${what}`, INVALID_RESPONSE_CODE, status);
}
function parseSummary(raw, status) {
  if (!isObject5(raw)) throw invalidResponse("\u0437\u0430\u043F\u0438\u0441\u044C \u043D\u0435 \u043E\u0431\u044A\u0435\u043A\u0442", status);
  const { id, slug, projectId, title, language, startedAt, uploadedAt } = raw;
  if (!isString(id) || !isString(slug) || !isString(projectId) || !isString(title) || !isString(language) || !isString(startedAt) || !isString(uploadedAt)) {
    throw invalidResponse("\u0432 \u0437\u0430\u043F\u0438\u0441\u0438 \u043D\u0435 \u0445\u0432\u0430\u0442\u0430\u0435\u0442 \u043F\u043E\u043B\u0435\u0439", status);
  }
  return { id, slug, projectId, title, language, startedAt, uploadedAt };
}
function parseMe(raw, status) {
  if (!isObject5(raw)) throw invalidResponse("\u0430\u0432\u0442\u043E\u0440 \u043D\u0435 \u043E\u0431\u044A\u0435\u043A\u0442", status);
  const { login: login2, galleryPublic, limit, recordings } = raw;
  if (!isString(login2) || typeof galleryPublic !== "boolean" || typeof limit !== "number" || !Array.isArray(recordings)) {
    throw invalidResponse("\u0443 \u0430\u0432\u0442\u043E\u0440\u0430 \u043D\u0435 \u0445\u0432\u0430\u0442\u0430\u0435\u0442 \u043F\u043E\u043B\u0435\u0439", status);
  }
  const summaries = recordings.map((summary) => parseSummary(summary, status));
  return { login: login2, galleryPublic, limit, recordings: summaries };
}
function errorOf(body, status) {
  if (isObject5(body) && isString(body.error) && isString(body.message)) {
    return new ApiError(body.message, body.error, status);
  }
  return new ApiError(`\u0441\u0435\u0440\u0432\u0435\u0440 \u043E\u0442\u0432\u0435\u0442\u0438\u043B ${status}`, HTTP_ERROR_CODE, status);
}
var HttpCyberzavodApi = class {
  #baseUrl;
  #fetch;
  /**
   * Клиент сервера.
   * @param {string} baseUrl Адрес сервера без завершающего «/».
   * @param {FetchFunction} fetchImplementation Функция запроса; по умолчанию встроенный `fetch`.
   */
  constructor(baseUrl, fetchImplementation = fetch) {
    this.#baseUrl = baseUrl;
    this.#fetch = fetchImplementation;
  }
  /**
   * Спрашивает у сервера идентификатор приложения GitHub.
   * @returns {Promise<string>} `clientId` для device flow.
   * @throws {ApiError} Если вход на сервере недоступен или ответ неожиданный.
   */
  async githubClientId() {
    const { status, body } = await this.#call({ method: "GET", path: "/api/auth/github" });
    if (!isObject5(body) || !isString(body.clientId)) throw invalidResponse("\u043D\u0435\u0442 clientId", status);
    return body.clientId;
  }
  /**
   * Возвращает автора, которому принадлежит токен.
   * @param {string} token Токен GitHub.
   * @returns {Promise<Me>} Автор с галереей и записями.
   * @throws {ApiError} Если сервер не принял токен или ответ неожиданный.
   */
  async me(token) {
    const { status, body } = await this.#call({ method: "GET", path: "/api/me", token });
    return parseMe(body, status);
  }
  /**
   * Отправляет запись в галерею автора.
   * @param {string} token Токен GitHub.
   * @param {string} id Идентификатор записи.
   * @param {unknown} record Запись, прошедшая проверку ядра.
   * @returns {Promise<UploadedRecording>} Сведения о записи на сервере.
   * @throws {ApiError} Если сервер отклонил запись или ответ неожиданный.
   */
  async uploadRecording(token, id, record) {
    const { status, body } = await this.#call({
      method: "PUT",
      path: `/api/me/recordings/${encodeURIComponent(id)}`,
      token,
      body: record
    });
    if (!isObject5(body)) throw invalidResponse("\u043D\u0435\u0442 \u0441\u0432\u0435\u0434\u0435\u043D\u0438\u0439 \u043E \u0437\u0430\u043F\u0438\u0441\u0438", status);
    return {
      recording: parseSummary(body.recording, status),
      isNew: status === NEW_RECORDING_STATUS
    };
  }
  /**
   * Удаляет запись из галереи автора.
   * @param {string} token Токен GitHub.
   * @param {string} id Идентификатор записи.
   * @returns {Promise<void>} Готово, когда сервер удалил запись.
   * @throws {ApiError} Если записи нет или сервер отказал.
   */
  async deleteRecording(token, id) {
    await this.#call({
      method: "DELETE",
      path: `/api/me/recordings/${encodeURIComponent(id)}`,
      token
    });
  }
  /**
   * Открывает или закрывает галерею автора.
   * @param {string} token Токен GitHub.
   * @param {boolean} isPublic Показывать галерею в общем списке.
   * @returns {Promise<void>} Готово, когда сервер применил выбор.
   * @throws {ApiError} Если сервер отказал.
   */
  async setGalleryPublic(token, isPublic) {
    await this.#call({ method: "PUT", path: "/api/me/gallery", token, body: { public: isPublic } });
  }
  async #call({ method, path: path20, token, body }) {
    const headers = { Accept: "application/json" };
    if (token !== void 0) headers.Authorization = `Bearer ${token}`;
    if (body !== void 0) headers["Content-Type"] = "application/json";
    const response = await sendRequest(this.#fetch, `${this.#baseUrl}${path20}`, {
      method,
      headers,
      ...body === void 0 ? {} : { body: JSON.stringify(body) }
    });
    const answer = await readJsonBody(response);
    if (!response.ok) throw errorOf(answer, response.status);
    return { status: response.status, body: answer };
  }
};
function isApiError(err, code) {
  return err instanceof ApiError && err.code === code;
}

// src/sharing/authorization.ts
var LOGIN_HINT = "\u0432\u043E\u0439\u0434\u0438\u0442\u0435 \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 cyberzavod login";
async function withToken(sharing, action) {
  const token = await sharing.credentials.read();
  if (token === void 0) throw new CommandError(`\u043D\u0435\u0442 \u0432\u0445\u043E\u0434\u0430: ${LOGIN_HINT}`);
  try {
    return await action(token);
  } catch (err) {
    if (!isApiError(err, UNAUTHORIZED_CODE)) throw err;
    throw new CommandError(`${err.message}: ${LOGIN_HINT}`, { cause: err });
  }
}

// src/sharing/links.ts
var BADGE_ALT = "Built at Cyberzavod";
function recordingLink(siteUrl, slug) {
  return `${siteUrl}/r/?id=${encodeURIComponent(slug)}`;
}
function galleryLink(siteUrl, login2) {
  return `${siteUrl}/gallery/?user=${encodeURIComponent(login2)}`;
}
function badgeMarkdown(siteUrl, login2) {
  const badge = `${siteUrl}/api/badges/${encodeURIComponent(login2)}.svg`;
  return `[![${BADGE_ALT}](${badge})](${galleryLink(siteUrl, login2)})`;
}

// src/commands/gallery.ts
function galleryAccessOf(isPublicRequested, isPrivateRequested) {
  if (isPublicRequested && isPrivateRequested) {
    throw new CommandError("--public \u0438 --private \u0432\u043C\u0435\u0441\u0442\u0435 \u043D\u0435 \u0440\u0430\u0431\u043E\u0442\u0430\u044E\u0442: \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043E\u0434\u043D\u043E");
  }
  if (isPublicRequested) return "public";
  if (isPrivateRequested) return "private";
  return "keep";
}
async function changeAccess(sharing, token, access2) {
  if (access2 !== "keep") await sharing.api.setGalleryPublic(token, access2 === "public");
  return sharing.api.me(token);
}
function describeGallery(sharing, me) {
  const recordingLines2 = me.recordings.map((recording) => {
    const link = recordingLink(sharing.siteUrl, recording.slug);
    return `  ${recording.id}  ${recording.title}
    ${link}`;
  });
  const recordingsTitle = `\u0417\u0430\u043F\u0438\u0441\u0438: ${me.recordings.length} \u0438\u0437 ${me.limit}`;
  if (!me.galleryPublic) {
    return [
      `\u0413\u0430\u043B\u0435\u0440\u0435\u044F ${me.login}: \u0437\u0430\u043A\u0440\u044B\u0442\u0430, \u0437\u0430\u043F\u0438\u0441\u0438 \u0432\u0438\u0434\u043D\u044B \u0442\u043E\u043B\u044C\u043A\u043E \u043F\u043E \u0441\u0441\u044B\u043B\u043A\u0430\u043C`,
      recordingsTitle,
      ...recordingLines2,
      "\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u0433\u0430\u043B\u0435\u0440\u0435\u044E: cyberzavod gallery --public"
    ];
  }
  return [
    `\u0413\u0430\u043B\u0435\u0440\u0435\u044F ${me.login}: \u043E\u0442\u043A\u0440\u044B\u0442\u0430`,
    recordingsTitle,
    ...recordingLines2,
    `\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u0433\u0430\u043B\u0435\u0440\u0435\u0438: ${galleryLink(sharing.siteUrl, me.login)}`,
    `\u0411\u0435\u0439\u0434\u0436 \u0434\u043B\u044F README: ${badgeMarkdown(sharing.siteUrl, me.login)}`,
    "\u0417\u0430\u043A\u0440\u044B\u0442\u044C \u0433\u0430\u043B\u0435\u0440\u0435\u044E: cyberzavod gallery --private"
  ];
}
async function showGallery(sharing, access2) {
  const me = await withToken(sharing, (token) => changeAccess(sharing, token, access2));
  for (const line of describeGallery(sharing, me)) console.log(line);
}

// src/commands/init.ts
import { rename, writeFile as writeFile8 } from "node:fs/promises";
import path15 from "node:path";

// src/detect.ts
import { access } from "node:fs/promises";
import path11 from "node:path";

// src/files.ts
import { readFile as readFile7 } from "node:fs/promises";
async function readOptionalText(file) {
  try {
    return await readFile7(file, "utf8");
  } catch (err) {
    if (isNotFound(err)) return void 0;
    throw err;
  }
}

// src/detect.ts
var LANGUAGE_MARKERS = [
  { file: "package.json", language: "javascript" },
  { file: "tsconfig.json", language: "typescript" },
  { file: "go.mod", language: "go" },
  { file: "pyproject.toml", language: "python" },
  { file: "requirements.txt", language: "python" },
  { file: "Cargo.toml", language: "rust" },
  { file: "pom.xml", language: "java" },
  { file: "build.gradle", language: "java" },
  { file: "build.gradle.kts", language: "kotlin" },
  { file: "Gemfile", language: "ruby" },
  { file: "composer.json", language: "php" }
];
var LOCKFILES = [
  { file: "pnpm-lock.yaml", packageManager: "pnpm" },
  { file: "yarn.lock", packageManager: "yarn" },
  { file: "bun.lock", packageManager: "bun" },
  { file: "bun.lockb", packageManager: "bun" },
  { file: "package-lock.json", packageManager: "npm" },
  { file: "uv.lock", packageManager: "uv" },
  { file: "poetry.lock", packageManager: "poetry" },
  { file: "Cargo.lock", packageManager: "cargo" },
  { file: "go.sum", packageManager: "go" }
];
var FRAMEWORK_DEPENDENCIES = {
  react: "react",
  vue: "vue",
  svelte: "svelte",
  "solid-js": "solid",
  astro: "astro",
  next: "next",
  nuxt: "nuxt",
  "@angular/core": "angular",
  express: "express",
  "@nestjs/core": "nest"
};
var PACKAGE_CHECK_SCRIPT = "check";
var PACKAGE_VERIFICATION_SCRIPTS = ["lint", "typecheck", "test"];
var MAKE_CHECK_TARGET = "check";
var MAKE_TARGET = /^([A-Za-z][\w-]*):(?!=)/gm;
var LANGUAGE_VERIFICATION = {
  go: ["go vet ./...", "go test ./..."],
  rust: ["cargo test"],
  python: ["pytest"]
};
async function exists(file) {
  return access(file).then(
    () => true,
    () => false
  );
}
function keysOf(value) {
  return typeof value === "object" && value !== null ? Object.keys(value) : [];
}
function parseManifest(text) {
  const raw = JSON.parse(text);
  return {
    ...typeof raw.name === "string" ? { name: raw.name } : {},
    ...typeof raw.packageManager === "string" ? { packageManager: raw.packageManager } : {},
    scripts: keysOf(raw.scripts),
    dependencies: [...keysOf(raw.dependencies), ...keysOf(raw.devDependencies)]
  };
}
async function readManifest(root) {
  const text = await readOptionalText(path11.join(root, "package.json"));
  return text === void 0 ? void 0 : parseManifest(text);
}
async function makeTargets(root) {
  const makefile = await readOptionalText(path11.join(root, "Makefile"));
  if (makefile === void 0) return [];
  return [...makefile.matchAll(MAKE_TARGET)].map((match) => match[1] ?? "");
}
async function languageOf(root, marker) {
  const isMarked = await exists(path11.join(root, marker.file));
  return isMarked ? marker.language : void 0;
}
async function languagesOf(root) {
  const found = await Promise.all(LANGUAGE_MARKERS.map((marker) => languageOf(root, marker)));
  const languages = found.filter((language) => language !== void 0);
  return [...new Set(languages)];
}
async function packageManagerOf(root, manifest) {
  const declared = manifest?.packageManager?.split("@")[0];
  if (declared !== void 0 && declared !== "") return declared;
  for (const { file, packageManager } of LOCKFILES) {
    if (await exists(path11.join(root, file))) return packageManager;
  }
  return manifest === void 0 ? void 0 : "npm";
}
function verificationOf({
  manifest,
  packageManager,
  targets,
  languages
}) {
  if (targets.includes(MAKE_CHECK_TARGET)) return [`make ${MAKE_CHECK_TARGET}`];
  const runner = packageManager ?? "npm";
  const scripts = manifest?.scripts ?? [];
  const packageScripts = scripts.includes(PACKAGE_CHECK_SCRIPT) ? [PACKAGE_CHECK_SCRIPT] : PACKAGE_VERIFICATION_SCRIPTS.filter((script) => scripts.includes(script));
  const languageCommands = languages.flatMap((language) => LANGUAGE_VERIFICATION[language] ?? []);
  const packageCommands = packageScripts.map((script) => `${runner} run ${script}`);
  return [...packageCommands, ...languageCommands];
}
async function detectProject(root) {
  const manifest = await readManifest(root);
  const languages = await languagesOf(root);
  const packageManager = await packageManagerOf(root, manifest);
  const targets = await makeTargets(root);
  const dependencies = manifest?.dependencies ?? [];
  const frameworks = Object.entries(FRAMEWORK_DEPENDENCIES).filter(([dependency]) => dependencies.includes(dependency)).map(([, framework]) => framework);
  const hasGit = await exists(path11.join(root, ".git"));
  const makeScripts = targets.map((target) => `make ${target}`);
  return {
    name: manifest?.name ?? path11.basename(root),
    languages,
    frameworks,
    ...packageManager === void 0 ? {} : { packageManager },
    git: hasGit,
    scripts: [...manifest?.scripts ?? [], ...makeScripts],
    verification: verificationOf({ manifest, packageManager, targets, languages })
  };
}
function stackOf(detected) {
  const { languages, frameworks, packageManager } = detected;
  if (packageManager === void 0) return { languages, frameworks };
  return { languages, frameworks, packageManager };
}
function projectIdOf(name) {
  const dashed = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const id = dashed.replace(/^-+|-+$/g, "");
  return id === "" ? "project" : id;
}

// cyberzavod-assets:assets
import { readFileSync as readFileSync3 } from "node:fs";
import { fileURLToPath } from "node:url";
var harness = { "conductor.md": "\u0422\u044B \u0432\u0435\u0434\u0443\u0449\u0438\u0439: \u0441\u0430\u043C \u043A\u043E\u0434 \u043D\u0435 \u043F\u0438\u0448\u0435\u0448\u044C, \u043F\u0435\u0440\u0435\u0434\u0430\u0451\u0448\u044C \u0440\u0430\u0431\u043E\u0442\u0443 \u043C\u0435\u0436\u0434\u0443 \u044D\u0442\u0430\u043F\u0430\u043C\u0438 \u0438 \u0440\u0435\u0448\u0430\u0435\u0448\u044C, \u0447\u0442\u043E \u0434\u0430\u043B\u044C\u0448\u0435. \u042D\u0442\u0430\u043F\u044B \u043F\u0440\u043E\u0446\u0435\u0441\u0441\u0430 \u2014 \u043F\u043E \u043F\u043E\u0440\u044F\u0434\u043A\u0443 \u0432 \u0442\u0430\u0431\u043B\u0438\u0446\u0435 \u043D\u0438\u0436\u0435; \u0443 \u043A\u0430\u0436\u0434\u043E\u0433\u043E \u044D\u0442\u0430\u043F\u0430 \u0441 \u0430\u0433\u0435\u043D\u0442\u043E\u043C \u0441\u0432\u043E\u044F \u0440\u043E\u043B\u044C.\n\n\u0410\u0433\u0435\u043D\u0442 \u044D\u0442\u0430\u043F\u0430 \u043D\u0435 \u0432\u0438\u0434\u0438\u0442 \u044D\u0442\u043E\u0442 \u0440\u0430\u0437\u0433\u043E\u0432\u043E\u0440 \u0438 \u043F\u0440\u043E\u0448\u043B\u044B\u0435 \u0437\u0430\u043F\u0443\u0441\u043A\u0438 \u044D\u0442\u0430\u043F\u043E\u0432. \u0412\u0441\u0451, \u0447\u0442\u043E \u0435\u043C\u0443 \u043D\u0443\u0436\u043D\u043E, \u043F\u0435\u0440\u0435\u0434\u0430\u0432\u0430\u0439 \u0432 \u0437\u0430\u0434\u0430\u043D\u0438\u0438 \u0446\u0435\u043B\u0438\u043A\u043E\u043C. \u041A\u043E\u0440\u043E\u0442\u043A\u0438\u0439 \u043A\u043E\u043D\u0442\u0435\u043A\u0441\u0442 \u2014 \u0433\u043B\u0430\u0432\u043D\u0430\u044F \u044D\u043A\u043E\u043D\u043E\u043C\u0438\u044F, \u043F\u043E\u044D\u0442\u043E\u043C\u0443 \u043F\u0440\u043E\u0446\u0435\u0441\u0441 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u044E\u0442 \u0432 \u043D\u043E\u0432\u043E\u0439 \u0441\u0435\u0441\u0441\u0438\u0438.\n\n\u042D\u0442\u0430\u043F\u044B \u0432\u044B\u0437\u044B\u0432\u0430\u0439 \u0432 \u043F\u0435\u0440\u0435\u0434\u043D\u0435\u043C \u043F\u043B\u0430\u043D\u0435 \u0438 \u0436\u0434\u0438 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442\u0430.\n\n## \u0428\u0430\u0433\u0438\n\n1. **\u0421\u0442\u0430\u0440\u0442.** \u0417\u0430\u0434\u0430\u0447\u0430 \u2014 `$ARGUMENTS`: \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435, \u0441\u0441\u044B\u043B\u043A\u0430 \u0438\u043B\u0438 \u043D\u043E\u043C\u0435\u0440 \u0432 \u0442\u0440\u0435\u043A\u0435\u0440\u0435 \u043F\u0440\u043E\u0435\u043A\u0442\u0430; \u043A\u0430\u043A \u0447\u0438\u0442\u0430\u0442\u044C \u0437\u0430\u0434\u0430\u0447\u0443 \u0438 \u043A\u0443\u0434\u0430 \u043F\u0438\u0441\u0430\u0442\u044C \u2014 \u0432 AGENTS.md. \u0420\u0430\u0431\u043E\u0447\u0430\u044F \u043A\u043E\u043F\u0438\u044F \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u0447\u0438\u0441\u0442\u043E\u0439. \u0415\u0441\u043B\u0438 \u044D\u0442\u043E \u043D\u0435 \u0442\u0430\u043A, \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0441\u044C \u0438 \u0441\u043F\u0440\u043E\u0441\u0438 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430.\n2. **\u041F\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0430.** \u0412\u044B\u0437\u043E\u0432\u0438 \u0430\u043D\u0430\u043B\u0438\u0442\u0438\u043A\u0430 \u0441 \u0437\u0430\u0434\u0430\u0447\u0435\u0439. \u041F\u043E\u043A\u0430\u0436\u0438 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0443 \u043F\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0443 \u0446\u0435\u043B\u0438\u043A\u043E\u043C, \u0432\u043C\u0435\u0441\u0442\u0435 \u0441 \u0432\u043E\u043F\u0440\u043E\u0441\u0430\u043C\u0438, \u0438 \u0436\u0434\u0438 \u043E\u0434\u043E\u0431\u0440\u0435\u043D\u0438\u044F. \u041C\u0435\u043B\u043A\u0438\u0435 \u043F\u0440\u0430\u0432\u043A\u0438 \u0432\u043D\u0435\u0441\u0438 \u0441\u0430\u043C. \u0414\u043B\u044F \u043A\u0440\u0443\u043F\u043D\u044B\u0445 \u0441\u043D\u043E\u0432\u0430 \u0432\u044B\u0437\u043E\u0432\u0438 \u0430\u043D\u0430\u043B\u0438\u0442\u0438\u043A\u0430: \u043F\u0435\u0440\u0435\u0434\u0430\u0439 \u043F\u0440\u043E\u0448\u043B\u0443\u044E \u043F\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0443 \u0438 \u0437\u0430\u043C\u0435\u0447\u0430\u043D\u0438\u044F \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430. \u0415\u0441\u043B\u0438 AGENTS.md \u0432\u0435\u043B\u0438\u0442 \u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C \u043F\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0443, \u0441\u0434\u0435\u043B\u0430\u0439 \u044D\u0442\u043E.\n3. **\u041A\u043E\u0434.** \u0412\u044B\u0437\u043E\u0432\u0438 \u0438\u0441\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044F \u0441 \u043F\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u043E\u0439.\n4. **\u0420\u0435\u0432\u044C\u044E.** \u0412\u044B\u0437\u043E\u0432\u0438 \u0440\u0435\u0432\u044C\u044E\u0435\u0440\u0430 \u0441 \u0437\u0430\u0434\u0430\u0447\u0435\u0439, \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044F\u043C\u0438 \u0433\u043E\u0442\u043E\u0432\u043D\u043E\u0441\u0442\u0438 \u0438 \u043E\u0442\u043A\u043B\u043E\u043D\u0435\u043D\u0438\u044F\u043C\u0438 \u043E\u0442 \u043F\u043B\u0430\u043D\u0430 \u0438\u0437 \u043E\u0442\u0447\u0451\u0442\u0430 \u0438\u0441\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044F. `\u041D\u0410 \u0414\u041E\u0420\u0410\u0411\u041E\u0422\u041A\u0423` \u2014 \u0432\u043E\u0437\u0432\u0440\u0430\u0442.\n5. **\u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0438.** \u0412\u044B\u0437\u043E\u0432\u0438 \u0442\u0435\u0441\u0442\u0438\u0440\u043E\u0432\u0449\u0438\u043A\u0430 \u0441 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044F\u043C\u0438 \u0433\u043E\u0442\u043E\u0432\u043D\u043E\u0441\u0442\u0438. `\u0414\u0415\u0424\u0415\u041A\u0422` \u2014 \u0432\u043E\u0437\u0432\u0440\u0430\u0442, `\u041F\u0420\u041E\u0412\u0415\u0420\u041A\u0418 \u041F\u0420\u041E\u0419\u0414\u0415\u041D\u042B` \u0438\u043B\u0438 `\u0413\u041E\u0422\u041E\u0412\u041E` \u2014 \u0444\u0438\u043A\u0441\u0430\u0446\u0438\u044F.\n6. **\u0424\u0438\u043A\u0441\u0430\u0446\u0438\u044F.** \u041F\u043E \u043F\u0440\u0430\u0432\u0438\u043B\u0430\u043C \u044D\u0442\u0430\u043F\u0430 \xAB\u0424\u0438\u043A\u0441\u0430\u0446\u0438\u044F\xBB \u043D\u0438\u0436\u0435.\n7. **\u041E\u0442\u0447\u0451\u0442 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0443:**\n   - \u0447\u0442\u043E \u0441\u0434\u0435\u043B\u0430\u043D\u043E \u0438 \u0447\u0435\u043C \u043E\u0442\u043B\u0438\u0447\u0430\u0435\u0442\u0441\u044F \u043E\u0442 \u043E\u0434\u043E\u0431\u0440\u0435\u043D\u043D\u043E\u0433\u043E \u043F\u043B\u0430\u043D\u0430;\n   - \u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0431\u044B\u043B\u043E \u0432\u043E\u0437\u0432\u0440\u0430\u0442\u043E\u0432 \u0438 \u043D\u0430 \u043A\u0430\u043A\u043E\u0439 \u043C\u043E\u0434\u0435\u043B\u0438 \u0438\u0441\u043F\u0440\u0430\u0432\u043B\u044F\u043B\u0438;\n   - \u043A\u043E\u043C\u043C\u0438\u0442\u044B \u0438, \u0435\u0441\u043B\u0438 \u0431\u044B\u043B\u0430, \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044F.\n\n## \u0412\u043E\u0437\u0432\u0440\u0430\u0442\u044B\n\n\u0412\u043E\u0437\u0432\u0440\u0430\u0442\u044B \u043E\u0442 \u0440\u0435\u0432\u044C\u044E, \u043F\u0440\u043E\u0432\u0435\u0440\u043E\u043A \u0438 \u0444\u0438\u043A\u0441\u0430\u0446\u0438\u0438 \u0441\u0447\u0438\u0442\u0430\u044E\u0442\u0441\u044F \u0432\u043C\u0435\u0441\u0442\u0435.\n\n1. **\u041F\u0435\u0440\u0432\u044B\u0439** \u2014 \u0438\u0441\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C \u043D\u0430 \u0441\u0432\u043E\u0435\u0439 \u043C\u043E\u0434\u0435\u043B\u0438.\n2. **\u0412\u0442\u043E\u0440\u043E\u0439** \u2014 \u0438\u0441\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C \u043D\u0430 \u0431\u043E\u043B\u0435\u0435 \u0441\u0438\u043B\u044C\u043D\u043E\u0439 \u043C\u043E\u0434\u0435\u043B\u0438: \u043F\u0440\u0435\u0436\u043D\u044F\u044F \u0443\u0436\u0435 \u043D\u0435 \u0441\u043F\u0440\u0430\u0432\u0438\u043B\u0430\u0441\u044C \u0434\u0432\u0430\u0436\u0434\u044B.\n3. **\u0422\u0440\u0435\u0442\u0438\u0439** \u2014 \u0441\u0442\u043E\u043F \u0438 \u0447\u0435\u043B\u043E\u0432\u0435\u043A: \u043F\u043E\u043A\u0430\u0436\u0438 \u043E\u0441\u0442\u0430\u0432\u0448\u0438\u0435\u0441\u044F \u0437\u0430\u043C\u0435\u0447\u0430\u043D\u0438\u044F \u0438 \u0447\u0442\u043E \u0443\u0436\u0435 \u043F\u0440\u043E\u0431\u043E\u0432\u0430\u043B\u0438.\n\n\u041D\u0430 \u0434\u043E\u0440\u0430\u0431\u043E\u0442\u043A\u0443 \u0438\u0441\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C \u043F\u043E\u043B\u0443\u0447\u0430\u0435\u0442 \u043F\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0443, \u0437\u0430\u043C\u0435\u0447\u0430\u043D\u0438\u044F \u0432\u0441\u0435\u0445 \u043F\u0440\u043E\u0448\u043B\u044B\u0445 \u043A\u0440\u0443\u0433\u043E\u0432 \u0438 \u043E\u0442\u0447\u0451\u0442 \u0441\u0432\u043E\u0435\u0439 \u043F\u0440\u043E\u0448\u043B\u043E\u0439 \u043F\u043E\u043F\u044B\u0442\u043A\u0438. \u0411\u0435\u0437 \u044D\u0442\u043E\u0433\u043E \u043E\u043D \u0447\u0438\u043D\u0438\u0442 \u0432\u0441\u043B\u0435\u043F\u0443\u044E \u0438 \u043B\u043E\u043C\u0430\u0435\u0442 \u0434\u0440\u0443\u0433\u0438\u0435 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0438. \u041F\u043E\u0441\u043B\u0435 \u0438\u0441\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u044F \u2014 \u0441\u043D\u043E\u0432\u0430 \u0440\u0435\u0432\u044C\u044E \u0438 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438.\n\n\u0415\u0441\u043B\u0438 \u0438\u0441\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C \u043E\u0431\u043E\u0441\u043D\u043E\u0432\u0430\u043D\u043D\u043E \u043D\u0435 \u0441\u043E\u0433\u043B\u0430\u0441\u0435\u043D \u0441 \u0437\u0430\u043C\u0435\u0447\u0430\u043D\u0438\u0435\u043C, \u0440\u0435\u0448\u0438 \u0441\u0430\u043C \u0438\u043B\u0438 \u0441\u043F\u0440\u043E\u0441\u0438 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430, \u0430 \u043D\u0435 \u0433\u043E\u043D\u044F\u0439 \u043A\u0440\u0443\u0433 \u0437\u0430\u043D\u043E\u0432\u043E.\n\n## \u041E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0430 \u043F\u043E\u0441\u0440\u0435\u0434\u0438 \u043F\u0440\u043E\u0446\u0435\u0441\u0441\u0430\n\n\u0415\u0441\u043B\u0438 \u043F\u0440\u043E\u0435\u043A\u0442 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u043B \u0445\u0443\u043A \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0438, \u043E\u043D \u043D\u0435 \u0434\u0430\u0441\u0442 \u0437\u0430\u043A\u043E\u043D\u0447\u0438\u0442\u044C \u0445\u043E\u0434 \u0441 \u043A\u0440\u0430\u0441\u043D\u044B\u043C\u0438 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0430\u043C\u0438, \u0435\u0441\u043B\u0438 \u043A\u043E\u0434 \u0432 \u044D\u0442\u043E\u043C \u0445\u043E\u0434\u0435 \u043C\u0435\u043D\u044F\u043B\u0441\u044F. \u0421\u0430\u043C \u043A\u043E\u0434 \u0440\u0430\u0434\u0438 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0438 \u043D\u0435 \u0447\u0438\u043D\u0438. \u0415\u0441\u043B\u0438 \u043D\u0443\u0436\u043D\u043E \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C\u0441\u044F \u2014 \u0440\u0430\u0434\u0438 \u0432\u043E\u043F\u0440\u043E\u0441\u0430 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0443 \u0438\u043B\u0438 \u043D\u0430 \u0442\u0440\u0435\u0442\u044C\u0435\u043C \u0432\u043E\u0437\u0432\u0440\u0430\u0442\u0435, \u2014 \u0430 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u043A\u0440\u0430\u0441\u043D\u044B\u0435, \u0441\u043E\u0445\u0440\u0430\u043D\u0438 \u043F\u043E\u043F\u044B\u0442\u043A\u0443 \u0432 stash \u0441 \u043F\u043E\u043D\u044F\u0442\u043D\u044B\u043C \u0438\u043C\u0435\u043D\u0435\u043C: \u0440\u0430\u0431\u043E\u0447\u0430\u044F \u043A\u043E\u043F\u0438\u044F \u0441\u0442\u0430\u043D\u0435\u0442 \u0447\u0438\u0441\u0442\u043E\u0439, \u0438 \u0445\u0443\u043A \u043E\u0442\u043F\u0443\u0441\u0442\u0438\u0442. \u0415\u0441\u043B\u0438 \u043F\u0440\u043E\u0446\u0435\u0441\u0441 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u0441\u044F, \u043F\u0435\u0440\u0432\u044B\u043C \u0434\u0435\u043B\u043E\u043C \u0432\u0435\u0440\u043D\u0438 \u043F\u043E\u043F\u044B\u0442\u043A\u0443. \u0415\u0441\u043B\u0438 \u044D\u0442\u043E \u0444\u0438\u043D\u0430\u043B\u044C\u043D\u0430\u044F \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0430, \u0441\u043A\u0430\u0436\u0438 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0443, \u0447\u0442\u043E \u043F\u043E\u043F\u044B\u0442\u043A\u0430 \u043B\u0435\u0436\u0438\u0442 \u0432 stash.\n", "principles/architecture.md": "## \u0410\u0440\u0445\u0438\u0442\u0435\u043A\u0442\u0443\u0440\u0430\n\n- \u0417\u0430\u0432\u0438\u0441\u0438\u043C\u043E\u0441\u0442\u0438 \u043D\u0430\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u044B \u0432\u043D\u0443\u0442\u0440\u044C: \u043F\u0440\u0435\u0434\u043C\u0435\u0442\u043D\u0430\u044F \u043B\u043E\u0433\u0438\u043A\u0430 \u043D\u0435 \u0437\u043D\u0430\u0435\u0442 \u043E \u0444\u0440\u0435\u0439\u043C\u0432\u043E\u0440\u043A\u0435, \u0431\u0430\u0437\u0435, \u0441\u0435\u0442\u0438 \u0438 \u0438\u043D\u0442\u0435\u0440\u0444\u0435\u0439\u0441\u0435 \u2014 \u0442\u043E\u043B\u044C\u043A\u043E \u043E \u0441\u0432\u043E\u0438\u0445 \u0442\u0438\u043F\u0430\u0445 \u0438 \u0438\u043D\u0442\u0435\u0440\u0444\u0435\u0439\u0441\u0430\u0445.\n- \u0420\u0430\u0441\u0448\u0438\u0440\u0435\u043D\u0438\u0435 \u2014 \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u0438\u0435\u043C, \u0430 \u043D\u0435 \u043F\u0440\u0430\u0432\u043A\u043E\u0439 \u043F\u043E \u0432\u0441\u0435\u043C\u0443 \u043F\u0440\u043E\u0435\u043A\u0442\u0443: \u043D\u043E\u0432\u044B\u0439 \u0432\u0430\u0440\u0438\u0430\u043D\u0442 \u2014 \u043D\u043E\u0432\u044B\u0439 \u0447\u043B\u0435\u043D \u0442\u0438\u043F\u0430 \u0438\u043B\u0438 \u043D\u043E\u0432\u0430\u044F \u0440\u0435\u0430\u043B\u0438\u0437\u0430\u0446\u0438\u044F \u0438\u043D\u0442\u0435\u0440\u0444\u0435\u0439\u0441\u0430, \u0432\u0435\u0442\u0432\u043B\u0435\u043D\u0438\u0435 \u043F\u043E \u0432\u0430\u0440\u0438\u0430\u043D\u0442\u0443 \u2014 \u0438\u0441\u0447\u0435\u0440\u043F\u044B\u0432\u0430\u044E\u0449\u0435\u0435, \u0447\u0442\u043E\u0431\u044B \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u043D\u044B\u0439 \u0441\u043B\u0443\u0447\u0430\u0439 \u043B\u043E\u0432\u0438\u043B \u043A\u043E\u043C\u043F\u0438\u043B\u044F\u0442\u043E\u0440 \u0438\u043B\u0438 \u0442\u0435\u0441\u0442.\n- \u0410\u0431\u0441\u0442\u0440\u0430\u043A\u0446\u0438\u044F \u2014 \u043A\u043E\u0433\u0434\u0430 \u043F\u043E\u044F\u0432\u0438\u043B\u0441\u044F \u0432\u0442\u043E\u0440\u043E\u0439 \u0440\u0435\u0430\u043B\u044C\u043D\u044B\u0439 \u0441\u043B\u0443\u0447\u0430\u0439. \u041D\u0435 \u0437\u0430\u0432\u043E\u0434\u0438\u0442\u044C \u0438\u043D\u0442\u0435\u0440\u0444\u0435\u0439\u0441, \u0444\u0430\u0431\u0440\u0438\u043A\u0443 \u0438\u043B\u0438 \u043F\u0430\u0440\u0430\u043C\u0435\u0442\u0440 \xAB\u043D\u0430 \u0431\u0443\u0434\u0443\u0449\u0435\u0435\xBB.\n- \u041E\u0434\u0438\u043D \u0438\u0441\u0442\u043E\u0447\u043D\u0438\u043A \u043F\u0440\u0430\u0432\u0434\u044B: \u043E\u0434\u043D\u043E \u043F\u043E\u043D\u044F\u0442\u0438\u0435 \u043E\u043F\u0438\u0441\u0430\u043D\u043E \u0432 \u043E\u0434\u043D\u043E\u043C \u043C\u0435\u0441\u0442\u0435, \u043E\u0441\u0442\u0430\u043B\u044C\u043D\u044B\u0435 \u0435\u0433\u043E \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u044E\u0442, \u0430 \u043D\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u044F\u044E\u0442.\n", "principles/change-scope.md": "## \u041E\u0431\u044A\u0451\u043C \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0439\n\n- \u0414\u0435\u043B\u0430\u0439 \u0442\u043E, \u043E \u0447\u0451\u043C \u0437\u0430\u0434\u0430\u0447\u0430, \u0438 \u043D\u0435 \u0431\u043E\u043B\u044C\u0448\u0435. \u0417\u0430\u043C\u0435\u0447\u0435\u043D\u043D\u043E\u0435 \u043F\u043E \u043F\u0443\u0442\u0438, \u043D\u043E \u043D\u0435 \u043E\u0442\u043D\u043E\u0441\u044F\u0449\u0435\u0435\u0441\u044F \u043A \u0437\u0430\u0434\u0430\u0447\u0435, \u043D\u0430\u0437\u044B\u0432\u0430\u0439 \u0432 \u043E\u0442\u0447\u0451\u0442\u0435, \u0430 \u043D\u0435 \u0447\u0438\u043D\u0438 \u043C\u043E\u043B\u0447\u0430.\n- \u041D\u0435 \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u0439 \u0441\u0442\u0430\u0440\u043E\u0435 \u0440\u0430\u0434\u0438 \u0441\u0442\u0430\u0440\u043E\u0433\u043E: \u0435\u0441\u043B\u0438 \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0435 \u0434\u0435\u043B\u0430\u0435\u0442 \u043A\u043E\u0434 \u043D\u0435\u043D\u0443\u0436\u043D\u044B\u043C, \u0443\u0434\u0430\u043B\u0438 \u0435\u0433\u043E, \u0431\u0435\u0437 \u0441\u043B\u043E\u0451\u0432 \u0441\u043E\u0432\u043C\u0435\u0441\u0442\u0438\u043C\u043E\u0441\u0442\u0438, \u043A\u043E\u0442\u043E\u0440\u044B\u0435 \u043D\u0438\u043A\u0442\u043E \u043D\u0435 \u043F\u0440\u043E\u0441\u0438\u043B.\n- \u041D\u0435\u0431\u043E\u043B\u044C\u0448\u0438\u0435 \u0441\u0432\u044F\u0437\u043D\u044B\u0435 \u043A\u043E\u043C\u043C\u0438\u0442\u044B: \u043E\u0434\u0438\u043D \u043A\u043E\u043C\u043C\u0438\u0442 \u2014 \u043E\u0434\u043D\u043E \u0437\u0430\u043A\u043E\u043D\u0447\u0435\u043D\u043D\u043E\u0435 \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0435, \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u0437\u0435\u043B\u0451\u043D\u044B\u0435.\n- \u0420\u0430\u0437\u0432\u0438\u043B\u043A\u0443, \u043A\u043E\u0442\u043E\u0440\u0443\u044E \u043D\u0435 \u0440\u0435\u0448\u0438\u0442\u044C \u043F\u043E \u043A\u043E\u0434\u0443 \u0438 \u043F\u0440\u0430\u0432\u0438\u043B\u0430\u043C \u043F\u0440\u043E\u0435\u043A\u0442\u0430, \u043D\u0435 \u0440\u0435\u0448\u0430\u0439 \u0441\u0430\u043C \u2014 \u0441\u043F\u0440\u043E\u0441\u0438 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430.\n", "principles/engineering.md": "## \u0418\u043D\u0436\u0435\u043D\u0435\u0440\u043D\u044B\u0435 \u043F\u0440\u0438\u043D\u0446\u0438\u043F\u044B\n\n- \u041A\u043E\u0434 \u0447\u0438\u0442\u0430\u0435\u0442\u0441\u044F \u043A\u0430\u043A \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0442\u043E\u0433\u043E, \u0447\u0442\u043E \u043E\u043D \u0434\u0435\u043B\u0430\u0435\u0442: \u0438\u043C\u0435\u043D\u0430 \u0438\u0437 \u043F\u0440\u0435\u0434\u043C\u0435\u0442\u043D\u043E\u0439 \u043E\u0431\u043B\u0430\u0441\u0442\u0438 \u043F\u0440\u043E\u0435\u043A\u0442\u0430, \u0431\u0435\u0437 `data`, `item`, `handle`, `process` \u0438 \u0431\u0435\u0437 \u0441\u043E\u043A\u0440\u0430\u0449\u0435\u043D\u0438\u0439, \u043A\u0440\u043E\u043C\u0435 \u043E\u0431\u0449\u0435\u043F\u0440\u0438\u043D\u044F\u0442\u044B\u0445.\n- \u041E\u0434\u043D\u0430 \u0444\u0443\u043D\u043A\u0446\u0438\u044F \u2014 \u043E\u0434\u043D\u043E \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435. \u0415\u0441\u043B\u0438 \u0444\u0443\u043D\u043A\u0446\u0438\u044E \u043D\u0435\u043B\u044C\u0437\u044F \u043D\u0430\u0437\u0432\u0430\u0442\u044C \u0431\u0435\u0437 \xAB\u0438\xBB, \u0435\u0451 \u043D\u0430\u0434\u043E \u0440\u0430\u0437\u0434\u0435\u043B\u0438\u0442\u044C. \u0422\u0435\u043B\u043E \u0447\u0438\u0442\u0430\u0435\u0442\u0441\u044F \u0441\u0432\u0435\u0440\u0445\u0443 \u0432\u043D\u0438\u0437: \u0441\u043D\u0430\u0447\u0430\u043B\u0430 \u0440\u0430\u043D\u043D\u0438\u0435 \u0432\u044B\u0445\u043E\u0434\u044B, \u043F\u043E\u0442\u043E\u043C \u043E\u0441\u043D\u043E\u0432\u043D\u043E\u0439 \u043F\u0443\u0442\u044C.\n- \u041E\u0448\u0438\u0431\u043A\u0438 \u043D\u0435 \u0433\u043B\u043E\u0442\u0430\u044E\u0442\u0441\u044F: \u0438\u0445 \u043E\u0431\u0440\u0430\u0431\u0430\u0442\u044B\u0432\u0430\u044E\u0442 \u0438\u043B\u0438 \u0432\u043E\u0437\u0432\u0440\u0430\u0449\u0430\u044E\u0442 \u0441 \u043A\u043E\u043D\u0442\u0435\u043A\u0441\u0442\u043E\u043C.\n- \u0411\u0435\u0437 \u043C\u0430\u0433\u0438\u0447\u0435\u0441\u043A\u0438\u0445 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0439: \u0447\u0438\u0441\u043B\u0430 \u0438 \u0441\u0442\u0440\u043E\u043A\u0438 \u0441\u043E \u0441\u043C\u044B\u0441\u043B\u043E\u043C \u043F\u043E\u043B\u0443\u0447\u0430\u044E\u0442 \u0438\u043C\u044F.\n- \u041A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439 \u043E\u0431\u044A\u044F\u0441\u043D\u044F\u0435\u0442 \xAB\u043F\u043E\u0447\u0435\u043C\u0443\xBB, \u043A\u043E\u0433\u0434\u0430 \u044D\u0442\u043E \u043D\u0435 \u0432\u0438\u0434\u043D\u043E \u0438\u0437 \u043A\u043E\u0434\u0430. \u041F\u0435\u0440\u0435\u0441\u043A\u0430\u0437 \u043A\u043E\u0434\u0430, \u0437\u0430\u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u0439 \u0438 \u043C\u0451\u0440\u0442\u0432\u044B\u0439 \u043A\u043E\u0434 \u043D\u0435 \u0434\u043E\u043F\u0443\u0441\u043A\u0430\u044E\u0442\u0441\u044F.\n- \u041D\u043E\u0432\u0430\u044F \u043B\u043E\u0433\u0438\u043A\u0430 \u2014 \u0441 \u0442\u0435\u0441\u0442\u043E\u043C \u0440\u044F\u0434\u043E\u043C. \u0422\u0435\u0441\u0442 \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u0435\u0442 \u043F\u043E\u0432\u0435\u0434\u0435\u043D\u0438\u0435, \u0430 \u043D\u0435 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E \u043A\u043E\u0434\u0430.\n", "principles/readability.md": "## \u0427\u0438\u0442\u0430\u0435\u043C\u043E\u0441\u0442\u044C \u043A\u043E\u0434\u0430\n\n\u041A\u043E\u0434 \u0447\u0438\u0442\u0430\u044E\u0442 \u0447\u0430\u0449\u0435, \u0447\u0435\u043C \u043F\u0438\u0448\u0443\u0442: \u043E\u043D \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043F\u043E\u043D\u044F\u0442\u0435\u043D \u0441 \u043F\u0435\u0440\u0432\u043E\u0433\u043E \u043F\u0440\u043E\u0447\u0442\u0435\u043D\u0438\u044F, \u0440\u0430\u0441\u0448\u0438\u0440\u044F\u0442\u044C\u0441\u044F \u0431\u0435\u0437 \u043F\u0435\u0440\u0435\u0434\u0435\u043B\u043A\u0438 \u0438 \u0432\u044B\u0433\u043B\u044F\u0434\u0435\u0442\u044C \u043E\u043F\u0440\u044F\u0442\u043D\u043E. \u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0434\u0435\u0439\u0441\u0442\u0432\u0443\u044E\u0442 \u0443\u0441\u0442\u043E\u044F\u0432\u0448\u0438\u0435\u0441\u044F \u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u044F\u0437\u044B\u043A\u0430 \u043F\u0440\u043E\u0435\u043A\u0442\u0430 \u2014 \u0435\u0433\u043E \u0441\u0442\u0438\u043B\u044C-\u0433\u0430\u0439\u0434, \u0444\u043E\u0440\u043C\u0430\u0442\u0442\u0435\u0440 \u0438 \u043B\u0438\u043D\u0442\u0435\u0440\u044B; \u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u043D\u0438\u0436\u0435 \u2014 \u0441\u0432\u0435\u0440\u0445 \u043D\u0438\u0445, \u0442\u0430\u043C, \u0433\u0434\u0435 \u044F\u0437\u044B\u043A \u043D\u0435 \u0440\u0435\u0448\u0430\u0435\u0442 \u0441\u0430\u043C.\n\n- \u041F\u0440\u043E\u043C\u0435\u0436\u0443\u0442\u043E\u0447\u043D\u044B\u0439 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442 \u043F\u043E\u043B\u0443\u0447\u0430\u0435\u0442 \u0438\u043C\u044F. \u0412 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0435 \u0432\u044B\u0437\u043E\u0432\u0430 \u2014 \u043D\u0435 \u0431\u043E\u043B\u044C\u0448\u0435 \u043E\u0434\u043D\u043E\u0433\u043E \u0432\u043B\u043E\u0436\u0435\u043D\u043D\u043E\u0433\u043E \u0432\u044B\u0437\u043E\u0432\u0430: \u0432\u043C\u0435\u0441\u0442\u043E `toSet(filter(map(list)))` \u2014 \u043F\u0435\u0440\u0435\u043C\u0435\u043D\u043D\u044B\u0435 \u0441 \u0438\u043C\u0435\u043D\u0430\u043C\u0438 \u0448\u0430\u0433\u043E\u0432. \u0414\u043B\u0438\u043D\u043D\u0430\u044F \u0446\u0435\u043F\u043E\u0447\u043A\u0430 \u043F\u0440\u0435\u043E\u0431\u0440\u0430\u0437\u043E\u0432\u0430\u043D\u0438\u0439 \u0440\u0430\u0437\u0431\u0438\u0432\u0430\u0435\u0442\u0441\u044F \u043D\u0430 \u0448\u0430\u0433\u0438 \u0441\u043E \u0441\u043C\u044B\u0441\u043B\u043E\u043C.\n- \u0423\u0441\u043B\u043E\u0432\u0438\u0435 \u0441\u043E \u0441\u043C\u044B\u0441\u043B\u043E\u043C \u043F\u043E\u043B\u0443\u0447\u0430\u0435\u0442 \u0438\u043C\u044F: `isExpired`, \u0430 \u043D\u0435 \u0434\u043B\u0438\u043D\u043D\u043E\u0435 \u0432\u044B\u0440\u0430\u0436\u0435\u043D\u0438\u0435 \u0432\u043D\u0443\u0442\u0440\u0438 `if`. \u0423\u0441\u043B\u043E\u0432\u043D\u044B\u0435 \u0432\u044B\u0440\u0430\u0436\u0435\u043D\u0438\u044F \u043D\u0435 \u0432\u043A\u043B\u0430\u0434\u044B\u0432\u0430\u044E\u0442\u0441\u044F \u0434\u0440\u0443\u0433 \u0432 \u0434\u0440\u0443\u0433\u0430.\n- \u041F\u0443\u0441\u0442\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430 \u0440\u0430\u0437\u0434\u0435\u043B\u044F\u0435\u0442 \u0441\u043C\u044B\u0441\u043B\u043E\u0432\u044B\u0435 \u0431\u043B\u043E\u043A\u0438: \u0440\u0430\u043D\u043D\u0438\u0435 \u0432\u044B\u0445\u043E\u0434\u044B \u2014 \u043E\u0442 \u043E\u0441\u043D\u043E\u0432\u043D\u043E\u0433\u043E \u043F\u0443\u0442\u0438, \u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043A\u0443 \u2014 \u043E\u0442 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F, \u043C\u043D\u043E\u0433\u043E\u0441\u0442\u0440\u043E\u0447\u043D\u044B\u0439 \u0431\u043B\u043E\u043A \u2014 \u043E\u0442 \u0441\u043E\u0441\u0435\u0434\u043D\u0438\u0445 \u0441\u0442\u0440\u043E\u043A. \u041F\u043B\u043E\u0442\u043D\u044B\u0439 \u0442\u0435\u043A\u0441\u0442 \u0431\u0435\u0437 \u043F\u0443\u0441\u0442\u044B\u0445 \u0441\u0442\u0440\u043E\u043A \u0438 \u043F\u0443\u0441\u0442\u044B\u0435 \u0441\u0442\u0440\u043E\u043A\u0438 \u0432\u043D\u0443\u0442\u0440\u0438 \u043E\u0434\u043D\u043E\u0439 \u043C\u044B\u0441\u043B\u0438 \u043E\u0434\u0438\u043D\u0430\u043A\u043E\u0432\u043E \u043C\u0435\u0448\u0430\u044E\u0442 \u0447\u0438\u0442\u0430\u0442\u044C.\n- \u0412\u043B\u043E\u0436\u0435\u043D\u043D\u043E\u0441\u0442\u044C \u2014 \u043D\u0435 \u0433\u043B\u0443\u0431\u0436\u0435 \u0434\u0432\u0443\u0445 \u0443\u0440\u043E\u0432\u043D\u0435\u0439. \u0413\u043B\u0443\u0431\u0436\u0435 \u2014 \u0440\u0430\u043D\u043D\u0438\u0439 \u0432\u044B\u0445\u043E\u0434 \u0438\u043B\u0438 \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u0430\u044F \u0444\u0443\u043D\u043A\u0446\u0438\u044F.\n- \u0424\u0443\u043D\u043A\u0446\u0438\u044F \u0434\u0435\u0440\u0436\u0438\u0442 \u043E\u0434\u0438\u043D \u0443\u0440\u043E\u0432\u0435\u043D\u044C \u0430\u0431\u0441\u0442\u0440\u0430\u043A\u0446\u0438\u0438: \u043B\u0438\u0431\u043E \u043D\u0430\u0437\u044B\u0432\u0430\u0435\u0442 \u0448\u0430\u0433\u0438, \u043B\u0438\u0431\u043E \u0434\u0435\u043B\u0430\u0435\u0442 \u0440\u0430\u0431\u043E\u0442\u0443 \u0440\u0443\u043A\u0430\u043C\u0438.\n- \u0424\u043B\u0430\u0433 \u043D\u0435 \u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0430\u0435\u0442 \u043F\u043E\u0432\u0435\u0434\u0435\u043D\u0438\u0435 \u0444\u0443\u043D\u043A\u0446\u0438\u0438: \u0434\u0432\u0430 \u043F\u043E\u0432\u0435\u0434\u0435\u043D\u0438\u044F \u2014 \u0434\u0432\u0435 \u0444\u0443\u043D\u043A\u0446\u0438\u0438. \u041C\u043D\u043E\u0433\u043E \u043F\u0430\u0440\u0430\u043C\u0435\u0442\u0440\u043E\u0432 \u2014 \u043E\u0434\u0438\u043D \u043E\u0431\u044A\u0435\u043A\u0442 \u0441 \u0438\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u043D\u044B\u043C\u0438 \u043F\u043E\u043B\u044F\u043C\u0438.\n- \u0412\u0445\u043E\u0434\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435 \u043D\u0435 \u043C\u0435\u043D\u044F\u044E\u0442\u0441\u044F: \u0444\u0443\u043D\u043A\u0446\u0438\u044F \u0432\u043E\u0437\u0432\u0440\u0430\u0449\u0430\u0435\u0442 \u043D\u043E\u0432\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435. \u041F\u0435\u0440\u0435\u043C\u0435\u043D\u043D\u0430\u044F \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E \u043D\u0435\u0438\u0437\u043C\u0435\u043D\u044F\u0435\u043C\u0430\u044F.\n- \u0418\u043C\u0435\u043D\u0430 \u0431\u0435\u0437 \u043E\u0442\u0440\u0438\u0446\u0430\u043D\u0438\u0439 (`isValid`, \u0430 \u043D\u0435 `isNotInvalid`); \u0431\u0443\u043B\u0435\u0432\u044B \u0438\u043C\u0435\u043D\u0430 \u2014 \u0432\u043E\u043F\u0440\u043E\u0441 \u0441 \u043E\u0442\u0432\u0435\u0442\u043E\u043C \xAB\u0434\u0430\xBB \u0438\u043B\u0438 \xAB\u043D\u0435\u0442\xBB: `is`, `has`, `can`.\n", "principles/safety.md": "## \u0411\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u044C\n\n- \u0412 \u043A\u043E\u0434, \u0436\u0443\u0440\u043D\u0430\u043B \u0438 \u0437\u0430\u043F\u0438\u0441\u0438 \u043D\u0435 \u043F\u043E\u043F\u0430\u0434\u0430\u044E\u0442 \u043A\u043B\u044E\u0447\u0438, \u0442\u043E\u043A\u0435\u043D\u044B, \u043F\u0430\u0440\u043E\u043B\u0438, \u0430\u0434\u0440\u0435\u0441\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u043E\u0432 \u0438 \u043B\u0438\u0447\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435.\n- \u0424\u0430\u0439\u043B\u044B \u0441 \u0441\u0435\u043A\u0440\u0435\u0442\u0430\u043C\u0438 (`.env` \u0438 \u043F\u043E\u0434\u043E\u0431\u043D\u044B\u0435) \u043D\u0435 \u0447\u0438\u0442\u0430\u044E\u0442\u0441\u044F \u0438 \u043D\u0435 \u043F\u0440\u0430\u0432\u044F\u0442\u0441\u044F.\n- \u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u043D\u0435 \u043E\u0431\u0445\u043E\u0434\u044F\u0442 \u0438 \u043D\u0435 \u043E\u0442\u043A\u043B\u044E\u0447\u0430\u044E\u0442: \u043A\u0440\u0430\u0441\u043D\u0430\u044F \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0430 \u2014 \u044D\u0442\u043E \u0440\u0430\u0431\u043E\u0442\u0430, \u0430 \u043D\u0435 \u043F\u043E\u043C\u0435\u0445\u0430.\n- \u041D\u0435\u043E\u0431\u0440\u0430\u0442\u0438\u043C\u043E\u0435 (\u0443\u0434\u0430\u043B\u0435\u043D\u0438\u0435 \u0434\u0430\u043D\u043D\u044B\u0445, \u043F\u0435\u0440\u0435\u043F\u0438\u0441\u044B\u0432\u0430\u043D\u0438\u0435 \u0438\u0441\u0442\u043E\u0440\u0438\u0438, \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044F) \u2014 \u0442\u043E\u043B\u044C\u043A\u043E \u0441 \u044F\u0432\u043D\u043E\u0433\u043E \u0441\u043E\u0433\u043B\u0430\u0441\u0438\u044F \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430.\n", "README.md": "# Harness\n\n\u041F\u0440\u043E\u0446\u0435\u0441\u0441 \u0440\u0430\u0437\u0440\u0430\u0431\u043E\u0442\u043A\u0438, \u043A\u043E\u0442\u043E\u0440\u044B\u0439 Cyberzavod \u0434\u0430\u0451\u0442 \u043A\u0430\u0436\u0434\u043E\u043C\u0443 \u043F\u0440\u043E\u0435\u043A\u0442\u0443, \u2014 \u043D\u0435\u0437\u0430\u0432\u0438\u0441\u0438\u043C\u043E \u043E\u0442 \u044F\u0437\u044B\u043A\u0430, \u0444\u0440\u0435\u0439\u043C\u0432\u043E\u0440\u043A\u0430 \u0438 \u043C\u043E\u0434\u0435\u043B\u0438. \u0410\u0434\u0430\u043F\u0442\u0435\u0440 \u0430\u0433\u0435\u043D\u0442\u0430 (\u043F\u0435\u0440\u0432\u044B\u0439 \u2014 Claude Code) \u043F\u0440\u0435\u0432\u0440\u0430\u0449\u0430\u0435\u0442 \u044D\u0442\u0438 \u0442\u0435\u043A\u0441\u0442\u044B \u0432 \u0444\u0430\u0439\u043B\u044B, \u043A\u043E\u0442\u043E\u0440\u044B\u0435 \u043F\u043E\u043D\u0438\u043C\u0430\u0435\u0442 \u0435\u0433\u043E \u0430\u0433\u0435\u043D\u0442; \u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u043A\u043E\u043D\u043A\u0440\u0435\u0442\u043D\u043E\u0433\u043E \u043F\u0440\u043E\u0435\u043A\u0442\u0430 \u043B\u0435\u0436\u0430\u0442 \u0432 \u0435\u0433\u043E AGENTS.md.\n\n- `principles/` \u2014 \u043F\u0440\u0438\u043D\u0446\u0438\u043F\u044B, \u043E\u0431\u0449\u0438\u0435 \u0434\u043B\u044F \u0432\u0441\u0435\u0445 \u044D\u0442\u0430\u043F\u043E\u0432: \u0438\u043D\u0436\u0435\u043D\u0435\u0440\u0438\u044F, \u0447\u0438\u0442\u0430\u0435\u043C\u043E\u0441\u0442\u044C \u043A\u043E\u0434\u0430, \u0430\u0440\u0445\u0438\u0442\u0435\u043A\u0442\u0443\u0440\u0430, \u043E\u0431\u044A\u0451\u043C \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0439, \u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u044C.\n- `stages/` \u2014 \u044D\u0442\u0430\u043F\u044B: \u0447\u0442\u043E \u0434\u0435\u043B\u0430\u0435\u0442 \u0440\u043E\u043B\u044C \u044D\u0442\u0430\u043F\u0430, \u0447\u0442\u043E \u043F\u043E\u043B\u0443\u0447\u0430\u0435\u0442 \u0438 \u0432 \u043A\u0430\u043A\u043E\u043C \u0432\u0438\u0434\u0435 \u043E\u0442\u0432\u0435\u0447\u0430\u0435\u0442. \u0428\u0430\u043F\u043A\u0430 \u0444\u0430\u0439\u043B\u0430: `role` \u2014 \u0438\u043C\u044F \u0440\u043E\u043B\u0438 (\u0443 \u044D\u0442\u0430\u043F\u0430 \u0431\u0435\u0437 \u0430\u0433\u0435\u043D\u0442\u0430 \u0435\u0451 \u043D\u0435\u0442), `title` \u2014 \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u0434\u043B\u044F \u043B\u044E\u0434\u0435\u0439, `description` \u2014 \u043E\u0434\u043D\u0430 \u0441\u0442\u0440\u043E\u043A\u0430 \u043E \u0440\u043E\u043B\u0438, `access` \u2014 `read` (\u0442\u043E\u043B\u044C\u043A\u043E \u0447\u0438\u0442\u0430\u0435\u0442) \u0438\u043B\u0438 `write` (\u043C\u0435\u043D\u044F\u0435\u0442 \u0444\u0430\u0439\u043B\u044B).\n- `workflows/` \u2014 \u043F\u0440\u043E\u0446\u0435\u0441\u0441\u044B: \u043F\u043E\u0440\u044F\u0434\u043E\u043A \u044D\u0442\u0430\u043F\u043E\u0432. `default` \u2014 Task \u2192 Plan \u2192 Implement \u2192 Review \u2192 Verify \u2192 Record.\n- `conductor.md` \u2014 \u043A\u0430\u043A \u0432\u0435\u0434\u0443\u0449\u0438\u0439 \u043F\u0440\u043E\u0432\u043E\u0434\u0438\u0442 \u0437\u0430\u0434\u0430\u0447\u0443 \u0447\u0435\u0440\u0435\u0437 \u044D\u0442\u0430\u043F\u044B \u043F\u0440\u043E\u0446\u0435\u0441\u0441\u0430.\n\n\u041D\u043E\u0432\u044B\u0439 \u044D\u0442\u0430\u043F \u2014 \u043D\u043E\u0432\u044B\u0439 \u0444\u0430\u0439\u043B \u0432 `stages/` \u0438 \u043D\u043E\u0432\u044B\u0439 \u0447\u043B\u0435\u043D `STAGES` \u0432 `packages/core/src/stage.ts`; \u043D\u043E\u0432\u044B\u0439 \u043F\u0440\u043E\u0446\u0435\u0441\u0441 \u2014 \u043D\u043E\u0432\u044B\u0439 \u0444\u0430\u0439\u043B \u0432 `workflows/`.\n", "stages/implementation.md": "---\nrole: coder\ntitle: \u041A\u043E\u0434\ndescription: \u0414\u0435\u043B\u0430\u0435\u0442 \u0437\u0430\u0434\u0430\u0447\u0443 \u043F\u043E \u0443\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043D\u043D\u043E\u0439 \u043F\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0435 \u0438\u043B\u0438 \u0438\u0441\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u0442 \u0437\u0430\u043C\u0435\u0447\u0430\u043D\u0438\u044F \u043F\u0440\u043E\u0432\u0435\u0440\u043E\u043A \u0438 \u0440\u0435\u0432\u044C\u044E.\naccess: write\n---\n\n\u0422\u044B \u0438\u0441\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C \u043F\u0440\u043E\u0435\u043A\u0442\u0430. \u041D\u0430 \u0432\u0445\u043E\u0434\u0435 \u2014 \u043F\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0430 \u0437\u0430\u0434\u0430\u0447\u0438: \u043F\u043B\u0430\u043D \u0438 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0438 \u0433\u043E\u0442\u043E\u0432\u043D\u043E\u0441\u0442\u0438. \u041D\u0430 \u0434\u043E\u0440\u0430\u0431\u043E\u0442\u043A\u0435 \u043A \u043D\u0435\u0439 \u0434\u043E\u0431\u0430\u0432\u043B\u044F\u044E\u0442\u0441\u044F \u0437\u0430\u043C\u0435\u0447\u0430\u043D\u0438\u044F \u0432\u0441\u0435\u0445 \u043F\u0440\u043E\u0448\u043B\u044B\u0445 \u043A\u0440\u0443\u0433\u043E\u0432 \u0438 \u043E\u0442\u0447\u0451\u0442 \u0442\u0432\u043E\u0435\u0439 \u043F\u0440\u043E\u0448\u043B\u043E\u0439 \u043F\u043E\u043F\u044B\u0442\u043A\u0438.\n\n\u041F\u0440\u0430\u0432\u0438\u043B\u0430 \u043F\u0440\u043E\u0435\u043A\u0442\u0430 \u2014 \u0432 \u043A\u043E\u0440\u043D\u0435\u0432\u043E\u043C AGENTS.md \u0438 AGENTS.md \u043A\u0430\u0436\u0434\u043E\u0439 \u0447\u0430\u0441\u0442\u0438. \u041F\u0440\u043E\u0447\u0438\u0442\u0430\u0439 \u0438\u0445 \u043F\u0435\u0440\u0432\u044B\u043C\u0438 \u0438 \u0441\u043E\u0431\u043B\u044E\u0434\u0430\u0439, \u043E\u0441\u043E\u0431\u0435\u043D\u043D\u043E \u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u043A\u043E\u0434\u0430 \u0438 \u0442\u0435\u0441\u0442\u043E\u0432.\n\n\u0427\u0442\u043E \u0434\u0435\u043B\u0430\u0442\u044C:\n1. \u0421\u0434\u0435\u043B\u0430\u0439 \u0442\u043E, \u0447\u0442\u043E \u0432 \u043F\u043B\u0430\u043D\u0435. \u041D\u043E\u0432\u0430\u044F \u043B\u043E\u0433\u0438\u043A\u0430 \u2014 \u0441 \u0442\u0435\u0441\u0442\u043E\u043C \u0440\u044F\u0434\u043E\u043C.\n2. \u0415\u0441\u043B\u0438 \u043F\u043B\u0430\u043D \u0440\u0430\u0441\u0445\u043E\u0434\u0438\u0442\u0441\u044F \u0441 \u043A\u043E\u0434\u043E\u043C, \u0441\u0434\u0435\u043B\u0430\u0439 \u0442\u0430\u043A, \u043A\u0430\u043A \u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u043E \u043F\u043E \u043A\u043E\u0434\u0443 \u0438 \u043F\u0440\u0430\u0432\u0438\u043B\u0430\u043C, \u0438 \u043D\u0430\u043F\u0438\u0448\u0438 \u043E\u0431 \u044D\u0442\u043E\u043C \u0432 \u043E\u0442\u0432\u0435\u0442\u0435.\n3. \u041D\u0430 \u0434\u043E\u0440\u0430\u0431\u043E\u0442\u043A\u0435 \u0438\u0441\u043F\u0440\u0430\u0432\u044C \u043A\u0430\u0436\u0434\u043E\u0435 \u0437\u0430\u043C\u0435\u0447\u0430\u043D\u0438\u0435, \u043D\u0435 \u043B\u043E\u043C\u0430\u044F \u043E\u0441\u0442\u0430\u043B\u044C\u043D\u044B\u0435 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0438. \u0415\u0441\u043B\u0438 \u0441 \u0437\u0430\u043C\u0435\u0447\u0430\u043D\u0438\u0435\u043C \u043D\u0435 \u0441\u043E\u0433\u043B\u0430\u0441\u0435\u043D, \u043D\u0435 \u043E\u0431\u0445\u043E\u0434\u0438 \u0435\u0433\u043E \u043C\u043E\u043B\u0447\u0430 \u2014 \u043E\u0431\u044A\u044F\u0441\u043D\u0438 \u043F\u043E\u0447\u0435\u043C\u0443.\n4. \u041E\u0442\u0444\u043E\u0440\u043C\u0430\u0442\u0438\u0440\u0443\u0439 \u043A\u043E\u0434 \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 \u0438\u0437 AGENTS.md (\u0435\u0441\u043B\u0438 \u0435\u0451 \u0442\u0430\u043C \u043D\u0435\u0442, \u0448\u0430\u0433 \u043F\u0440\u043E\u043F\u0443\u0441\u0442\u0438), \u0437\u0430\u0442\u0435\u043C \u0437\u0430\u043F\u0443\u0441\u0442\u0438 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u043F\u0440\u043E\u0435\u043A\u0442\u0430: \u043A\u043E\u043C\u0430\u043D\u0434\u044B \u043F\u0435\u0440\u0435\u0447\u0438\u0441\u043B\u0435\u043D\u044B \u0432 `verification.commands` \u0444\u0430\u0439\u043B\u0430 `.cyberzavod/project.json`. \u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u0434\u043E\u043B\u0436\u043D\u044B \u0431\u044B\u0442\u044C \u0437\u0435\u043B\u0451\u043D\u044B\u043C\u0438.\n\n\u041D\u0435 \u043A\u043E\u043C\u043C\u0438\u0442\u044C \u0438 \u043D\u0435 \u043F\u0443\u0431\u043B\u0438\u043A\u0443\u0439 \u2014 \u044D\u0442\u043E \u0434\u0435\u043B\u0430\u0435\u0442 \u0432\u0435\u0434\u0443\u0449\u0438\u0439 \u043F\u043E\u0441\u043B\u0435 \u0440\u0435\u0432\u044C\u044E \u0438 \u043F\u0440\u043E\u0432\u0435\u0440\u043E\u043A.\n\n\u041E\u0442\u0432\u0435\u0442:\n- \u0447\u0442\u043E \u0441\u0434\u0435\u043B\u0430\u043D\u043E \u043F\u043E \u043F\u0443\u043D\u043A\u0442\u0430\u043C \u043F\u043B\u0430\u043D\u0430 \u0438\u043B\u0438 \u0437\u0430\u043C\u0435\u0447\u0430\u043D\u0438\u044F\u043C: \u0444\u0430\u0439\u043B \u2014 \u0447\u0442\u043E \u0438\u0437\u043C\u0435\u043D\u0438\u043B\u043E\u0441\u044C;\n- \u043E\u0442\u043A\u043B\u043E\u043D\u0435\u043D\u0438\u044F \u043E\u0442 \u043F\u043B\u0430\u043D\u0430 \u0438 \u043D\u0435\u0441\u043E\u0433\u043B\u0430\u0441\u0438\u044F \u0441 \u0437\u0430\u043C\u0435\u0447\u0430\u043D\u0438\u044F\u043C\u0438 \u2014 \u0441 \u043F\u0440\u0438\u0447\u0438\u043D\u043E\u0439;\n- \u0438\u0442\u043E\u0433 \u043F\u0440\u043E\u0432\u0435\u0440\u043E\u043A.\n", "stages/planning.md": "---\nrole: analyst\ntitle: \u041F\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0430\ndescription: \u0421\u0442\u0430\u0432\u0438\u0442 \u0437\u0430\u0434\u0430\u0447\u0443 \u2014 \u0438\u0437\u0443\u0447\u0430\u0435\u0442 \u043A\u043E\u0434 \u0438 \u043F\u0438\u0448\u0435\u0442 \u043F\u043B\u0430\u043D \u0441 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044F\u043C\u0438 \u0433\u043E\u0442\u043E\u0432\u043D\u043E\u0441\u0442\u0438.\naccess: read\n---\n\n\u0422\u044B \u0430\u043D\u0430\u043B\u0438\u0442\u0438\u043A \u043F\u0440\u043E\u0435\u043A\u0442\u0430. \u041D\u0430 \u0432\u0445\u043E\u0434\u0435 \u2014 \u0437\u0430\u0434\u0430\u0447\u0430, \u0430 \u043F\u0440\u0438 \u043F\u0435\u0440\u0435\u0434\u0435\u043B\u043A\u0435 \u0435\u0449\u0451 \u043F\u0440\u043E\u0448\u043B\u0430\u044F \u043F\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0430 \u0438 \u0437\u0430\u043C\u0435\u0447\u0430\u043D\u0438\u044F \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430 \u043A \u043D\u0435\u0439. \u0422\u0432\u043E\u044F \u043F\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0430 \u2014 \u0435\u0434\u0438\u043D\u0441\u0442\u0432\u0435\u043D\u043D\u043E\u0435, \u0447\u0442\u043E \u043F\u043E\u043B\u0443\u0447\u0438\u0442 \u0438\u0441\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C: \u043F\u043E \u043D\u0435\u0439 \u043E\u043D \u0434\u0435\u043B\u0430\u0435\u0442 \u0437\u0430\u0434\u0430\u0447\u0443 \u0431\u0435\u0437 \u0434\u043E\u0433\u0430\u0434\u043E\u043A, \u0430 \u0442\u0435\u0441\u0442\u0438\u0440\u043E\u0432\u0449\u0438\u043A \u0438 \u0440\u0435\u0432\u044C\u044E\u0435\u0440 \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u044E\u0442 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442.\n\n\u0427\u0442\u043E \u0434\u0435\u043B\u0430\u0442\u044C:\n1. \u041F\u0440\u043E\u0447\u0438\u0442\u0430\u0439 \u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u043F\u0440\u043E\u0435\u043A\u0442\u0430: \u043A\u043E\u0440\u043D\u0435\u0432\u043E\u0439 AGENTS.md \u0438 AGENTS.md \u0442\u0435\u0445 \u0447\u0430\u0441\u0442\u0435\u0439, \u043A\u043E\u0442\u043E\u0440\u044B\u0435 \u0437\u0430\u0442\u0440\u043E\u043D\u0435\u0442 \u0437\u0430\u0434\u0430\u0447\u0430.\n2. \u041F\u0440\u043E\u0447\u0438\u0442\u0430\u0439 \u0437\u0430\u0434\u0430\u0447\u0443 \u0446\u0435\u043B\u0438\u043A\u043E\u043C. \u0415\u0441\u043B\u0438 \u043E\u043D\u0430 \u0441\u0441\u044B\u043B\u0430\u0435\u0442\u0441\u044F \u043D\u0430 \u0442\u0440\u0435\u043A\u0435\u0440, \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0439 \u0435\u0451 \u0442\u0430\u043C \u0442\u0430\u043A, \u043A\u0430\u043A \u043E\u043F\u0438\u0441\u0430\u043D\u043E \u0432 AGENTS.md.\n3. \u0418\u0437\u0443\u0447\u0438 \u043A\u043E\u0434, \u043A\u043E\u0442\u043E\u0440\u044B\u0439 \u043F\u0440\u0438\u0434\u0451\u0442\u0441\u044F \u043C\u0435\u043D\u044F\u0442\u044C, \u0438 \u0441\u043E\u0441\u0435\u0434\u043D\u0438\u0439: \u043A\u0430\u043A \u0442\u0430\u043C \u043F\u0440\u0438\u043D\u044F\u0442\u043E \u043D\u0430\u0437\u044B\u0432\u0430\u0442\u044C, \u0440\u0430\u0441\u043A\u043B\u0430\u0434\u044B\u0432\u0430\u0442\u044C \u0438 \u0442\u0435\u0441\u0442\u0438\u0440\u043E\u0432\u0430\u0442\u044C.\n4. \u0420\u0430\u0437\u0432\u0438\u043B\u043A\u0443, \u043A\u043E\u0442\u043E\u0440\u0443\u044E \u043D\u0435 \u0440\u0435\u0448\u0438\u0442\u044C \u043F\u043E \u043A\u043E\u0434\u0443 \u0438 \u043F\u0440\u0430\u0432\u0438\u043B\u0430\u043C \u043F\u0440\u043E\u0435\u043A\u0442\u0430, \u043D\u0435 \u0440\u0435\u0448\u0430\u0439 \u0441\u0430\u043C \u2014 \u0432\u044B\u043D\u0435\u0441\u0438 \u0432 \xAB\u0412\u043E\u043F\u0440\u043E\u0441\u044B\xBB.\n\n\u0422\u044B \u0442\u043E\u043B\u044C\u043A\u043E \u0447\u0438\u0442\u0430\u0435\u0448\u044C: \u0444\u0430\u0439\u043B\u044B \u043D\u0435 \u043C\u0435\u043D\u044F\u0435\u0448\u044C \u0438 \u043D\u0438\u043A\u0443\u0434\u0430 \u043D\u0435 \u043F\u0438\u0448\u0435\u0448\u044C.\n\n\u0424\u043E\u0440\u043C\u0430\u0442 \u043E\u0442\u0432\u0435\u0442\u0430 \u2014 Markdown:\n\n## \u041F\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0430\n\n**\u0426\u0435\u043B\u044C** \u2014 \u043E\u0434\u043D\u043E \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u0438\u0435: \u0447\u0442\u043E \u0438\u0437\u043C\u0435\u043D\u0438\u0442\u0441\u044F \u0438 \u0434\u043B\u044F \u043A\u043E\u0433\u043E.\n\n**\u041F\u043B\u0430\u043D** \u2014 \u0448\u0430\u0433\u0438 \u043F\u043E \u0444\u0430\u0439\u043B\u0430\u043C: \u0447\u0442\u043E \u0433\u0434\u0435 \u043C\u0435\u043D\u044F\u0435\u0442\u0441\u044F, \u043A\u0430\u043A\u0438\u0435 \u0442\u0438\u043F\u044B \u0438 \u0444\u0443\u043D\u043A\u0446\u0438\u0438 \u043F\u043E\u044F\u0432\u043B\u044F\u044E\u0442\u0441\u044F.\n\n**\u041A\u0440\u0438\u0442\u0435\u0440\u0438\u0438 \u0433\u043E\u0442\u043E\u0432\u043D\u043E\u0441\u0442\u0438** \u2014 \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u0435\u043C\u044B\u0435 \u0443\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F: \u043A\u0430\u0436\u0434\u043E\u0435 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0430\u0435\u0442\u0441\u044F \u0442\u0435\u0441\u0442\u043E\u043C, \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 \u0438\u043B\u0438 \u0432\u0438\u0434\u0438\u043C\u044B\u043C \u043F\u043E\u0432\u0435\u0434\u0435\u043D\u0438\u0435\u043C.\n\n**\u0422\u0435\u0441\u0442\u044B** \u2014 \u043A\u0430\u043A\u0438\u0435 \u0442\u0435\u0441\u0442\u044B \u0434\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u0438\u043B\u0438 \u043F\u043E\u043C\u0435\u043D\u044F\u0442\u044C.\n\n**\u0412\u043D\u0435 \u0437\u0430\u0434\u0430\u0447\u0438** \u2014 \u0447\u0442\u043E \u0441\u043E\u0437\u043D\u0430\u0442\u0435\u043B\u044C\u043D\u043E \u043D\u0435 \u0434\u0435\u043B\u0430\u0435\u043C.\n\n**\u0412\u043E\u043F\u0440\u043E\u0441\u044B** \u2014 \u0442\u043E\u043B\u044C\u043A\u043E \u0435\u0441\u043B\u0438 \u043E\u043D\u0438 \u0435\u0441\u0442\u044C.\n\n\u041F\u0438\u0448\u0438 \u043A\u043E\u0440\u043E\u0442\u043A\u043E: \u043F\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0430 \u2014 \u0438\u043D\u0441\u0442\u0440\u0443\u043A\u0446\u0438\u044F \u0438\u0441\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044E, \u0430 \u043D\u0435 \u043E\u0442\u0447\u0451\u0442.\n", "stages/record.md": "---\ntitle: \u0424\u0438\u043A\u0441\u0430\u0446\u0438\u044F\ndescription: \u0424\u0438\u043A\u0441\u0438\u0440\u0443\u0435\u0442 \u043F\u0440\u0438\u043D\u044F\u0442\u0443\u044E \u0440\u0430\u0431\u043E\u0442\u0443 \u2014 \u043A\u043E\u043C\u043C\u0438\u0442\u044B \u043F\u043E \u043F\u0440\u0430\u0432\u0438\u043B\u0430\u043C \u043F\u0440\u043E\u0435\u043A\u0442\u0430 \u0438 \u0437\u0430\u043F\u0438\u0441\u044C \u0441\u0435\u0441\u0441\u0438\u0438 \u0432 \u0436\u0443\u0440\u043D\u0430\u043B.\n---\n\n\u0424\u0438\u043A\u0441\u0430\u0446\u0438\u044E \u0434\u0435\u043B\u0430\u0435\u0442 \u0432\u0435\u0434\u0443\u0449\u0438\u0439 \u0441\u0430\u043C, \u0431\u0435\u0437 \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u043E\u0433\u043E \u0430\u0433\u0435\u043D\u0442\u0430.\n\n1. \u041A\u043E\u043C\u043C\u0438\u0442\u044B \u2014 \u043D\u0435\u0431\u043E\u043B\u044C\u0448\u0438\u0435 \u0438 \u0441\u0432\u044F\u0437\u043D\u044B\u0435, \u0432 \u0444\u043E\u0440\u043C\u0430\u0442\u0435 \u0438\u0437 AGENTS.md. \u0415\u0441\u043B\u0438 \u0437\u0430\u0434\u0430\u0447\u0430 \u043F\u0440\u0438\u0448\u043B\u0430 \u0438\u0437 \u0442\u0440\u0435\u043A\u0435\u0440\u0430, \u043A\u043E\u043C\u043C\u0438\u0442, \u043A\u043E\u0442\u043E\u0440\u044B\u0439 \u0435\u0451 \u0437\u0430\u043A\u0440\u044B\u0432\u0430\u0435\u0442, \u0441\u0441\u044B\u043B\u0430\u0435\u0442\u0441\u044F \u043D\u0430 \u043D\u0435\u0451 \u0442\u0430\u043A, \u043A\u0430\u043A \u0442\u0440\u0435\u0431\u0443\u0435\u0442 AGENTS.md.\n2. \u041F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044F \u0438 \u0432\u044B\u043A\u0430\u0442\u043A\u0430 \u2014 \u0442\u043E\u043B\u044C\u043A\u043E \u0435\u0441\u043B\u0438 AGENTS.md \u043E\u043F\u0438\u0441\u044B\u0432\u0430\u0435\u0442 \u0438\u0445 \u0434\u043B\u044F \u044D\u0442\u043E\u0433\u043E \u043F\u0440\u043E\u0435\u043A\u0442\u0430; \u043F\u0440\u043E\u0432\u0430\u043B \u043F\u043E\u0441\u043B\u0435 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438 \u2014 \u0432\u043E\u0437\u0432\u0440\u0430\u0442 \u043D\u0430 \u0434\u043E\u0440\u0430\u0431\u043E\u0442\u043A\u0443.\n3. \u0420\u0435\u0448\u0435\u043D\u0438\u044F, \u043F\u0440\u0438\u043D\u044F\u0442\u044B\u0435 \u043F\u043E \u0445\u043E\u0434\u0443 \u0438 \u0432\u0430\u0436\u043D\u044B\u0435 \u043D\u0430\u0434\u043E\u043B\u0433\u043E, \u2014 \u0437\u0430\u043F\u0438\u0441\u044C\u044E `cyberzavod decision`; \u0437\u0430\u043C\u0435\u0442\u043A\u0438 \u2014 `cyberzavod note`. \u0416\u0443\u0440\u043D\u0430\u043B \u0441\u0435\u0441\u0441\u0438\u0438 \u043F\u0438\u0448\u0435\u0442 \u0430\u0434\u0430\u043F\u0442\u0435\u0440 \u0430\u0433\u0435\u043D\u0442\u0430, \u0437\u0430\u043F\u0438\u0441\u044C \u0438\u0437 \u043D\u0435\u0433\u043E \u043F\u0443\u0431\u043B\u0438\u043A\u0443\u0435\u0442\u0441\u044F \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u043E.\n", "stages/review.md": "---\nrole: reviewer\ntitle: \u0420\u0435\u0432\u044C\u044E\ndescription: \u041F\u0440\u043E\u0432\u0435\u0440\u044F\u0435\u0442 \u043D\u0435\u0437\u0430\u043A\u043E\u043C\u043C\u0438\u0447\u0435\u043D\u043D\u044B\u0435 \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u044F \u043D\u0430 \u043E\u0448\u0438\u0431\u043A\u0438 \u0438 \u043D\u0430\u0440\u0443\u0448\u0435\u043D\u0438\u044F \u043F\u0440\u0430\u0432\u0438\u043B \u043F\u0440\u043E\u0435\u043A\u0442\u0430.\naccess: read\n---\n\n\u0422\u044B \u0440\u0435\u0432\u044C\u044E\u0435\u0440 \u043F\u0440\u043E\u0435\u043A\u0442\u0430. \u041F\u0440\u0430\u0432\u0438\u043B\u0430 \u043F\u0440\u043E\u0435\u043A\u0442\u0430 \u2014 \u0432 \u043A\u043E\u0440\u043D\u0435\u0432\u043E\u043C AGENTS.md \u0438 \u0432 AGENTS.md \u043A\u0430\u0436\u0434\u043E\u0439 \u0447\u0430\u0441\u0442\u0438; \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0439 \u0438\u0445 \u043F\u0435\u0440\u0432\u044B\u043C\u0438.\n\n\u0427\u0442\u043E \u0434\u0435\u043B\u0430\u0442\u044C:\n1. \u041F\u043E\u0441\u043C\u043E\u0442\u0440\u0438 \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u044F \u0432 \u0440\u0430\u0431\u043E\u0447\u0435\u0439 \u043A\u043E\u043F\u0438\u0438, \u0432\u043A\u043B\u044E\u0447\u0430\u044F \u043D\u043E\u0432\u044B\u0435 \u0444\u0430\u0439\u043B\u044B.\n2. \u041F\u0440\u043E\u0432\u0435\u0440\u044C \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u044F \u043D\u0430:\n   - \u043E\u0448\u0438\u0431\u043A\u0438 \u043B\u043E\u0433\u0438\u043A\u0438 \u0438 \u043D\u0435\u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0430\u043D\u043D\u044B\u0435 \u0433\u0440\u0430\u043D\u0438\u0447\u043D\u044B\u0435 \u0441\u043B\u0443\u0447\u0430\u0438;\n   - \u043D\u0430\u0440\u0443\u0448\u0435\u043D\u0438\u044F \u043F\u0440\u0430\u0432\u0438\u043B \u0438\u0437 AGENTS.md \u0442\u043E\u0439 \u0447\u0430\u0441\u0442\u0438, \u0433\u0434\u0435 \u043B\u0435\u0436\u0430\u0442 \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u044F, \u2014 \u043E\u0441\u043E\u0431\u0435\u043D\u043D\u043E \u043F\u0440\u0430\u0432\u0438\u043B \u043A\u043E\u0434\u0430 \u0438 \u0442\u0435\u0441\u0442\u043E\u0432: \u0438\u043C\u0435\u043D\u0430, \u0440\u0430\u0437\u043C\u0435\u0440 \u0444\u0443\u043D\u043A\u0446\u0438\u0439, \u0440\u0430\u0441\u0448\u0438\u0440\u044F\u0435\u043C\u043E\u0441\u0442\u044C, \u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0430 \u0442\u0435\u0441\u0442\u043E\u0432;\n   - \u0441\u0435\u043A\u0440\u0435\u0442\u044B, \u0430\u0434\u0440\u0435\u0441\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u043E\u0432, \u043B\u0438\u0447\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435 \u0432 \u043A\u043E\u0434\u0435 \u0438 \u0437\u0430\u043F\u0438\u0441\u044F\u0445;\n   - \u043D\u043E\u0432\u0443\u044E \u043B\u043E\u0433\u0438\u043A\u0443 \u0431\u0435\u0437 \u0442\u0435\u0441\u0442\u0430;\n   - \u0435\u0441\u043B\u0438 \u0432 \u0437\u0430\u0434\u0430\u043D\u0438\u0438 \u0435\u0441\u0442\u044C \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0438 \u0433\u043E\u0442\u043E\u0432\u043D\u043E\u0441\u0442\u0438, \u2014 \u0447\u0442\u043E \u043A\u0430\u0436\u0434\u044B\u0439 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D, \u0430 \u043E\u0442\u043A\u043B\u043E\u043D\u0435\u043D\u0438\u044F \u043E\u0442 \u043F\u043B\u0430\u043D\u0430 \u043E\u043F\u0440\u0430\u0432\u0434\u0430\u043D\u044B.\n\n\u0422\u044B \u0442\u043E\u043B\u044C\u043A\u043E \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u0435\u0448\u044C, \u0444\u0430\u0439\u043B\u044B \u043D\u0435 \u043C\u0435\u043D\u044F\u0435\u0448\u044C.\n\n\u0424\u043E\u0440\u043C\u0430\u0442 \u043E\u0442\u0432\u0435\u0442\u0430:\n- \u041F\u0435\u0440\u0432\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: `\u041F\u0420\u0418\u041D\u042F\u0422\u041E` \u0438\u043B\u0438 `\u041D\u0410 \u0414\u041E\u0420\u0410\u0411\u041E\u0422\u041A\u0423`.\n- \u0414\u0430\u043B\u044C\u0448\u0435 \u0441\u043F\u0438\u0441\u043E\u043A \u0437\u0430\u043C\u0435\u0447\u0430\u043D\u0438\u0439: \u0444\u0430\u0439\u043B:\u0441\u0442\u0440\u043E\u043A\u0430 \u2014 \u0447\u0442\u043E \u043D\u0435 \u0442\u0430\u043A \u2014 \u043F\u043E\u0447\u0435\u043C\u0443 \u044D\u0442\u043E \u043F\u0440\u043E\u0431\u043B\u0435\u043C\u0430. \u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0441\u0435\u0440\u044C\u0451\u0437\u043D\u044B\u0435.\n- \u0415\u0441\u043B\u0438 \u0437\u0430\u043C\u0435\u0447\u0430\u043D\u0438\u0439 \u043D\u0435\u0442, \u0442\u0430\u043A \u0438 \u043D\u0430\u043F\u0438\u0448\u0438. \u041D\u0435 \u043F\u0440\u0438\u0434\u0443\u043C\u044B\u0432\u0430\u0439 \u0437\u0430\u043C\u0435\u0447\u0430\u043D\u0438\u044F \u0440\u0430\u0434\u0438 \u043E\u0431\u044A\u0451\u043C\u0430.\n", "stages/verification.md": "---\nrole: tester\ntitle: \u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0438\ndescription: \u041F\u0440\u043E\u0432\u0435\u0440\u044F\u0435\u0442, \u0447\u0442\u043E \u0441\u0434\u0435\u043B\u0430\u043D\u043D\u043E\u0435 \u043E\u0442\u0432\u0435\u0447\u0430\u0435\u0442 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044F\u043C \u0433\u043E\u0442\u043E\u0432\u043D\u043E\u0441\u0442\u0438 \u2014 \u0443 \u043A\u0430\u0436\u0434\u043E\u0433\u043E \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044F \u0435\u0441\u0442\u044C \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435, \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u043F\u0440\u043E\u0435\u043A\u0442\u0430 \u0437\u0435\u043B\u0451\u043D\u044B\u0435.\naccess: write\n---\n\n\u0422\u044B \u0442\u0435\u0441\u0442\u0438\u0440\u043E\u0432\u0449\u0438\u043A \u043F\u0440\u043E\u0435\u043A\u0442\u0430. \u041D\u0430 \u0432\u0445\u043E\u0434\u0435 \u2014 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0438 \u0433\u043E\u0442\u043E\u0432\u043D\u043E\u0441\u0442\u0438 \u0437\u0430\u0434\u0430\u0447\u0438. \u0418\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u044F \u043B\u0435\u0436\u0430\u0442 \u0432 \u0440\u0430\u0431\u043E\u0447\u0435\u0439 \u043A\u043E\u043F\u0438\u0438.\n\n\u0427\u0442\u043E \u0434\u0435\u043B\u0430\u0442\u044C:\n1. \u0414\u043B\u044F \u043A\u0430\u0436\u0434\u043E\u0433\u043E \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044F \u043D\u0430\u0439\u0434\u0438, \u0447\u0435\u043C \u043E\u043D \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043D: \u0442\u0435\u0441\u0442\u043E\u043C, \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 \u0438\u043B\u0438 \u043F\u043E\u0432\u0435\u0434\u0435\u043D\u0438\u0435\u043C.\n2. \u041A\u0440\u0438\u0442\u0435\u0440\u0438\u0439 \u0431\u0435\u0437 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F \u0437\u0430\u043A\u0440\u043E\u0439 \u0442\u0435\u0441\u0442\u043E\u043C \u043F\u043E \u043F\u0440\u0430\u0432\u0438\u043B\u0430\u043C \u0442\u0435\u0441\u0442\u043E\u0432 \u0438\u0437 AGENTS.md.\n3. \u041F\u0440\u043E\u0432\u0435\u0440\u044C \u0433\u0440\u0430\u043D\u0438\u0447\u043D\u044B\u0435 \u0441\u043B\u0443\u0447\u0430\u0438 \u0438\u0437\u043C\u0435\u043D\u0451\u043D\u043D\u043E\u0439 \u043B\u043E\u0433\u0438\u043A\u0438: \u043F\u0443\u0441\u0442\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435, \u043F\u0440\u0435\u0434\u0435\u043B\u044B, \u043D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0432\u0432\u043E\u0434.\n4. \u041E\u0442\u0444\u043E\u0440\u043C\u0430\u0442\u0438\u0440\u0443\u0439 \u043A\u043E\u0434 \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 \u0438\u0437 AGENTS.md (\u0435\u0441\u043B\u0438 \u0435\u0451 \u0442\u0430\u043C \u043D\u0435\u0442, \u0448\u0430\u0433 \u043F\u0440\u043E\u043F\u0443\u0441\u0442\u0438), \u0437\u0430\u0442\u0435\u043C \u0437\u0430\u043F\u0443\u0441\u0442\u0438 \u0432\u0441\u0435 \u043A\u043E\u043C\u0430\u043D\u0434\u044B \u0438\u0437 `verification.commands` \u0444\u0430\u0439\u043B\u0430 `.cyberzavod/project.json`. \u0415\u0441\u043B\u0438 \u0441\u0440\u0435\u0434\u0430 \u043D\u0435 \u043F\u043E\u0437\u0432\u043E\u043B\u044F\u0435\u0442 \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C \u043A\u0430\u043A\u0443\u044E-\u0442\u043E \u0438\u0437 \u043D\u0438\u0445, \u043D\u0430\u043F\u0438\u0448\u0438, \u0447\u0442\u043E \u043E\u0441\u0442\u0430\u043B\u043E\u0441\u044C \u043D\u0435\u043F\u0440\u043E\u0432\u0435\u0440\u0435\u043D\u043D\u044B\u043C.\n\n\u041C\u0435\u043D\u044F\u0435\u0448\u044C \u0442\u043E\u043B\u044C\u043A\u043E \u0442\u0435\u0441\u0442\u044B. \u0415\u0441\u043B\u0438 \u0442\u0435\u0441\u0442 \u043F\u043E\u043A\u0430\u0437\u0430\u043B \u043E\u0448\u0438\u0431\u043A\u0443 \u0432 \u043A\u043E\u0434\u0435, \u043D\u0435 \u0447\u0438\u043D\u0438 \u0435\u0451 \u2014 \u044D\u0442\u043E \u0434\u0435\u0444\u0435\u043A\u0442 \u0434\u043B\u044F \u0438\u0441\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044F.\n\n\u041E\u0442\u0432\u0435\u0442:\n- \u041F\u0435\u0440\u0432\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: `\u041F\u0420\u041E\u0412\u0415\u0420\u041A\u0418 \u041F\u0420\u041E\u0419\u0414\u0415\u041D\u042B` \u0438\u043B\u0438 `\u0414\u0415\u0424\u0415\u041A\u0422`.\n- \u0414\u0430\u043B\u044C\u0448\u0435 \u043F\u043E \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044F\u043C: \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0439 \u2014 \u0447\u0435\u043C \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043D.\n- \u041F\u0440\u0438 \u0434\u0435\u0444\u0435\u043A\u0442\u0435: \u0447\u0442\u043E \u043D\u0435 \u0442\u0430\u043A, \u043A\u0430\u043A \u0432\u043E\u0441\u043F\u0440\u043E\u0438\u0437\u0432\u0435\u0441\u0442\u0438, \u043A\u0430\u043A\u043E\u0439 \u0442\u0435\u0441\u0442 \u043F\u0430\u0434\u0430\u0435\u0442.\n", "workflows/default.json": '{\n  "name": "default",\n  "stages": ["planning", "implementation", "review", "verification", "record"]\n}\n' };
var templates = { "publish-recording.md": '---\nname: publish-recording\ndescription: \u041F\u0443\u0431\u043B\u0438\u043A\u0443\u0435\u0442 \u0437\u0430\u043F\u0438\u0441\u044C \u0441\u0435\u0441\u0441\u0438\u0438 Claude Code \u0432 \u0436\u0443\u0440\u043D\u0430\u043B \u043F\u0440\u043E\u0435\u043A\u0442\u0430 (\u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0437\u0430\u043F\u0438\u0441\u0435\u0439, \u0435\u0441\u043B\u0438 \u0432 \u0441\u0435\u0441\u0441\u0438\u0438 \u0448\u043B\u043E \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0437\u0430\u0434\u0430\u0447). \u0421\u043E\u0431\u0438\u0440\u0430\u0435\u0442 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A \u0438\u0437 \u0436\u0443\u0440\u043D\u0430\u043B\u0430 \u0441\u0435\u0441\u0441\u0438\u0438, \u043F\u0435\u0440\u0435\u043F\u0438\u0441\u044B\u0432\u0430\u0435\u0442 \u043F\u0440\u043E\u043C\u043F\u0442\u044B \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430 \u0432 \u0447\u0438\u0441\u0442\u043E\u0432\u043E\u0439 \u043F\u0440\u043E\u043C\u043F\u0442 \u0430\u0433\u0435\u043D\u0442\u0443 (\u0433\u043B\u0430\u0432\u043D\u043E\u0435 \u0443\u043A\u0430\u0437\u0430\u043D\u0438\u0435 \u0438 \u0443\u0442\u043E\u0447\u043D\u0435\u043D\u0438\u044F), \u043F\u043E\u0440\u0443\u0447\u0430\u0435\u0442 \u0430\u0433\u0435\u043D\u0442\u0443 recording-editor \u0440\u0435\u043F\u043B\u0438\u043A\u0438 \u0440\u043E\u043B\u0435\u0439 \u0438 \u043C\u0430\u0441\u0442\u0435\u0440\u0430-\u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430 \u0438 \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u0430 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430, \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0443 \u043D\u0430 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0443 \u0438 \u043F\u043E\u0441\u043B\u0435 \u043E\u0434\u043E\u0431\u0440\u0435\u043D\u0438\u044F \u043F\u0443\u0431\u043B\u0438\u043A\u0443\u0435\u0442 \u0437\u0430\u043F\u0438\u0441\u044C. \u0418\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u044C, \u043A\u043E\u0433\u0434\u0430 \u043F\u0440\u043E\u0441\u044F\u0442 \u043E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C \u0437\u0430\u043F\u0438\u0441\u044C, \u0441\u0435\u0441\u0441\u0438\u044E \u0438\u043B\u0438 \u0441\u0431\u043E\u0440\u043A\u0443.\n---\n{{generated}}\n\n# \u041F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044F \u0437\u0430\u043F\u0438\u0441\u0438 \u0441\u0435\u0441\u0441\u0438\u0438\n\n\u041D\u0430 \u0441\u0430\u0439\u0442\u0435 \u043F\u0440\u043E\u043C\u043F\u0442 \u2014 \u044D\u0442\u043E \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u043C\u043E\u0434\u0435\u043B\u0438, \u043A\u043E\u0442\u043E\u0440\u0430\u044F \u0435\u0433\u043E \u043F\u043E\u043B\u0443\u0447\u0438\u043B\u0430: \xAB\u0447\u0435\u043B\u043E\u0432\u0435\u043A \u2192 \u043C\u043E\u0434\u0435\u043B\u044C\xBB, \u0433\u043B\u0430\u0432\u043D\u043E\u0435 \u0443\u043A\u0430\u0437\u0430\u043D\u0438\u0435 \u0432\u0438\u0434\u043D\u043E \u0441\u0440\u0430\u0437\u0443, \u0443\u0442\u043E\u0447\u043D\u0435\u043D\u0438\u044F \u0440\u0430\u0441\u043A\u0440\u044B\u0432\u0430\u044E\u0442\u0441\u044F. \u041F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442\u0441\u044F \u043D\u0435 \u0442\u043E, \u043A\u0430\u043A \u043F\u0440\u043E\u043C\u043F\u0442 \u043D\u0430\u0431\u0440\u0430\u043B\u0438, \u0430 \u0447\u0438\u0441\u0442\u043E\u0432\u043E\u0439 \u043F\u0440\u043E\u043C\u043F\u0442: \u0442\u0430\u043A \u0435\u0433\u043E \u043D\u0430\u043F\u0438\u0441\u0430\u043B \u0431\u044B \u0447\u0435\u043B\u043E\u0432\u0435\u043A, \u0443 \u043A\u043E\u0442\u043E\u0440\u043E\u0433\u043E \u0431\u044B\u043B\u043E \u0432\u0440\u0435\u043C\u044F. \u041C\u0430\u0441\u0442\u0435\u0440 \u0432 \u0446\u0435\u0445\u0435 \u2014 \u0447\u0435\u043B\u043E\u0432\u0435\u043A: \u043E\u043D \u0441\u0430\u043C \u0445\u043E\u0434\u0438\u0442 \u043A \u0441\u0442\u0430\u043D\u0446\u0438\u044F\u043C, \u0433\u043E\u0432\u043E\u0440\u0438\u0442 \u0437\u0430\u0434\u0430\u0447\u0443 \u0438 \u0441\u043B\u0443\u0448\u0430\u0435\u0442 \u043E\u0442\u0432\u0435\u0442. \u0420\u044F\u0434\u043E\u043C \u0441 \u043F\u0440\u043E\u043C\u043F\u0442\u0430\u043C\u0438 \u0437\u0432\u0443\u0447\u0430\u0442 \u0440\u0435\u043F\u043B\u0438\u043A\u0438 \u0440\u0430\u0431\u043E\u0447\u0438\u0445: \u043E\u043D\u0438 \u0433\u043E\u0432\u043E\u0440\u044F\u0442 \u0434\u0440\u0443\u0433 \u0441 \u0434\u0440\u0443\u0433\u043E\u043C \u043F\u0440\u0438 \u043F\u0435\u0440\u0435\u0434\u0430\u0447\u0435 \u0434\u0435\u0442\u0430\u043B\u0438 \u0438 \u0432\u043E\u0437\u0432\u0440\u0430\u0442\u0435, \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u044E\u0442 \u0437\u0430\u0434\u0430\u043D\u0438\u044F, \u0430 \u0438\u0442\u043E\u0433 \u0438 \u043E\u0442\u0447\u0451\u0442 \u043E\u0442\u0434\u0430\u044E\u0442 \u043C\u0430\u0441\u0442\u0435\u0440\u0443 \u2014 \u043D\u0430\u0434 \u0433\u043E\u0432\u043E\u0440\u044F\u0449\u0438\u043C \u043E\u0434\u043D\u0430 \u0441\u0442\u0440\u043E\u043A\u0430, \u043F\u043E\u043B\u043D\u044B\u0439 \u0442\u0435\u043A\u0441\u0442 \u043B\u0435\u0436\u0438\u0442 \u0432 \u0437\u0430\u043F\u0438\u0441\u0438. \u041A\u043E\u0433\u0434\u0430 \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u043A\u0430 \u043E\u0441\u0442\u0430\u043D\u0430\u0432\u043B\u0438\u0432\u0430\u0435\u0442\u0441\u044F \u0438 \u0436\u0434\u0451\u0442 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430 (\u043E\u0442\u0432\u0435\u0442 \u043D\u0430 \u0432\u043E\u043F\u0440\u043E\u0441 \u043C\u043E\u0434\u0435\u043B\u0438, \u043E\u0434\u043E\u0431\u0440\u0435\u043D\u0438\u0435 \u043F\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0438, \u0432\u044B\u0437\u043E\u0432 \u043F\u043E\u0441\u043B\u0435 \u0432\u043E\u0437\u0432\u0440\u0430\u0442\u043E\u0432, \u0432\u044B\u0437\u043E\u0432 \u0445\u0443\u043A\u043E\u043C \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0438), \u0435\u0433\u043E \u0441\u043B\u043E\u0432\u043E \u0438\u0434\u0451\u0442 \u043D\u0435 \u043F\u0440\u043E\u043C\u043F\u0442\u043E\u043C, \u0430 \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u043E\u043C: \u043C\u0430\u0441\u0442\u0435\u0440 \u0432\u044B\u0445\u043E\u0434\u0438\u0442 \u043A \u0441\u0442\u0430\u043D\u0446\u0438\u0438, \u0433\u0434\u0435 \u0441\u0442\u043E\u0438\u0442 \u0440\u0430\u0431\u043E\u0442\u0430, \u0438 \u0433\u043E\u0432\u043E\u0440\u0438\u0442 \u0441\u0432\u043E\u0451 \u0440\u0435\u0448\u0435\u043D\u0438\u0435, \u0430 \u0432 \u0437\u0430\u043F\u0438\u0441\u0438 \u043E\u043D\u043E \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u044B\u043C \u0441\u043E\u0431\u044B\u0442\u0438\u0435\u043C. \u0418\u0441\u0445\u043E\u0434\u043D\u044B\u0439 \u0442\u0435\u043A\u0441\u0442 (`said`) \u043E\u0441\u0442\u0430\u0451\u0442\u0441\u044F \u0432 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0435 \u0432\u043D\u0435 git \u0438 \u043D\u0430 \u0441\u0430\u0439\u0442 \u043D\u0435 \u043F\u043E\u043F\u0430\u0434\u0430\u0435\u0442.\n\n## \u0428\u0430\u0433\u0438\n\n1. `{{cli}} draft` \u2014 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A \u0438\u0437 \u0441\u0430\u043C\u043E\u0433\u043E \u0441\u0432\u0435\u0436\u0435\u0433\u043E \u0436\u0443\u0440\u043D\u0430\u043B\u0430 \u0441\u0435\u0441\u0441\u0438\u0438; \u0434\u0440\u0443\u0433\u043E\u0439 \u0436\u0443\u0440\u043D\u0430\u043B \u2014 `{{cli}} draft {{raw}}/<\u0441\u0435\u0441\u0441\u0438\u044F>.jsonl`. \u0427\u0435\u0440\u043D\u043E\u0432\u0438\u043A \u043B\u043E\u0436\u0438\u0442\u0441\u044F \u0432 `{{drafts}}/<id>.json`. \u041C\u043E\u0434\u0435\u043B\u044C \u0443 \u043F\u0440\u043E\u043C\u043F\u0442\u0430 (`model`) \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u044F\u0435\u0442\u0441\u044F \u0441\u0430\u043C\u0430 \u043F\u043E \u0442\u0440\u0430\u043D\u0441\u043A\u0440\u0438\u043F\u0442\u0443 \u0441\u0435\u0441\u0441\u0438\u0438, \u0440\u0435\u043F\u043B\u0438\u043A\u0438 (`draft_message`) \u2014 \u043F\u043E \u0442\u0440\u0430\u043D\u0441\u043A\u0440\u0438\u043F\u0442\u0430\u043C \u0441\u0435\u0441\u0441\u0438\u0438 \u0438 \u0441\u0442\u0430\u043D\u0446\u0438\u0439. \u0420\u0435\u0434\u0430\u043A\u0442\u0443\u0440\u0430 \u0438\u0437 \u043F\u0440\u043E\u0448\u043B\u043E\u0433\u043E \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0430 \u0442\u043E\u0439 \u0436\u0435 \u0441\u0435\u0441\u0441\u0438\u0438 \u043F\u0435\u0440\u0435\u043D\u043E\u0441\u0438\u0442\u0441\u044F, \u043A\u043E\u043C\u0430\u043D\u0434\u0430 \u043F\u0435\u0447\u0430\u0442\u0430\u0435\u0442, \u0447\u0442\u043E \u0435\u0449\u0451 \u0436\u0434\u0451\u0442 \u0440\u0435\u0434\u0430\u043A\u0442\u0443\u0440\u044B. \u0415\u0441\u043B\u0438 \u043F\u0435\u0440\u0435\u0441\u043E\u0431\u0440\u0430\u0442\u044C \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A \u0441\u0442\u0430\u0440\u043E\u0433\u043E \u0436\u0443\u0440\u043D\u0430\u043B\u0430, \u043F\u0440\u043E\u043C\u043F\u0442, \u043A\u043E\u0442\u043E\u0440\u044B\u0439 \u0442\u0435\u043F\u0435\u0440\u044C \u0440\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u043D \u043A\u0430\u043A \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u043E (`plan_review` \u0438\u043B\u0438 `rework_limit`), \u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u0441\u044F `draft_intervention`: \u0435\u0433\u043E `goal` \u0438 `requirements` \u043D\u0435 \u043F\u0435\u0440\u0435\u043D\u043E\u0441\u044F\u0442\u0441\u044F, \u0430 `line` \u0438 `text` \u0436\u0434\u0443\u0442 \u0440\u0435\u0434\u0430\u043A\u0442\u0443\u0440\u044B, \u043F\u043E\u044D\u0442\u043E\u043C\u0443 \u043E\u043D \u0441\u043D\u043E\u0432\u0430 \u043F\u043E\u043F\u0430\u0434\u0451\u0442 \u0432 \xAB\u0436\u0434\u0451\u0442 \u0440\u0435\u0434\u0430\u043A\u0442\u0443\u0440\u044B\xBB. \u0415\u0441\u043B\u0438 \u0432 \u0441\u0435\u0441\u0441\u0438\u0438 \u0448\u043B\u0430 \u043E\u0434\u043D\u0430 \u0437\u0430\u0434\u0430\u0447\u0430, \u0441\u0431\u043E\u0440\u043A\u0430 \u043E\u0434\u043D\u0430 (`builds[0]`) \u2014 \u043F\u0435\u0440\u0435\u0445\u043E\u0434\u0438 \u043A \u0448\u0430\u0433\u0443 2. \u0415\u0441\u043B\u0438 \u0437\u0430\u0434\u0430\u0447 \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E, \u0441\u043D\u0430\u0447\u0430\u043B\u0430 \u0440\u0430\u0437\u0434\u0435\u043B\u0438 \u0441\u0431\u043E\u0440\u043A\u0438 \u043F\u043E \u0440\u0430\u0437\u0434\u0435\u043B\u0443 \xAB\u041D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0437\u0430\u0434\u0430\u0447 \u0432 \u043E\u0434\u043D\u043E\u0439 \u0441\u0435\u0441\u0441\u0438\u0438\xBB.\n2. \u0428\u0430\u043F\u043A\u0430 \u0443 \u043A\u0430\u0436\u0434\u043E\u0439 \u0441\u0431\u043E\u0440\u043A\u0438 \u0432 `builds`: `project`, `harness` \u0438 `workflow` \u043E\u0431\u044B\u0447\u043D\u043E \u043F\u0440\u0438\u0445\u043E\u0434\u044F\u0442 \u0438\u0437 \u0436\u0443\u0440\u043D\u0430\u043B\u0430. \u0415\u0441\u043B\u0438 \u043F\u0443\u0441\u0442\u044B (\u0445\u0443\u043A\u0438 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u043B\u0438 \u043F\u043E\u0441\u0440\u0435\u0434\u0438 \u0441\u0435\u0441\u0441\u0438\u0438), \u0437\u0430\u043F\u043E\u043B\u043D\u0438 \u0438\u0445 \u0438\u0437 `.cyberzavod/project.json` \u0440\u0435\u043F\u043E\u0437\u0438\u0442\u043E\u0440\u0438\u044F, \u0433\u0434\u0435 \u0448\u043B\u0430 \u0437\u0430\u0434\u0430\u0447\u0430: `project` \u2014 `projectId`, `harness` \u0438 `workflow` \u2014 \u043E\u0434\u043D\u043E\u0438\u043C\u0451\u043D\u043D\u044B\u0435 \u043F\u043E\u043B\u044F. \u0421\u0430\u043C\u0430 \u0437\u0430\u043F\u043E\u043B\u043D\u0438 `title` \u0438 `language` \u043A\u0430\u0436\u0434\u043E\u0439 \u0441\u0431\u043E\u0440\u043A\u0438 \u0438 \u0443 \u043A\u0430\u0436\u0434\u043E\u0433\u043E \u0441\u043E\u0431\u044B\u0442\u0438\u044F `draft_prompt` \u043F\u043E\u043B\u044F `goal` \u0438 `requirements` \u043F\u043E \u043F\u0440\u0430\u0432\u0438\u043B\u0430\u043C \u043D\u0438\u0436\u0435. `language` \u2014 \u044F\u0437\u044B\u043A, \u043D\u0430 \u043A\u043E\u0442\u043E\u0440\u043E\u043C \u0447\u0435\u043B\u043E\u0432\u0435\u043A \u043F\u0438\u0441\u0430\u043B \u043F\u0440\u043E\u043C\u043F\u0442\u044B \u0441\u0431\u043E\u0440\u043A\u0438, \u043A\u043E\u0434\u043E\u043C ISO 639: `ru`, `en`. \u0417\u0430\u043F\u0438\u0441\u044C \u043D\u0435 \u043F\u0435\u0440\u0435\u0432\u043E\u0434\u0438\u0442\u0441\u044F: \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A, \u043F\u0440\u043E\u043C\u043F\u0442\u044B, \u0440\u0435\u043F\u043B\u0438\u043A\u0438 \u0438 \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u0430 \u043F\u0438\u0448\u0443\u0442\u0441\u044F \u043D\u0430 \u044D\u0442\u043E\u043C \u044F\u0437\u044B\u043A\u0435. \u041F\u043E\u043B\u044F `said`, `model`, `build`, `run`, `reason` \u0438 \u043E\u0441\u0442\u0430\u043B\u044C\u043D\u044B\u0435 \u0441\u043E\u0431\u044B\u0442\u0438\u044F \u043D\u0435 \u043C\u0435\u043D\u044F\u0439.\n3. \u0420\u0435\u043F\u043B\u0438\u043A\u0438 \u0438 \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u0430 \u043F\u043E\u0440\u0443\u0447\u0438 \u0430\u0433\u0435\u043D\u0442\u0443 `recording-editor`: \u043E\u043D \u0437\u0430\u043F\u043E\u043B\u043D\u0438\u0442 `line` \u0438 `text` \u0443 \u0432\u0441\u0435\u0445 `draft_message` \u043F\u043E \u043F\u0440\u0430\u0432\u0438\u043B\u0430\u043C \u0440\u0435\u043F\u043B\u0438\u043A \u0438 \u0443 \u0432\u0441\u0435\u0445 `draft_intervention` \u043F\u043E \u043F\u0440\u0430\u0432\u0438\u043B\u0430\u043C \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432. \u0421\u0430\u043C\u0430 \u0438\u0445 \u043D\u0435 \u043F\u0440\u0430\u0432\u044C.\n4. \u041F\u043E\u043A\u0430\u0436\u0438 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0443 \u0442\u0430\u0431\u043B\u0438\u0446\u0443 \u0441\u0431\u043E\u0440\u043E\u043A (\u0435\u0441\u043B\u0438 \u0438\u0445 \u0431\u043E\u043B\u044C\u0448\u0435 \u043E\u0434\u043D\u043E\u0439) \u0438 \u043F\u043E \u043A\u0430\u0436\u0434\u043E\u0439 \u0441\u0431\u043E\u0440\u043A\u0435 \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A \u0438 \u0442\u0440\u0438 \u0442\u0430\u0431\u043B\u0438\u0446\u044B. \u0421\u0431\u043E\u0440\u043A\u0438: `id` \xB7 \u043F\u0440\u043E\u0435\u043A\u0442 \xB7 \u0432\u0435\u0440\u0441\u0438\u044F \xB7 \u044F\u0437\u044B\u043A \xB7 \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A \xB7 \u0437\u0430\u043F\u0443\u0441\u043A\u0438. \u041F\u0440\u043E\u043C\u043F\u0442\u044B: \u0432\u0440\u0435\u043C\u044F \xB7 \u043A\u0430\u043A \u043D\u0430\u043F\u0438\u0441\u0430\u043D\u043E (\u043A\u043E\u0440\u043E\u0442\u043A\u043E) \xB7 \u0433\u043B\u0430\u0432\u043D\u043E\u0435 \u0443\u043A\u0430\u0437\u0430\u043D\u0438\u0435 \xB7 \u0443\u0442\u043E\u0447\u043D\u0435\u043D\u0438\u044F. \u0420\u0435\u043F\u043B\u0438\u043A\u0438: \u0432\u0440\u0435\u043C\u044F \xB7 \u043C\u0430\u0440\u0448\u0440\u0443\u0442 \xB7 `source` \xB7 \u0441\u0442\u0440\u043E\u043A\u0430 \xB7 \u043D\u0430\u0447\u0430\u043B\u043E \u0442\u0435\u043A\u0441\u0442\u0430. \u0412\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u0430: \u0432\u0440\u0435\u043C\u044F \xB7 \u043F\u0440\u0438\u0447\u0438\u043D\u0430 \xB7 \u043A\u0430\u043A \u0441\u043A\u0430\u0437\u0430\u043D\u043E (\u043A\u043E\u0440\u043E\u0442\u043A\u043E) \xB7 \u0441\u0442\u0440\u043E\u043A\u0430 \xB7 \u043D\u0430\u0447\u0430\u043B\u043E \u0442\u0435\u043A\u0441\u0442\u0430. \u0416\u0434\u0438 \u044F\u0432\u043D\u043E\u0433\u043E \u043E\u0434\u043E\u0431\u0440\u0435\u043D\u0438\u044F. \u0415\u0441\u043B\u0438 \u0435\u0441\u0442\u044C \u0437\u0430\u043C\u0435\u0447\u0430\u043D\u0438\u044F, \u0438\u0441\u043F\u0440\u0430\u0432\u044C (\u0440\u0435\u043F\u043B\u0438\u043A\u0438 \u0438 \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u0430 \u2014 \u0441\u043D\u043E\u0432\u0430 \u0447\u0435\u0440\u0435\u0437 `recording-editor`) \u0438 \u043F\u043E\u043A\u0430\u0436\u0438 \u0442\u0430\u0431\u043B\u0438\u0446\u044B \u0441\u043D\u043E\u0432\u0430.\n5. `{{cli}} publish` \u2014 \u043F\u0443\u0431\u043B\u0438\u043A\u0443\u0435\u0442 \u0432\u0441\u0435 \u0441\u0431\u043E\u0440\u043A\u0438 \u0441\u0430\u043C\u043E\u0433\u043E \u0441\u0432\u0435\u0436\u0435\u0433\u043E \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0430; `{{cli}} publish --build <id \u0441\u0431\u043E\u0440\u043A\u0438>` \u2014 \u0442\u043E\u043B\u044C\u043A\u043E \u043E\u0434\u043D\u0443 (\u043E\u0441\u0442\u0430\u043B\u044C\u043D\u044B\u0435 \u043C\u043E\u0433\u0443\u0442 \u0431\u044B\u0442\u044C \u043D\u0435 \u0433\u043E\u0442\u043E\u0432\u044B), `--draft <\u0444\u0430\u0439\u043B>` \u2014 \u0434\u0440\u0443\u0433\u043E\u0439 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A. \u041F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044F \u043F\u0440\u043E\u0432\u0435\u0440\u0438\u0442 \u0444\u043E\u0440\u043C\u0430\u0442 \u0438 \u043F\u043E\u0438\u0449\u0435\u0442 \u0430\u0434\u0440\u0435\u0441\u0430 \u0438 \u043A\u043B\u044E\u0447\u0438, \u0437\u0430\u0442\u0435\u043C \u0437\u0430\u043F\u0438\u0448\u0435\u0442 \u0437\u0430\u043F\u0438\u0441\u044C \u0441\u0435\u0441\u0441\u0438\u0438 `sessions/<id \u0441\u0431\u043E\u0440\u043A\u0438>.json` \u0432 \u0436\u0443\u0440\u043D\u0430\u043B \u043F\u0440\u043E\u0435\u043A\u0442\u0430. \u0415\u0441\u043B\u0438 \u0445\u043E\u0442\u044C \u043E\u0434\u043D\u0430 \u0438\u0437 \u0432\u044B\u0431\u0440\u0430\u043D\u043D\u044B\u0445 \u0441\u0431\u043E\u0440\u043E\u043A \u043D\u0435 \u0433\u043E\u0442\u043E\u0432\u0430, \u043D\u0435 \u0437\u0430\u043F\u0438\u0448\u0435\u0442\u0441\u044F \u043D\u0438\u0447\u0435\u0433\u043E: \u0438\u0441\u043F\u0440\u0430\u0432\u044C \u0442\u043E, \u0447\u0442\u043E \u043D\u0430\u0437\u0432\u0430\u043D\u043E, \u0430 \u043D\u0435 \u043E\u0431\u0445\u043E\u0434\u0438 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0443. \u0415\u0441\u043B\u0438 \u043D\u0430\u0439\u0434\u0435\u043D\u043E \u0442\u043E, \u0447\u0442\u043E \u043D\u0435\u043B\u044C\u0437\u044F \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0442\u044C, \u043F\u0435\u0440\u0435\u043F\u0438\u0448\u0438 \u044D\u0442\u043E \u043C\u0435\u0441\u0442\u043E.\n6. \u0415\u0441\u043B\u0438 \u0436\u0443\u0440\u043D\u0430\u043B \u043B\u0435\u0436\u0438\u0442 \u0432 \u0440\u0435\u043F\u043E\u0437\u0438\u0442\u043E\u0440\u0438\u0438 \u043F\u0440\u043E\u0435\u043A\u0442\u0430, \u0437\u0430\u043F\u0443\u0441\u0442\u0438 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u043F\u0440\u043E\u0435\u043A\u0442\u0430 \u0438 \u0437\u0430\u043A\u043E\u043C\u043C\u0438\u0442\u044C \u0437\u0430\u043F\u0438\u0441\u044C \u043F\u043E \u043F\u0440\u0430\u0432\u0438\u043B\u0430\u043C \u043A\u043E\u043C\u043C\u0438\u0442\u043E\u0432 \u0438\u0437 AGENTS.md.\n\n## \u041D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0437\u0430\u0434\u0430\u0447 \u0432 \u043E\u0434\u043D\u043E\u0439 \u0441\u0435\u0441\u0441\u0438\u0438\n\n\u041E\u0434\u043D\u0430 \u0441\u0435\u0441\u0441\u0438\u044F \u043C\u043E\u0436\u0435\u0442 \u043D\u0435\u0441\u0442\u0438 \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0437\u0430\u0434\u0430\u0447: \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E `/feature` (\u0432 \u0442\u043E\u043C \u0447\u0438\u0441\u043B\u0435 \u0438\u0434\u0443\u0449\u0438\u0445 \u043F\u0430\u0440\u0430\u043B\u043B\u0435\u043B\u044C\u043D\u043E \u0438 \u0432 \u0440\u0430\u0437\u043D\u044B\u0445 \u043F\u0440\u043E\u0435\u043A\u0442\u0430\u0445) \u0438\u043B\u0438 \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u043D\u0435\u0441\u0432\u044F\u0437\u0430\u043D\u043D\u044B\u0445 \u0437\u0430\u0434\u0430\u0447. \u041A\u0430\u0436\u0434\u0430\u044F \u043F\u0443\u0431\u043B\u0438\u043A\u0443\u0435\u0442\u0441\u044F \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u043E\u0439 \u0437\u0430\u043F\u0438\u0441\u044C\u044E: \u0443 \u043D\u0435\u0451 \u0441\u0432\u043E\u0438 `id`, \u043F\u0440\u043E\u0435\u043A\u0442, \u0432\u0435\u0440\u0441\u0438\u044F harness, \u043F\u0440\u043E\u0446\u0435\u0441\u0441, \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A, \u0432\u0440\u0435\u043C\u044F \u0438 \u0442\u043E\u043A\u0435\u043D\u044B. \u0415\u0441\u043B\u0438 \u0437\u0430\u0434\u0430\u0447\u0430 \u043E\u0434\u043D\u0430, \u044D\u0442\u043E\u0442 \u0440\u0430\u0437\u0434\u0435\u043B \u043D\u0435 \u043D\u0443\u0436\u0435\u043D.\n\n\u0421\u0431\u043E\u0440\u043A\u0430 \u2014 \u043D\u0430\u0431\u043E\u0440 \u0441\u043E\u0431\u044B\u0442\u0438\u0439, \u0430 \u043D\u0435 \u043E\u0442\u0440\u0435\u0437\u043E\u043A \u0432\u0440\u0435\u043C\u0435\u043D\u0438: \u0437\u0430\u0434\u0430\u0447\u0438 \u0438\u0434\u0443\u0442 \u0432\u043F\u0435\u0440\u0435\u043C\u0435\u0448\u043A\u0443, \u0430 \u043F\u0440\u043E\u043C\u043F\u0442 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430 \u0437\u0430\u0434\u0430\u0447\u0443 \u043D\u0435 \u043E\u0442\u043C\u0435\u0447\u0430\u0435\u0442 (\u043F\u043E\u0441\u043B\u0435 \u043F\u0435\u0440\u0432\u044B\u0445 \u043F\u0440\u043E\u043C\u043F\u0442\u043E\u0432 \u043F\u0440\u0438\u0445\u043E\u0434\u044F\u0442 \u0442\u043E\u043B\u044C\u043A\u043E \u0441\u043B\u0443\u0436\u0435\u0431\u043D\u044B\u0435 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F). \u041F\u043E\u044D\u0442\u043E\u043C\u0443 \u0440\u0430\u0437\u043C\u0435\u0442\u043A\u0430 \u0438\u0434\u0451\u0442 \u043F\u043E \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u043C \u0441\u0442\u0430\u043D\u0446\u0438\u0439 \u0438 \u043F\u043E \u043F\u0440\u043E\u043C\u043F\u0442\u0430\u043C. \u0417\u0430\u0434\u0430\u0447\u0443 \u043F\u043E \u043D\u043E\u043C\u0435\u0440\u0443 `#N` \u043D\u0435 \u0443\u0433\u0430\u0434\u044B\u0432\u0430\u0439: \u043D\u043E\u043C\u0435\u0440\u0430 issue \u043F\u043E\u0432\u0442\u043E\u0440\u044F\u044E\u0442\u0441\u044F \u043C\u0435\u0436\u0434\u0443 \u043F\u0440\u043E\u0435\u043A\u0442\u0430\u043C\u0438, \u0447\u0438\u0442\u0430\u0439 \u0437\u0430\u0434\u0430\u043D\u0438\u0435 \u0441\u0442\u0430\u043D\u0446\u0438\u0438 \u0446\u0435\u043B\u0438\u043A\u043E\u043C.\n\n\u041F\u043E\u0440\u044F\u0434\u043E\u043A (\u0440\u0430\u0437\u043C\u0435\u0442\u043A\u0443 \u0434\u0435\u043B\u0430\u0439 \u0434\u043E \u0440\u0435\u0434\u0430\u043A\u0442\u0443\u0440\u044B \u0440\u0435\u043F\u043B\u0438\u043A: \u043C\u0430\u0440\u0448\u0440\u0443\u0442\u044B \u0440\u0435\u043F\u043B\u0438\u043A \u0441\u0447\u0438\u0442\u0430\u044E\u0442\u0441\u044F \u0432\u043D\u0443\u0442\u0440\u0438 \u0441\u0431\u043E\u0440\u043A\u0438):\n\n1. **\u0420\u0430\u0437\u043C\u0435\u0442\u044C \u0441\u0431\u043E\u0440\u043A\u0438** \u0432 `builds` \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0430. \u041F\u0435\u0440\u0432\u0430\u044F \u0441\u0431\u043E\u0440\u043A\u0430 \u2014 \u0442\u0430, \u0447\u0442\u043E \u0443\u0436\u0435 \u0435\u0441\u0442\u044C: \u0435\u0451 `id` \u2014 `id` \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0430. \u041E\u0441\u0442\u0430\u043B\u044C\u043D\u044B\u0435 \u0434\u043E\u0431\u0430\u0432\u044C \u0441 `id` `<id \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0430>-2`, `-3` \u0438 \u0442\u0430\u043A \u0434\u0430\u043B\u0435\u0435 \u043F\u043E \u043F\u043E\u0440\u044F\u0434\u043A\u0443 \u043D\u0430\u0447\u0430\u043B\u0430. \u0423 \u043A\u0430\u0436\u0434\u043E\u0439 \u0441\u0431\u043E\u0440\u043A\u0438 `project`, `harness`, `workflow`, `title`, `language` \u0438 `runs`.\n2. **`runs`** \u2014 `agentId` \u0437\u0430\u043F\u0443\u0441\u043A\u043E\u0432 \u0441\u0442\u0430\u043D\u0446\u0438\u0439 \u0441\u0431\u043E\u0440\u043A\u0438. \u0420\u0430\u0441\u043A\u043B\u0430\u0434\u044B\u0432\u0430\u0439 \u043F\u043E \u0437\u0430\u0434\u0430\u043D\u0438\u044F\u043C \u0441\u0442\u0430\u043D\u0446\u0438\u0439: \u044D\u0442\u043E `said` \u0443 \u0440\u0435\u043F\u043B\u0438\u043A `assignment` \u0441 `run` (\u0442\u0430\u043C \u043D\u0430\u0437\u0432\u0430\u043D\u044B issue, \u043F\u0440\u043E\u0435\u043A\u0442 \u0438 \u0440\u0435\u043F\u043E\u0437\u0438\u0442\u043E\u0440\u0438\u0439). \u041A\u043E\u043C\u0430\u043D\u0434\u0430 `{{cli}} draft` \u0432 \u043A\u043E\u043D\u0446\u0435 \u043F\u0435\u0447\u0430\u0442\u0430\u0435\u0442 \xAB\u0437\u0430\u043F\u0443\u0441\u043A\u0438 \u0441\u0442\u0430\u043D\u0446\u0438\u0439 \u0431\u0435\u0437 \u0441\u0431\u043E\u0440\u043A\u0438\xBB \u2014 \u0430\u0433\u0435\u043D\u0442, `agentId`, \u0432\u0440\u0435\u043C\u044F \u0438 \u043F\u0435\u0440\u0432\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430 \u0437\u0430\u0434\u0430\u043D\u0438\u044F; \u043F\u043E \u043D\u0438\u043C \u0438 \u0440\u0430\u0441\u043A\u043B\u0430\u0434\u044B\u0432\u0430\u0439. \u0417\u0430\u043F\u0443\u0441\u043A, \u043D\u0435 \u0443\u043A\u0430\u0437\u0430\u043D\u043D\u044B\u0439 \u043D\u0438 \u0432 \u043E\u0434\u043D\u043E\u0439 \u0441\u0431\u043E\u0440\u043A\u0435, \u0434\u043E\u0441\u0442\u0430\u043D\u0435\u0442\u0441\u044F \u043F\u0435\u0440\u0432\u043E\u0439. \u041E\u0434\u0438\u043D `agentId` \u0432 \u0434\u0432\u0443\u0445 \u0441\u0431\u043E\u0440\u043A\u0430\u0445 \u0443\u043A\u0430\u0437\u044B\u0432\u0430\u0442\u044C \u043D\u0435\u043B\u044C\u0437\u044F.\n3. **`build`** \u0441\u0442\u0430\u0432\u044C \u0442\u043E\u043B\u044C\u043A\u043E \u0443 \u043F\u0440\u043E\u043C\u043F\u0442\u0430 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430 (\u0438 \u0440\u0435\u043F\u043B\u0438\u043A\u0438 \u0438\u043B\u0438 \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u0430), \u0441 \u043A\u043E\u0442\u043E\u0440\u043E\u0433\u043E \u043D\u0430\u0447\u0438\u043D\u0430\u0435\u0442\u0441\u044F \u0437\u0430\u0434\u0430\u0447\u0430: `"build": "<id \u0441\u0431\u043E\u0440\u043A\u0438>"`. \u041A\u043E\u043C\u0430\u043D\u0434\u044B \u0438 \u043F\u0440\u0430\u0432\u043A\u0438 \u043E\u0441\u043D\u043E\u0432\u043D\u043E\u0439 \u0441\u0435\u0441\u0441\u0438\u0438 \u043E\u0442\u043D\u043E\u0441\u044F\u0442\u0441\u044F \u043A \u0441\u0431\u043E\u0440\u043A\u0435 \u0441\u0432\u043E\u0435\u0433\u043E \u043F\u0440\u043E\u0435\u043A\u0442\u0430 \u0441\u0430\u043C\u0438: `{{cli}} draft` \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u044F\u0435\u0442 \u043F\u0440\u043E\u0435\u043A\u0442 \u043F\u043E \u043A\u0430\u0442\u0430\u043B\u043E\u0433\u0443 \u043A\u043E\u043C\u0430\u043D\u0434\u044B \u0438 \u0441\u0442\u0430\u0432\u0438\u0442 \u0443 \u0441\u043E\u0431\u044B\u0442\u0438\u044F `project`. \u0415\u0441\u043B\u0438 \u0441\u0431\u043E\u0440\u043E\u043A \u044D\u0442\u043E\u0433\u043E \u043F\u0440\u043E\u0435\u043A\u0442\u0430 \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E, \u0441\u043E\u0431\u044B\u0442\u0438\u0435 \u0438\u0434\u0451\u0442 \u0432 \u0442\u0443, \u043A \u043A\u043E\u0442\u043E\u0440\u043E\u0439 \u043E\u0442\u043D\u043E\u0441\u0438\u043B\u043E\u0441\u044C \u0431\u043B\u0438\u0436\u0430\u0439\u0448\u0435\u0435 \u043F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0435\u0435 \u0441\u043E\u0431\u044B\u0442\u0438\u0435 \u043F\u0440\u043E\u0435\u043A\u0442\u0430, \u0430 \u0434\u043E \u043F\u0435\u0440\u0432\u043E\u0433\u043E \u2014 \u0432 \u043F\u0435\u0440\u0432\u0443\u044E \u043F\u043E \u043F\u043E\u0440\u044F\u0434\u043A\u0443. \u041E\u0441\u0442\u0430\u043B\u044C\u043D\u044B\u0435 \u0441\u043E\u0431\u044B\u0442\u0438\u044F \u043E\u0441\u043D\u043E\u0432\u043D\u043E\u0439 \u0441\u0435\u0441\u0441\u0438\u0438 (\u043E\u0442\u0432\u0435\u0442\u044B, \u043F\u0440\u043E\u043C\u043F\u0442\u044B \u0431\u0435\u0437 `build`, \u0441\u043E\u0431\u044B\u0442\u0438\u044F \u0431\u0435\u0437 \u043F\u0440\u043E\u0435\u043A\u0442\u0430) \u0434\u043E\u0441\u0442\u0430\u044E\u0442\u0441\u044F \u0441\u0431\u043E\u0440\u043A\u0435 \u0431\u043B\u0438\u0436\u0430\u0439\u0448\u0435\u0433\u043E \u043F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0435\u0433\u043E \u0441\u043E\u0431\u044B\u0442\u0438\u044F \u0441\u043E \u0441\u0431\u043E\u0440\u043A\u043E\u0439, \u0434\u043E \u043F\u0435\u0440\u0432\u043E\u0433\u043E \u2014 \u043F\u0435\u0440\u0432\u043E\u0439. \u0415\u0441\u043B\u0438 `{{cli}} draft` \u043F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0430\u0435\u0442 \xAB\u043A\u043E\u043C\u0430\u043D\u0434\u044B \u043F\u0440\u043E\u0435\u043A\u0442\u0430 X \u0431\u0435\u0437 \u0441\u0431\u043E\u0440\u043A\u0438\xBB, \u0437\u0430\u0432\u0435\u0434\u0438 \u0434\u043B\u044F X \u0441\u0431\u043E\u0440\u043A\u0443: \u0438\u043D\u0430\u0447\u0435 \u0435\u0433\u043E \u043A\u043E\u043C\u0430\u043D\u0434\u044B \u0434\u043E\u0441\u0442\u0430\u043D\u0443\u0442\u0441\u044F \u0441\u0431\u043E\u0440\u043A\u0435 \u043F\u043E \u0432\u0440\u0435\u043C\u0435\u043D\u0438. `project` \u0443 \u0441\u043E\u0431\u044B\u0442\u0438\u0439 \u043D\u0435 \u043F\u0440\u0430\u0432\u044C, \u0432 \u0437\u0430\u043F\u0438\u0441\u044C \u043E\u043D \u043D\u0435 \u043F\u043E\u043F\u0430\u0434\u0430\u0435\u0442.\n4. **`project`, `harness` \u0438 `workflow`** \u0441\u0431\u043E\u0440\u043A\u0438 \u0432\u043E\u0437\u044C\u043C\u0438 \u0438\u0437 `.cyberzavod/project.json` \u0440\u0435\u043F\u043E\u0437\u0438\u0442\u043E\u0440\u0438\u044F \u0437\u0430\u0434\u0430\u0447\u0438: \u0436\u0443\u0440\u043D\u0430\u043B \u0437\u043D\u0430\u0435\u0442 \u0442\u043E\u043B\u044C\u043A\u043E \u043F\u0440\u043E\u0435\u043A\u0442, \u0432 \u043A\u043E\u0442\u043E\u0440\u043E\u043C \u0448\u043B\u0430 \u0441\u0435\u0441\u0441\u0438\u044F, \u0430 \u0437\u0430\u043F\u0443\u0441\u043A\u0438 \u0441\u0442\u0430\u043D\u0446\u0438\u0439 \u043C\u043E\u0433\u043B\u0438 \u0440\u0430\u0431\u043E\u0442\u0430\u0442\u044C \u0432 \u0434\u0440\u0443\u0433\u043E\u043C \u0440\u0435\u043F\u043E\u0437\u0438\u0442\u043E\u0440\u0438\u0438.\n5. **\u0421\u043D\u043E\u0432\u0430 \u0432\u044B\u043F\u043E\u043B\u043D\u0438 `{{cli}} draft`**: \u043E\u043D \u043F\u0435\u0440\u0435\u0441\u0447\u0438\u0442\u0430\u0435\u0442 \u043C\u0430\u0440\u0448\u0440\u0443\u0442\u044B \u0440\u0435\u043F\u043B\u0438\u043A \u043F\u043E \u0441\u0431\u043E\u0440\u043A\u0430\u043C \u0438 \u043D\u0430\u043F\u0435\u0447\u0430\u0442\u0430\u0435\u0442 \u043F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u044F (\u0437\u0430\u043F\u0443\u0441\u043A \u0438\u0437 `runs`, \u043A\u043E\u0442\u043E\u0440\u043E\u0433\u043E \u043D\u0435\u0442 \u0432 \u0436\u0443\u0440\u043D\u0430\u043B\u0435; \u0440\u0435\u043F\u043B\u0438\u043A\u0430 \u0441 \u0433\u043E\u0442\u043E\u0432\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439, \u0443 \u043A\u043E\u0442\u043E\u0440\u043E\u0439 \u043F\u043E\u043C\u0435\u043D\u044F\u043B\u0441\u044F \u043C\u0430\u0440\u0448\u0440\u0443\u0442 \u2014 \u043F\u0435\u0440\u0435\u0447\u0438\u0442\u0430\u0439 \u0435\u0451). \u0420\u0435\u0434\u0430\u043A\u0442\u0443\u0440\u0430 \u0438 \u0440\u0430\u0437\u043C\u0435\u0442\u043A\u0430 \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u044E\u0442\u0441\u044F.\n6. \u0417\u0430\u043F\u043E\u043B\u043D\u0438 \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043A\u0438, \u043F\u0440\u043E\u043C\u043F\u0442\u044B, \u0440\u0435\u043F\u043B\u0438\u043A\u0438 \u0438 \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u0430 (\u0448\u0430\u0433\u0438 2 \u0438 3 \u0432\u044B\u0448\u0435) \u0438 \u043F\u043E\u043A\u0430\u0436\u0438 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0443 \u0442\u0430\u0431\u043B\u0438\u0446\u0443 \u0441\u0431\u043E\u0440\u043E\u043A.\n7. \u041E\u043F\u0443\u0431\u043B\u0438\u043A\u0443\u0439 \u0432\u0441\u0435 \u0441\u0431\u043E\u0440\u043A\u0438 \u0441\u0440\u0430\u0437\u0443 \u0438\u043B\u0438 \u043E\u0434\u043D\u0443 \u0447\u0435\u0440\u0435\u0437 `--build`: \u0437\u0430\u0434\u0430\u0447\u0438, \u043A\u043E\u0442\u043E\u0440\u044B\u0435 \u0435\u0449\u0451 \u043D\u0435 \u0437\u0430\u043A\u043E\u043D\u0447\u0435\u043D\u044B, \u043C\u043E\u0436\u043D\u043E \u043E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C \u043F\u043E\u0437\u0436\u0435 \u0438\u0437 \u0442\u043E\u0433\u043E \u0436\u0435 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0430.\n\n## \u041F\u0440\u0430\u0432\u0438\u043B\u0430 \u0447\u0438\u0441\u0442\u043E\u0432\u043E\u0439 \u0432\u0435\u0440\u0441\u0438\u0438\n\n- **\u042D\u0442\u043E \u043F\u0440\u043E\u043C\u043F\u0442 \u0430\u0433\u0435\u043D\u0442\u0443.** \u0427\u0435\u043B\u043E\u0432\u0435\u043A \u043E\u0431\u0440\u0430\u0449\u0430\u0435\u0442\u0441\u044F \u043A \u043C\u043E\u0434\u0435\u043B\u0438 \u043D\u0430 \xAB\u0442\u044B\xBB \u0438 \u0432 \u043F\u043E\u0432\u0435\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u043C \u043D\u0430\u043A\u043B\u043E\u043D\u0435\u043D\u0438\u0438, \u043A\u0430\u043A \u0432 \u0436\u0438\u0432\u043E\u043C \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0438: \xAB\u041E\u043F\u0440\u0435\u0434\u0435\u043B\u0438 \u0441\u0442\u0438\u043B\u044C \u043A\u043E\u0434\u0430\xBB, \xAB\u041D\u0435 \u043F\u0438\u0448\u0438 \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0438-\u0440\u0430\u0437\u0434\u0435\u043B\u0438\u0442\u0435\u043B\u0438\xBB. \u041D\u0435 \u043F\u0440\u0435\u0432\u0440\u0430\u0449\u0430\u0439 \u043F\u0440\u043E\u043C\u043F\u0442 \u0432 \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u0437\u0430\u0434\u0430\u0447\u0438 (\xAB\u041E\u043F\u0440\u0435\u0434\u0435\u043B\u0438\u0442\u044C \u0441\u0442\u0438\u043B\u044C \u043A\u043E\u0434\u0430\xBB) \u0438 \u043D\u0435 \u043F\u0435\u0440\u0435\u0441\u043A\u0430\u0437\u044B\u0432\u0430\u0439 \u043E\u0442 \u0442\u0440\u0435\u0442\u044C\u0435\u0433\u043E \u043B\u0438\u0446\u0430 (\xAB\u0427\u0435\u043B\u043E\u0432\u0435\u043A \u043F\u0440\u043E\u0441\u0438\u0442\u2026\xBB).\n- **\u0421\u043C\u044B\u0441\u043B \u2014 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430.** \u041D\u0435 \u0434\u043E\u0431\u0430\u0432\u043B\u044F\u0439 \u0443\u043A\u0430\u0437\u0430\u043D\u0438\u0439, \u043A\u043E\u0442\u043E\u0440\u044B\u0445 \u043D\u0435 \u0431\u044B\u043B\u043E, \u0438 \u043D\u0435 \u0432\u044B\u0431\u0440\u0430\u0441\u044B\u0432\u0430\u0439 \u0432\u044B\u0441\u043A\u0430\u0437\u0430\u043D\u043D\u044B\u0435. \u0421\u043E\u043C\u043D\u0435\u043D\u0438\u0435 \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u0439 \u043A\u0430\u043A \u043F\u0440\u043E\u0441\u044C\u0431\u0443: \xAB\u043D\u0430\u0432\u0435\u0440\u043D\u043E, \u043D\u0443\u0436\u043D\u044B \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0438, \u043D\u0435 \u0437\u043D\u0430\u044E \u043A\u0430\u043A\u0438\u0435\xBB \u2192 \xAB\u041F\u043E\u0434\u0431\u0435\u0440\u0438 \u0441\u0442\u0438\u043B\u044C \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0435\u0432\xBB.\n- **\u041E\u0442\u0432\u0435\u0442\u044B \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430 \u043D\u0430 \u0432\u043E\u043F\u0440\u043E\u0441\u044B \u043C\u043E\u0434\u0435\u043B\u0438 \u2014 \u0447\u0430\u0441\u0442\u044C \u043F\u0440\u043E\u043C\u043F\u0442\u0430.** \u042D\u0442\u043E \u043D\u0435 \u043A\u0430\u0441\u0430\u0435\u0442\u0441\u044F \u0442\u043E\u0433\u043E, \u0447\u0442\u043E \u0443\u0436\u0435 \u0441\u0442\u0430\u043B\u043E `draft_intervention`: \u043E\u0442\u0432\u0435\u0442 \u043D\u0430 \u0432\u043E\u043F\u0440\u043E\u0441 \u0447\u0435\u0440\u0435\u0437 `AskUserQuestion` \u0438 \u0441\u043B\u043E\u0432\u043E \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430 \u043F\u043E\u0441\u043B\u0435 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0438 \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u043A\u0438 \u043E\u0441\u0442\u0430\u044E\u0442\u0441\u044F \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u0430\u043C\u0438, \u0438\u0445 \u0432 \u043F\u0440\u043E\u043C\u043F\u0442 \u043D\u0435 \u0432\u043D\u043E\u0441\u0438. \u0415\u0441\u043B\u0438 \u0432 \u0442\u043E\u0439 \u0436\u0435 \u0441\u0435\u0441\u0441\u0438\u0438 \u043C\u043E\u0434\u0435\u043B\u044C \u0437\u0430\u0434\u0430\u043B\u0430 \u0432\u043E\u043F\u0440\u043E\u0441\u044B \u0438\u043B\u0438 \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0438\u043B\u0430 \u0432\u0430\u0440\u0438\u0430\u043D\u0442\u044B, \u0430 \u0447\u0435\u043B\u043E\u0432\u0435\u043A \u043E\u0442\u0432\u0435\u0442\u0438\u043B \u0438\u043B\u0438 \u0432\u044B\u0431\u0440\u0430\u043B (\xAB1) \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0442\u044C \u0432\u0441\u0435\u0433\u0434\u0430 2) \u043D\u0430\u0437\u0432\u0430\u0442\u044C \u2014 \u043C\u0430\u0441\u0442\u0435\u0440\xBB), \u0435\u0433\u043E \u0440\u0435\u0448\u0435\u043D\u0438\u044F \u0432\u0445\u043E\u0434\u044F\u0442 \u0432 `requirements` \u043F\u0440\u043E\u043C\u043F\u0442\u0430, \u043A\u043E\u0442\u043E\u0440\u044B\u0439 \u043E\u043D\u0438 \u0443\u0442\u043E\u0447\u043D\u044F\u044E\u0442: \xAB\u041F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0439 \u043C\u0430\u0441\u0442\u0435\u0440\u0430 \u0432\u0441\u0435\u0433\u0434\u0430\xBB, \xAB\u041D\u0430\u0437\u043E\u0432\u0438 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u0436\u0430 \u2014 \u043C\u0430\u0441\u0442\u0435\u0440\xBB. \u0420\u0435\u0448\u0435\u043D\u0438\u0435 \u043F\u0435\u0440\u0435\u0441\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442\u0441\u044F \u0441\u043B\u043E\u0432\u0430\u043C\u0438 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430, \u0431\u0435\u0437 \u0441\u0430\u043C\u0438\u0445 \u0432\u043E\u043F\u0440\u043E\u0441\u043E\u0432 \u043C\u043E\u0434\u0435\u043B\u0438.\n- **\xAB\u0414\u0430\xBB, \xAB\u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u0439\xBB, \xAB\u0434\u0435\u043B\u0430\u0439\xBB \u0431\u0435\u0437 \u043D\u043E\u0432\u043E\u0433\u043E \u0441\u043E\u0434\u0435\u0440\u0436\u0430\u043D\u0438\u044F \u2014 \u0441\u043A\u043B\u0435\u0439\u043A\u0430.** \u0422\u0430\u043A\u043E\u0439 \u043F\u0440\u043E\u043C\u043F\u0442 \u043F\u043E\u043B\u0443\u0447\u0430\u0435\u0442 `joined: true`, \u0435\u0433\u043E `goal` \u0438 `requirements` \u043E\u0441\u0442\u0430\u044E\u0442\u0441\u044F \u043F\u0443\u0441\u0442\u044B\u043C\u0438, \u0430 \u0441\u043C\u044B\u0441\u043B \u2014 \u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, \u0432\u044B\u0431\u043E\u0440 \u0432\u0430\u0440\u0438\u0430\u043D\u0442\u0430, \u043A\u043E\u0442\u043E\u0440\u044B\u0439 \u043C\u043E\u0434\u0435\u043B\u044C \u043F\u0440\u0435\u0434\u043B\u0430\u0433\u0430\u043B\u0430, \u2014 \u0443\u0445\u043E\u0434\u0438\u0442 \u0432 \u043F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0438\u0439 \u043D\u0435\u0441\u043A\u043B\u0435\u0435\u043D\u043D\u044B\u0439 \u043F\u0440\u043E\u043C\u043F\u0442. \u041D\u0430 \u0441\u0430\u0439\u0442 \u0441\u043A\u043B\u0435\u0435\u043D\u043D\u044B\u0439 \u043F\u0440\u043E\u043C\u043F\u0442 \u043D\u0435 \u043F\u043E\u043F\u0430\u0434\u0430\u0435\u0442; \u043F\u0435\u0440\u0432\u044B\u043C \u043F\u0440\u043E\u043C\u043F\u0442 \u0441\u043A\u043B\u0435\u0435\u043D\u043D\u044B\u043C \u0431\u044B\u0442\u044C \u043D\u0435 \u043C\u043E\u0436\u0435\u0442. \u041D\u0438\u0447\u0435\u0433\u043E, \u0447\u0435\u0433\u043E \u0447\u0435\u043B\u043E\u0432\u0435\u043A \u043D\u0435 \u0433\u043E\u0432\u043E\u0440\u0438\u043B, \u043D\u0435 \u0434\u043E\u0431\u0430\u0432\u043B\u044F\u0439.\n- **`goal`** \u2014 \u0433\u043B\u0430\u0432\u043D\u043E\u0435 \u0443\u043A\u0430\u0437\u0430\u043D\u0438\u0435, \u043E\u0434\u043D\u0430 \u0441\u0442\u0440\u043E\u043A\u0430 \u0434\u043E 80 \u0437\u043D\u0430\u043A\u043E\u0432, \u0431\u0435\u0437 \u0442\u043E\u0447\u043A\u0438 \u0432 \u043A\u043E\u043D\u0446\u0435: \xAB\u041E\u043F\u0440\u0435\u0434\u0435\u043B\u0438 \u0441\u0442\u0438\u043B\u044C \u043A\u043E\u0434\u0430 \u043F\u0440\u043E\u0435\u043A\u0442\u0430\xBB, \xAB\u041E\u0431\u044A\u044F\u0441\u043D\u0438, \u0447\u0442\u043E \u0442\u0430\u043A\u043E\u0435 Let\'s Encrypt\xBB. \u041A\u043E\u0440\u043E\u0442\u043A\u0430\u044F \u0440\u0435\u043F\u043B\u0438\u043A\u0430 \u043E\u0441\u0442\u0430\u0451\u0442\u0441\u044F \u043A\u043E\u0440\u043E\u0442\u043A\u043E\u0439: \xAB\u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u0439\xBB \u2192 \xAB\u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u0439\xBB, \xAB\u0434\u0430, \u0434\u0435\u043B\u0430\u0439\xBB \u2192 \xAB\u0414\u0430, \u0434\u0435\u043B\u0430\u0439 \u043F\u043E \u043F\u043B\u0430\u043D\u0443\xBB.\n- **`requirements`** \u2014 \u0443\u0442\u043E\u0447\u043D\u0435\u043D\u0438\u044F \u0438\u0437 \u0442\u043E\u0433\u043E \u0436\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F, \u043A\u0430\u0436\u0434\u043E\u0435 \u2014 \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u043E\u0435 \u0443\u043A\u0430\u0437\u0430\u043D\u0438\u0435 \u043D\u0430 \xAB\u0442\u044B\xBB \u0431\u0435\u0437 \u0442\u043E\u0447\u043A\u0438 \u0432 \u043A\u043E\u043D\u0446\u0435: \xAB\u041F\u0435\u0440\u0435\u0434 \u0440\u0435\u0448\u0435\u043D\u0438\u0435\u043C \u0440\u0430\u0441\u0441\u043F\u0440\u043E\u0441\u0438 \u043C\u0435\u043D\u044F \u043E \u043F\u0440\u0435\u0434\u043F\u043E\u0447\u0442\u0435\u043D\u0438\u044F\u0445\xBB, \xAB\u041E\u0431\u043E\u0440\u0430\u0447\u0438\u0432\u0430\u0439 \u0433\u0440\u0443\u043F\u043F\u044B \u0442\u0435\u0441\u0442\u043E\u0432 \u0432 describe\xBB. \u0411\u0435\u0437 \xAB\u043F\u043B\u044E\u0441\xBB, \xAB\u043D\u0443\xBB, \xAB\u043A\u043E\u0440\u043E\u0447\u0435\xBB. \u0415\u0441\u043B\u0438 \u0443\u0442\u043E\u0447\u043D\u0435\u043D\u0438\u0439 \u043D\u0435\u0442, \u0441\u043F\u0438\u0441\u043E\u043A \u043F\u0443\u0441\u0442\u043E\u0439 \u2014 \u0442\u043E\u0433\u0434\u0430 \u043D\u0430 \u0441\u0430\u0439\u0442\u0435 \u043D\u0435\u0447\u0435\u0433\u043E \u0440\u0430\u0441\u043A\u0440\u044B\u0432\u0430\u0442\u044C.\n- \u041E\u0440\u0444\u043E\u0433\u0440\u0430\u0444\u0438\u044E \u0438 \u043F\u0443\u043D\u043A\u0442\u0443\u0430\u0446\u0438\u044E \u0438\u0441\u043F\u0440\u0430\u0432\u044C. \u0422\u0435\u0440\u043C\u0438\u043D\u044B \u043F\u0438\u0448\u0438 \u0442\u0430\u043A \u0436\u0435, \u043A\u0430\u043A \u0432 \u043A\u043E\u0434\u0435: `describe`, JSDoc, `@param`.\n- **\u041D\u0435 \u043F\u0443\u0431\u043B\u0438\u043A\u0443\u0439** \u0430\u0434\u0440\u0435\u0441\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u043E\u0432, IP, \u043F\u043E\u0447\u0442\u0443, \u043A\u043B\u044E\u0447\u0438, \u0442\u043E\u043A\u0435\u043D\u044B, \u043F\u0430\u0440\u043E\u043B\u0438, \u0438\u043C\u0435\u043D\u0430 \u043B\u044E\u0434\u0435\u0439 \u0438 \u043F\u0443\u0442\u0438 \u0441 \u0438\u043C\u0435\u043D\u0435\u043C \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F. \u0417\u0430\u043C\u0435\u043D\u044F\u0439 \u0438\u0445 \u043E\u0431\u0449\u0438\u043C \u0441\u043B\u043E\u0432\u043E\u043C: \xAB\u0430\u0434\u0440\u0435\u0441 \u0441\u0435\u0440\u0432\u0435\u0440\u0430\xBB, \xAB\u043A\u043B\u044E\u0447 SSH\xBB. \u0412\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u043D\u044B\u0439 \u0432\u044B\u0432\u043E\u0434 \u0442\u0435\u0440\u043C\u0438\u043D\u0430\u043B\u0430 \u043F\u0435\u0440\u0435\u0441\u043A\u0430\u0436\u0438 \u043E\u0434\u043D\u043E\u0439 \u0444\u0440\u0430\u0437\u043E\u0439: \xAB\u041F\u043E\u0441\u043C\u043E\u0442\u0440\u0438 \u043E\u0448\u0438\u0431\u043A\u0443: \u0441\u0435\u0440\u0432\u0435\u0440 \u043F\u0440\u043E\u0441\u0438\u0442 \u043F\u0430\u0440\u043E\u043B\u044C\xBB.\n- **`title`** \u0437\u0430\u043F\u0438\u0441\u0438 \u2014 \u0434\u043E 60 \u0437\u043D\u0430\u043A\u043E\u0432 \u043E \u0441\u0431\u043E\u0440\u043A\u0435 \u0432 \u0446\u0435\u043B\u043E\u043C, \u044D\u0442\u043E \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B, \u0430 \u043D\u0435 \u043F\u0440\u043E\u043C\u043F\u0442: \xAB\u0421\u0442\u0438\u043B\u044C \u043A\u043E\u0434\u0430 \u0438 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044F \u0437\u0430\u043F\u0438\u0441\u0435\u0439\xBB.\n\n## \u041F\u0440\u0438\u043C\u0435\u0440\n\n\u041A\u0430\u043A \u043D\u0430\u043F\u0438\u0441\u0430\u043D\u043E: \xAB\u0441\u043B\u0443\u0448\u0430\u0439 \u0434\u043E\u0431\u0430\u0432\u044C \u043D\u0430\u0434 \u0446\u0435\u0445\u043E\u043C \u0441\u0447\u0435\u0442\u0447\u0438\u043A \u0442\u043E\u043A\u0435\u043D\u043E\u0432, \u043D\u0443 \u0438 \u0432\u0440\u0435\u043C\u044F \u043D\u0430\u0432\u0435\u0440\u043D\u043E \u0442\u043E\u0436\u0435, \u0442\u043E\u043B\u044C\u043A\u043E \u0447\u0442\u043E\u0431 \u0431\u0435\u0437 js \u0435\u0441\u043B\u0438 \u043C\u043E\u0436\u043D\u043E\xBB\n\n```json\n{\n  "goal": "\u0414\u043E\u0431\u0430\u0432\u044C \u043D\u0430\u0434 \u0446\u0435\u0445\u043E\u043C \u0441\u0447\u0451\u0442\u0447\u0438\u043A\u0438",\n  "requirements": [\n    "\u041F\u043E\u043A\u0430\u0436\u0438 \u0447\u0438\u0441\u043B\u043E \u0442\u043E\u043A\u0435\u043D\u043E\u0432",\n    "\u0412\u0440\u0435\u043C\u044F \u0442\u043E\u0436\u0435 \u043F\u043E\u043A\u0430\u0436\u0438, \u0435\u0441\u043B\u0438 \u0443\u043C\u0435\u0441\u0442\u043D\u043E",\n    "\u041F\u043E \u0432\u043E\u0437\u043C\u043E\u0436\u043D\u043E\u0441\u0442\u0438 \u043E\u0431\u043E\u0439\u0434\u0438\u0441\u044C \u0431\u0435\u0437 JavaScript \u043D\u0430 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0435"\n  ]\n}\n```\n\n## \u041F\u0440\u0430\u0432\u0438\u043B\u0430 \u0440\u0435\u043F\u043B\u0438\u043A\n\n\u0420\u0435\u043F\u043B\u0438\u043A\u0438 \u0437\u0430\u043F\u043E\u043B\u043D\u044F\u0435\u0442 `recording-editor`. \u0418\u0441\u0445\u043E\u0434\u043D\u044B\u0439 \u0442\u0435\u043A\u0441\u0442 \u2014 `said`: \u0437\u0430\u0434\u0430\u043D\u0438\u0435 \u0441\u0442\u0430\u043D\u0446\u0438\u0438, \u043E\u0442\u0447\u0451\u0442 \u0441\u0442\u0430\u043D\u0446\u0438\u0438 \u0438\u043B\u0438 \u0438\u0442\u043E\u0433\u043E\u0432\u044B\u0439 \u043E\u0442\u0432\u0435\u0442 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0443; \u043C\u0430\u0440\u0448\u0440\u0443\u0442 (`from` \u0438 `to`) \u0438 `source` (`assignment`, `report`, `answer`) \u0443\u0436\u0435 \u0440\u0430\u0441\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u044B. \u0413\u043E\u0432\u043E\u0440\u0438\u0442 \u0432\u0441\u0435\u0433\u0434\u0430 \u0440\u0430\u0431\u043E\u0447\u0438\u0439 \u0441\u0442\u0430\u043D\u0446\u0438\u0438 `from` (\u0438\u043B\u0438 \u043C\u0430\u0441\u0442\u0435\u0440-\u0447\u0435\u043B\u043E\u0432\u0435\u043A), \u0430 `to` \u2014 \u0442\u043E\u0442, \u043A\u043E\u043C\u0443 \u043E\u043D \u0433\u043E\u0432\u043E\u0440\u0438\u0442: \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u0440\u0430\u0431\u043E\u0447\u0438\u0439 \u0438\u043B\u0438 \u043C\u0430\u0441\u0442\u0435\u0440.\n\n- **`line`** \u2014 \u043E\u0434\u043D\u0430 \u0441\u0442\u0440\u043E\u043A\u0430 \u043D\u0430\u0434 \u0433\u043E\u0432\u043E\u0440\u044F\u0449\u0438\u043C, \u0434\u043E 80 \u0437\u043D\u0430\u043A\u043E\u0432, \u0431\u0435\u0437 \u043F\u0435\u0440\u0435\u0432\u043E\u0434\u043E\u0432 \u0441\u0442\u0440\u043E\u043A\u0438. \u041A\u043E\u0440\u043E\u0442\u043A\u0430\u044F, \u0440\u0430\u0437\u0433\u043E\u0432\u043E\u0440\u043D\u0430\u044F, \u043E\u0442 \u043B\u0438\u0446\u0430 \u0440\u0430\u0431\u043E\u0447\u0435\u0433\u043E `from`, \u043F\u043E `source` \u0438 \u043C\u0430\u0440\u0448\u0440\u0443\u0442\u0443; \u043D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u0432\u044B\u0434\u0443\u043C\u044B\u0432\u0430\u0439 \u0441\u0432\u0435\u0440\u0445 `said`. \u041E\u0431\u0440\u0430\u0437\u0446\u044B:\n  - \u043E\u0442\u0447\u0451\u0442 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u043C\u0443 (`report`, `to` \u2014 \u0441\u0442\u0430\u043D\u0446\u0438\u044F): \xAB\u0414\u0435\u0440\u0436\u0438. \u0412\u0441\u0435 19 \u043F\u0443\u043D\u043A\u0442\u043E\u0432 \u0441\u0434\u0435\u043B\u0430\u043B\xBB;\n  - \u0437\u0430\u0434\u0430\u043D\u0438\u0435 \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u044E\u0449\u0435\u0433\u043E (`assignment`): \xAB\u041F\u0440\u0438\u043D\u044F\u043B. \u041F\u0440\u043E\u0439\u0434\u0443\u0441\u044C \u043F\u043E \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044F\u043C\xBB, \xAB\u041F\u0440\u0438\u043D\u044F\u043B, \u0438\u0437\u0443\u0447\u0443 \u043A\u043E\u0434 \u0438 \u043D\u0430\u043F\u0438\u0448\u0443 \u043F\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0443\xBB;\n  - \u0432\u043E\u0437\u0432\u0440\u0430\u0442: \xAB\u0412\u0435\u0440\u043D\u0443: \u043D\u0435\u0442 \u0442\u0435\u0441\u0442\u0430 \u043D\u0430 \u043F\u0443\u0441\u0442\u043E\u0439 \u0432\u0432\u043E\u0434\xBB (\u043E\u0442\u0447\u0451\u0442 \u0440\u0435\u0432\u044C\u044E \u0438\u043B\u0438 \u043F\u0440\u043E\u0432\u0435\u0440\u043E\u043A, `to` \u2014 \u0441\u0442\u0430\u043D\u0446\u0438\u044F) \u0438 \xAB\u041F\u043E\u043D\u044F\u043B, \u0447\u0438\u043D\u044E\xBB (\u0437\u0430\u0434\u0430\u043D\u0438\u0435 \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u044E\u0449\u0435\u0433\u043E \u043F\u043E\u0441\u043B\u0435 \u0432\u043E\u0437\u0432\u0440\u0430\u0442\u0430);\n  - \u043E\u0442\u0447\u0451\u0442 \u0438\u043B\u0438 \u043E\u0442\u0432\u0435\u0442 \u043C\u0430\u0441\u0442\u0435\u0440\u0443 (`to` \u2014 `foreman`): \xAB\u0412\u044B\u043A\u0430\u0442\u0438\u043B, CI \u0437\u0435\u043B\u0451\u043D\u044B\u0439\xBB, \xAB\u041F\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0430 \u0433\u043E\u0442\u043E\u0432\u0430: \u0442\u0440\u0438 \u0448\u0430\u0433\u0430\xBB.\n- **`text`** \u2014 \u043D\u0430\u0441\u0442\u043E\u044F\u0449\u0438\u0439 \u0442\u0435\u043A\u0441\u0442 `said`, \u043E\u0447\u0438\u0449\u0435\u043D\u043D\u044B\u0439: \u0442\u043E\u0442 \u0436\u0435 \u0441\u043C\u044B\u0441\u043B, \u043D\u043E \u043A\u043E\u0440\u043E\u0447\u0435 \u0438 \u0431\u0435\u0437 \u0441\u043B\u0443\u0436\u0435\u0431\u043D\u043E\u0433\u043E. \u0412 \u0433\u043E\u043B\u043E\u0441 \u0440\u0430\u0431\u043E\u0447\u0435\u0433\u043E \u0435\u0433\u043E \u043D\u0435 \u043F\u0435\u0440\u0435\u043F\u0438\u0441\u044B\u0432\u0430\u0439 \u2014 \u0440\u0430\u0437\u0433\u043E\u0432\u043E\u0440\u043D\u044B\u0439 \u0442\u043E\u043D \u0442\u043E\u043B\u044C\u043A\u043E \u0443 `line`. \u0410\u0431\u0437\u0430\u0446\u044B \u0440\u0430\u0437\u0434\u0435\u043B\u0435\u043D\u044B \u043F\u0443\u0441\u0442\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439. \u0411\u0435\u0437 markdown (\u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043A\u043E\u0432, \u0441\u043F\u0438\u0441\u043A\u043E\u0432, `**`, \u043E\u0431\u0440\u0430\u0442\u043D\u044B\u0445 \u043A\u0430\u0432\u044B\u0447\u0435\u043A, \u0442\u0430\u0431\u043B\u0438\u0446), \u0431\u0435\u0437 \u0432\u044B\u0432\u043E\u0434\u0430 \u0442\u0435\u0440\u043C\u0438\u043D\u0430\u043B\u0430, \u0431\u0435\u0437 \u043F\u0443\u0442\u0435\u0439 \u043A \u0444\u0430\u0439\u043B\u0430\u043C \u0438 \u0430\u0434\u0440\u0435\u0441\u043E\u0432. \u041F\u0443\u043D\u043A\u0442\u044B \u0441\u043F\u0438\u0441\u043A\u0430 \u043F\u0440\u0435\u0432\u0440\u0430\u0449\u0430\u0439 \u0432 \u043A\u043E\u0440\u043E\u0442\u043A\u0438\u0435 \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u0438\u043B\u0438 \u0430\u0431\u0437\u0430\u0446\u044B.\n- **\u0421\u043C\u044B\u0441\u043B \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u0439.** \u041D\u0435 \u0432\u044B\u0434\u0443\u043C\u044B\u0432\u0430\u0439 \u0442\u043E\u0433\u043E, \u0447\u0435\u0433\u043E \u043D\u0435\u0442 \u0432 `said`: \u043D\u0438 \u0432\u044B\u0432\u043E\u0434\u043E\u0432, \u043D\u0438 \u043E\u0431\u0435\u0449\u0430\u043D\u0438\u0439. \u0412\u0435\u0440\u0434\u0438\u043A\u0442\u044B \u0441\u0442\u0430\u043D\u0446\u0438\u0439 (\xAB\u041F\u0420\u0418\u041D\u042F\u0422\u041E\xBB, \xAB\u041D\u0410 \u0414\u041E\u0420\u0410\u0411\u041E\u0422\u041A\u0423\xBB, \xAB\u0414\u0415\u0424\u0415\u041A\u0422\xBB) \u043E\u0441\u0442\u0430\u0432\u043B\u044F\u0439 \u0432 \u043F\u0435\u0440\u0432\u043E\u0439 \u0444\u0440\u0430\u0437\u0435.\n- **\u041D\u0435 \u043F\u0443\u0431\u043B\u0438\u043A\u0443\u0439** \u0430\u0434\u0440\u0435\u0441\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u043E\u0432, IP, \u043F\u043E\u0447\u0442\u0443, \u043A\u043B\u044E\u0447\u0438, \u0442\u043E\u043A\u0435\u043D\u044B, \u043F\u0430\u0440\u043E\u043B\u0438, \u0438\u043C\u0435\u043D\u0430 \u043B\u044E\u0434\u0435\u0439 \u0438 \u043F\u0443\u0442\u0438 \u0441 \u0438\u043C\u0435\u043D\u0435\u043C \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F \u2014 \u043A\u0430\u043A \u0438 \u0432 \u043F\u0440\u043E\u043C\u043F\u0442\u0430\u0445; \u0437\u0430\u043C\u0435\u043D\u044F\u0439 \u043E\u0431\u0449\u0438\u043C \u0441\u043B\u043E\u0432\u043E\u043C.\n- \u041E\u0440\u0444\u043E\u0433\u0440\u0430\u0444\u0438\u044E \u0438 \u043F\u0443\u043D\u043A\u0442\u0443\u0430\u0446\u0438\u044E \u0438\u0441\u043F\u0440\u0430\u0432\u044C; \u0442\u0435\u0440\u043C\u0438\u043D\u044B \u043F\u0438\u0448\u0438 \u0442\u0430\u043A \u0436\u0435, \u043A\u0430\u043A \u0432 \u043A\u043E\u0434\u0435.\n\n## \u041F\u0440\u0430\u0432\u0438\u043B\u0430 \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\n\n\u0412\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u0430 \u0437\u0430\u043F\u043E\u043B\u043D\u044F\u0435\u0442 `recording-editor`. \u0412\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u043E \u2014 \u0441\u043B\u043E\u0432\u043E \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430, \u043A\u043E\u0442\u043E\u0440\u043E\u0433\u043E \u0436\u0434\u0430\u043B\u0430 \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u043A\u0430: \u0438\u0441\u0445\u043E\u0434\u043D\u044B\u0439 \u0442\u0435\u043A\u0441\u0442 `said` \u2014 \u043A\u0430\u043A \u0447\u0435\u043B\u043E\u0432\u0435\u043A \u0435\u0433\u043E \u0441\u043A\u0430\u0437\u0430\u043B (\u0443 \u043E\u0442\u0432\u0435\u0442\u0430 \u043D\u0430 \u0432\u043E\u043F\u0440\u043E\u0441 \u2014 \u0441\u0442\u0440\u043E\u043A\u0438 \xAB\u0432\u043E\u043F\u0440\u043E\u0441 \u2014 \u043E\u0442\u0432\u0435\u0442\xBB), \u0430 `reason` \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442, \u0447\u0442\u043E \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u043B\u043E \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u043A\u0443: `question` \u2014 \u0432\u043E\u043F\u0440\u043E\u0441 \u043C\u043E\u0434\u0435\u043B\u0438, `plan_review` \u2014 \u043F\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0430 \u0436\u0434\u0430\u043B\u0430 \u043E\u0434\u043E\u0431\u0440\u0435\u043D\u0438\u044F, `rework_limit` \u2014 \u0441\u0442\u0430\u043D\u0446\u0438\u044F \u0432\u0435\u0440\u043D\u0443\u043B\u0430 \u0440\u0430\u0431\u043E\u0442\u0443, \u0438 \u0432\u0435\u0434\u0443\u0449\u0438\u0439 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u043B\u0441\u044F, `stop_gate` \u2014 \u0445\u0443\u043A \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0438 \u0441\u0434\u0430\u043B\u0441\u044F. \u041F\u0440\u0438\u0447\u0438\u043D\u0443 \u0441\u0442\u0430\u0432\u0438\u0442 \u0441\u0431\u043E\u0440\u043A\u0430 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0430, \u0435\u0451 \u043D\u0435 \u043C\u0435\u043D\u044F\u0439.\n\n- **`line`** \u2014 \u0440\u0435\u0448\u0435\u043D\u0438\u0435 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430 \u0435\u0433\u043E \u0441\u043B\u043E\u0432\u0430\u043C\u0438, \u043E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u0435 \u043A \u0440\u0430\u0431\u043E\u0447\u0435\u043C\u0443 \u0441\u0442\u0430\u043D\u0446\u0438\u0438, \u0434\u043E 80 \u0437\u043D\u0430\u043A\u043E\u0432, \u043E\u0434\u043D\u0430 \u0441\u0442\u0440\u043E\u043A\u0430, \u0431\u0435\u0437 \u0442\u043E\u0447\u043A\u0438 \u0432 \u043A\u043E\u043D\u0446\u0435. \u041E\u0431\u0440\u0430\u0437\u0446\u044B: \xAB\u041E\u0434\u043E\u0431\u0440\u044F\u044E, \u0434\u0435\u043B\u0430\u0439 \u043F\u043E \u043F\u043B\u0430\u043D\u0443\xBB, \xAB\u0412\u043E\u0437\u044C\u043C\u0438 \u0432\u0430\u0440\u0438\u0430\u043D\u0442 \u0441 \u0442\u0430\u0431\u043B\u0438\u0446\u0435\u0439\xBB, \xAB\u041E\u0442\u043A\u0430\u0442\u0438 \u043A\u044D\u0448, \u0441\u0434\u0435\u043B\u0430\u0439 \u0431\u0435\u0437 \u043D\u0435\u0433\u043E\xBB.\n- **`text`** \u2014 \u043E\u0447\u0438\u0449\u0435\u043D\u043D\u044B\u0439 `said` \u043F\u043E \u043F\u0440\u0430\u0432\u0438\u043B\u0430\u043C `text` \u0440\u0435\u043F\u043B\u0438\u043A: \u0442\u043E\u0442 \u0436\u0435 \u0441\u043C\u044B\u0441\u043B \u0438 \u0442\u043E\u0442 \u0436\u0435 \u0433\u043E\u043B\u043E\u0441 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430, \u0430\u0431\u0437\u0430\u0446\u044B \u0447\u0435\u0440\u0435\u0437 \u043F\u0443\u0441\u0442\u0443\u044E \u0441\u0442\u0440\u043E\u043A\u0443, \u0431\u0435\u0437 markdown, \u0432\u044B\u0432\u043E\u0434\u0430 \u0442\u0435\u0440\u043C\u0438\u043D\u0430\u043B\u0430, \u043F\u0443\u0442\u0435\u0439 \u0438 \u0430\u0434\u0440\u0435\u0441\u043E\u0432. \u0423 \u043E\u0442\u0432\u0435\u0442\u0430 \u043D\u0430 \u0432\u043E\u043F\u0440\u043E\u0441 \u0432\u043E\u043F\u0440\u043E\u0441\u044B \u043D\u0435 \u043F\u0435\u0440\u0435\u0441\u043A\u0430\u0437\u044B\u0432\u0430\u0439, \u043E\u0441\u0442\u0430\u0432\u044C \u0440\u0435\u0448\u0435\u043D\u0438\u0435. \u041D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u0432\u044B\u0434\u0443\u043C\u044B\u0432\u0430\u0439 \u0441\u0432\u0435\u0440\u0445 `said`.\n- \u0423\u0442\u0435\u0447\u043A\u0438 \u2014 \u043A\u0430\u043A \u0432\u0435\u0437\u0434\u0435: \u0430\u0434\u0440\u0435\u0441\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u043E\u0432, IP, \u043F\u043E\u0447\u0442\u0443, \u043A\u043B\u044E\u0447\u0438, \u0442\u043E\u043A\u0435\u043D\u044B, \u043F\u0430\u0440\u043E\u043B\u0438, \u0438\u043C\u0435\u043D\u0430 \u043B\u044E\u0434\u0435\u0439 \u0438 \u043F\u0443\u0442\u0438 \u0441 \u0438\u043C\u0435\u043D\u0435\u043C \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F \u0437\u0430\u043C\u0435\u043D\u0438 \u043E\u0431\u0449\u0438\u043C \u0441\u043B\u043E\u0432\u043E\u043C.\n', "recording-editor.md": "---\nname: recording-editor\ndescription: \u0417\u0430\u043F\u043E\u043B\u043D\u044F\u0435\u0442 \u0443 \u0440\u0435\u043F\u043B\u0438\u043A \u0438 \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430 \u0432 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0435 \u0437\u0430\u043F\u0438\u0441\u0438 \u0441\u0442\u0440\u043E\u043A\u0443 \u043D\u0430\u0434 \u0433\u043E\u0432\u043E\u0440\u044F\u0449\u0438\u043C \u0438 \u043F\u043E\u043B\u043D\u044B\u0439 \u0442\u0435\u043A\u0441\u0442. \u0420\u0435\u0434\u0430\u043A\u0442\u0443\u0440\u0430 \u0432 /publish-recording; \u043F\u0440\u043E\u043C\u043F\u0442\u044B \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430 \u0438 \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A \u043F\u0440\u0430\u0432\u0438\u0442 \u0441\u0430\u043C\u0430 \u0441\u0435\u0441\u0441\u0438\u044F.\ntools: Read, Edit\nmodel: sonnet\neffort: medium\n---\n{{generated}}\n\n\u0422\u044B \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440 \u0437\u0430\u043F\u0438\u0441\u0435\u0439 \u0441\u0435\u0441\u0441\u0438\u0439. \u041D\u0430 \u0432\u0445\u043E\u0434\u0435 \u2014 \u043F\u0443\u0442\u044C \u043A \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0443 `{{drafts}}/<id>.json` \u0438 \u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u0440\u0435\u043F\u043B\u0438\u043A \u0438 \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432 \u0438\u0437 `.claude/skills/publish-recording/SKILL.md` (\u0440\u0430\u0437\u0434\u0435\u043B\u044B \xAB\u041F\u0440\u0430\u0432\u0438\u043B\u0430 \u0440\u0435\u043F\u043B\u0438\u043A\xBB \u0438 \xAB\u041F\u0440\u0430\u0432\u0438\u043B\u0430 \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\xBB): \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0439 \u0438\u0445 \u043F\u0435\u0440\u0432\u044B\u043C\u0438. \u0412 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0435 \u0443 \u043A\u0430\u0436\u0434\u043E\u0433\u043E \u0441\u043E\u0431\u044B\u0442\u0438\u044F `draft_message` \u0435\u0441\u0442\u044C \u0438\u0441\u0445\u043E\u0434\u043D\u044B\u0439 \u0442\u0435\u043A\u0441\u0442 `said` \u2014 \u0437\u0430\u0434\u0430\u043D\u0438\u0435 \u0441\u0442\u0430\u043D\u0446\u0438\u0438, \u043E\u0442\u0447\u0451\u0442 \u0441\u0442\u0430\u043D\u0446\u0438\u0438 \u0438\u043B\u0438 \u0438\u0442\u043E\u0433\u043E\u0432\u044B\u0439 \u043E\u0442\u0432\u0435\u0442 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0443, \u2014 \u043C\u0430\u0440\u0448\u0440\u0443\u0442 `from` \u2192 `to` (\u0440\u0430\u0431\u043E\u0447\u0438\u0435 \u0441\u0442\u0430\u043D\u0446\u0438\u0439 \u0438 \u043C\u0430\u0441\u0442\u0435\u0440-\u0447\u0435\u043B\u043E\u0432\u0435\u043A) \u0438 `source` (`assignment`, `report` \u0438\u043B\u0438 `answer`), \u0430 \u043F\u043E\u043B\u044F `line` \u0438 `text` \u043F\u0443\u0441\u0442\u044B. \u0423 \u043A\u0430\u0436\u0434\u043E\u0433\u043E \u0441\u043E\u0431\u044B\u0442\u0438\u044F `draft_intervention` \u2014 \u0441\u043B\u043E\u0432\u043E \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430, \u043A\u043E\u0442\u043E\u0440\u043E\u0433\u043E \u0436\u0434\u0430\u043B\u0430 \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u043A\u0430: \u0438\u0441\u0445\u043E\u0434\u043D\u044B\u0439 \u0442\u0435\u043A\u0441\u0442 `said` \u0438 \u043F\u0440\u0438\u0447\u0438\u043D\u0430 `reason` (`question`, `plan_review`, `rework_limit` \u0438\u043B\u0438 `stop_gate`), \u0430 `line` \u0438 `text` \u043F\u0443\u0441\u0442\u044B.\n\n\u0427\u0442\u043E \u0434\u0435\u043B\u0430\u0442\u044C:\n1. \u0417\u0430\u043F\u043E\u043B\u043D\u0438 `line` \u0438 `text` \u0443 \u043A\u0430\u0436\u0434\u043E\u0433\u043E `draft_message`, \u0443 \u043A\u043E\u0442\u043E\u0440\u043E\u0433\u043E \u043E\u043D\u0438 \u043F\u0443\u0441\u0442\u044B, \u043F\u043E \u043F\u0440\u0430\u0432\u0438\u043B\u0430\u043C \u0441\u043A\u0438\u043B\u043B\u0430. `line` \u043F\u0438\u0448\u0438 \u043E\u0442 \u043B\u0438\u0446\u0430 \u0433\u043E\u0432\u043E\u0440\u044F\u0449\u0435\u0433\u043E (`from`), \u043F\u043E `source` \u0438 \u043C\u0430\u0440\u0448\u0440\u0443\u0442\u0443: \u043E\u0431\u0440\u0430\u0437\u0446\u044B \u2014 \u0432 \xAB\u041F\u0440\u0430\u0432\u0438\u043B\u0430\u0445 \u0440\u0435\u043F\u043B\u0438\u043A\xBB. `text` \u2014 \u043D\u0430\u0441\u0442\u043E\u044F\u0449\u0438\u0439 \u0442\u0435\u043A\u0441\u0442 `said`, \u043E\u0447\u0438\u0449\u0435\u043D\u043D\u044B\u0439 \u043F\u043E \u043F\u0440\u0430\u0432\u0438\u043B\u0430\u043C \u0441\u043A\u0438\u043B\u043B\u0430; \u0432 \u0433\u043E\u043B\u043E\u0441 \u0440\u0430\u0431\u043E\u0447\u0435\u0433\u043E \u0435\u0433\u043E \u043D\u0435 \u043F\u0435\u0440\u0435\u043F\u0438\u0441\u044B\u0432\u0430\u0439. \u0422\u0435\u043C \u0436\u0435 \u0441\u043F\u043E\u0441\u043E\u0431\u043E\u043C \u0437\u0430\u043F\u043E\u043B\u043D\u0438 `line` \u0438 `text` \u0443 \u043A\u0430\u0436\u0434\u043E\u0433\u043E `draft_intervention` \u043F\u043E \xAB\u041F\u0440\u0430\u0432\u0438\u043B\u0430\u043C \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\xBB: `line` \u2014 \u0440\u0435\u0448\u0435\u043D\u0438\u0435 \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430 \u0435\u0433\u043E \u0441\u043B\u043E\u0432\u0430\u043C\u0438, \u043E\u0431\u0440\u0430\u0449\u0451\u043D\u043D\u043E\u0435 \u043A \u0440\u0430\u0431\u043E\u0447\u0435\u043C\u0443, `text` \u2014 \u043E\u0447\u0438\u0449\u0435\u043D\u043D\u044B\u0439 `said`. \u041F\u0440\u0438\u0447\u0438\u043D\u0443 `reason` \u043D\u0435 \u043C\u0435\u043D\u044F\u0439. \u041F\u0438\u0448\u0438 \u043D\u0430 \u044F\u0437\u044B\u043A\u0435 \u0437\u0430\u043F\u0438\u0441\u0438 \u2014 `language` \u0441\u0431\u043E\u0440\u043A\u0438 \u0432 `builds` \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0430: \u0437\u0430\u043F\u0438\u0441\u044C \u043D\u0435 \u043F\u0435\u0440\u0435\u0432\u043E\u0434\u0438\u0442\u0441\u044F. \u0423\u0436\u0435 \u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u043D\u044B\u0435 \u0440\u0435\u043F\u043B\u0438\u043A\u0438 \u0438 \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u0430 \u043D\u0435 \u0442\u0440\u043E\u0433\u0430\u0439, \u043A\u0440\u043E\u043C\u0435 \u043D\u0430\u0437\u0432\u0430\u043D\u043D\u044B\u0445 \u0432 \u0437\u0430\u0434\u0430\u043D\u0438\u0438: \u0438\u0445 \u043F\u0435\u0440\u0435\u043F\u0438\u0448\u0438 \u043F\u043E \u0437\u0430\u043C\u0435\u0447\u0430\u043D\u0438\u044F\u043C \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430.\n2. \u041E\u0441\u0442\u0430\u043B\u044C\u043D\u043E\u0435 \u0432 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0435 \u043D\u0435 \u043C\u0435\u043D\u044F\u0439: `said`, `source`, `reason`, `from`, `to`, `t`, `title`, \u043F\u0440\u043E\u043C\u043F\u0442\u044B \u0438 \u0441\u043E\u0431\u044B\u0442\u0438\u044F \u0446\u0435\u0445\u0430, \u0430 \u0442\u0430\u043A\u0436\u0435 \u0440\u0430\u0437\u043C\u0435\u0442\u043A\u0443 \u0441\u0431\u043E\u0440\u043E\u043A: `builds`, `build`, `run`, `draft_run`, `draft_check`.\n3. \u041F\u043E\u0441\u043B\u0435 \u043F\u0440\u0430\u0432\u043A\u0438 \u043F\u0435\u0440\u0435\u0447\u0438\u0442\u0430\u0439 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A: JSON \u0434\u043E\u043B\u0436\u0435\u043D \u043E\u0441\u0442\u0430\u0442\u044C\u0441\u044F \u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u043C, \u0443 \u043A\u0430\u0436\u0434\u043E\u0439 \u0440\u0435\u043F\u043B\u0438\u043A\u0438 \u0438 \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u0430 \u2014 \u043D\u0435\u043F\u0443\u0441\u0442\u044B\u0435 `line` (\u043E\u0434\u043D\u0430 \u0441\u0442\u0440\u043E\u043A\u0430, \u0434\u043E 80 \u0437\u043D\u0430\u043A\u043E\u0432) \u0438 `text`.\n\n\u0422\u044B \u043D\u0435 \u043F\u0443\u0431\u043B\u0438\u043A\u0443\u0435\u0448\u044C \u0437\u0430\u043F\u0438\u0441\u044C, \u043D\u0435 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u0435\u0448\u044C \u043A\u043E\u043C\u0430\u043D\u0434\u044B \u0438 \u043D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u043F\u0438\u0448\u0435\u0448\u044C \u0437\u0430 \u043F\u0440\u0435\u0434\u0435\u043B\u0430\u043C\u0438 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0430.\n\n\u041E\u0442\u0432\u0435\u0442 \u2014 \u043E\u0434\u043D\u0430 \u0441\u0442\u0440\u043E\u043A\u0430: \u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0440\u0435\u043F\u043B\u0438\u043A \u0438 \u0432\u043C\u0435\u0448\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432 \u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u043E \u0438 \u0441\u043A\u043E\u043B\u044C\u043A\u043E \u043E\u0441\u0442\u0430\u043B\u043E\u0441\u044C \u043F\u0443\u0441\u0442\u044B\u043C\u0438 (\u0441 \u043F\u0440\u0438\u0447\u0438\u043D\u043E\u0439).\n", "rules.md": "# {{name}}\n\n\u041F\u0440\u0430\u0432\u0438\u043B\u0430 \u044D\u0442\u043E\u0433\u043E \u043F\u0440\u043E\u0435\u043A\u0442\u0430 \u0434\u043B\u044F \u0430\u0433\u0435\u043D\u0442\u043E\u0432 \u0438 \u043B\u044E\u0434\u0435\u0439. \u041F\u0440\u043E\u0446\u0435\u0441\u0441 \u0440\u0430\u0437\u0440\u0430\u0431\u043E\u0442\u043A\u0438 \u0437\u0430\u0434\u0430\u0451\u0442 Cyberzavod: \u044D\u0442\u0430\u043F\u044B, \u0440\u043E\u043B\u0438 \u0438 \u043E\u0431\u0449\u0438\u0435 \u043F\u0440\u0438\u043D\u0446\u0438\u043F\u044B \u043F\u0440\u0438\u0445\u043E\u0434\u044F\u0442 \u0438\u0437 \u0435\u0433\u043E harness, \u0437\u0434\u0435\u0441\u044C \u2014 \u0442\u043E\u043B\u044C\u043A\u043E \u0442\u043E, \u0447\u0442\u043E \u043E\u0442\u043D\u043E\u0441\u0438\u0442\u0441\u044F \u043A \u043F\u0440\u043E\u0435\u043A\u0442\u0443. \u0424\u0430\u0439\u043B\u044B \u043A\u043E\u043D\u043A\u0440\u0435\u0442\u043D\u043E\u0433\u043E \u0430\u0433\u0435\u043D\u0442\u0430 (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, `CLAUDE.md`) \u0441\u043E\u0437\u0434\u0430\u0451\u0442 `cyberzavod sync` \u043F\u043E\u0432\u0435\u0440\u0445 \u044D\u0442\u043E\u0433\u043E \u0444\u0430\u0439\u043B\u0430.\n\n## \u041A\u043E\u043C\u0430\u043D\u0434\u044B\n\n- \u0424\u043E\u0440\u043C\u0430\u0442\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435: \u0432\u043F\u0438\u0448\u0438 \u043A\u043E\u043C\u0430\u043D\u0434\u0443 \u0438\u043B\u0438 \u0443\u0434\u0430\u043B\u0438 \u0441\u0442\u0440\u043E\u043A\u0443 \u2014 \u0431\u0435\u0437 \u043D\u0435\u0451 \u0448\u0430\u0433 \u043F\u0440\u043E\u043F\u0443\u0441\u043A\u0430\u0435\u0442\u0441\u044F.\n- \u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 (`verification.commands` \u0432 `.cyberzavod/project.json`):\n{{verification}}\n\n## \u0417\u0430\u0434\u0430\u0447\u0438\n\n\u0413\u0434\u0435 \u043B\u0435\u0436\u0430\u0442 \u0437\u0430\u0434\u0430\u0447\u0438, \u043A\u0430\u043A \u0438\u0445 \u0447\u0438\u0442\u0430\u0442\u044C \u0438 \u043A\u0430\u043A \u043D\u0430 \u043D\u0438\u0445 \u0441\u0441\u044B\u043B\u0430\u0442\u044C\u0441\u044F \u0432 \u043A\u043E\u043C\u043C\u0438\u0442\u0430\u0445.\n\n## \u041A\u043E\u0434 \u0438 \u0442\u0435\u0441\u0442\u044B\n\n\u041F\u0440\u0430\u0432\u0438\u043B\u0430 \u043A\u043E\u0434\u0430 \u0438 \u0442\u0435\u0441\u0442\u043E\u0432 \u043F\u0440\u043E\u0435\u043A\u0442\u0430: \u043F\u043E \u043D\u0438\u043C \u043F\u0438\u0448\u0435\u0442 \u0438\u0441\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C, \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u044E\u0442 \u0442\u0435\u0441\u0442\u0438\u0440\u043E\u0432\u0449\u0438\u043A \u0438 \u0440\u0435\u0432\u044C\u044E\u0435\u0440.\n" };
async function readAssets() {
  return { harness, templates, tool: readFileSync3(fileURLToPath(import.meta.url), "utf8") };
}

// src/installation/installation.ts
var HARNESS_VERSION = "0.7.1";
var RULES_TEMPLATE = "rules.md";
function template(templates2, name) {
  const text = templates2[name];
  if (text === void 0) throw new Error(`\u0432 \u0443\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0435 \u043D\u0435\u0442 \u0448\u0430\u0431\u043B\u043E\u043D\u0430 ${name}`);
  return text;
}
async function readInstallation() {
  const { harness: harness2, templates: templates2, tool } = await readAssets();
  return {
    harness: parseHarness(harness2),
    rulesTemplate: template(templates2, RULES_TEMPLATE),
    claudeTemplates: {
      publishRecording: template(templates2, "publish-recording.md"),
      recordingEditor: template(templates2, "recording-editor.md")
    },
    tool
  };
}
function toolOf(installation) {
  if (installation.tool === void 0) {
    throw new CommandError(
      "CLI \u0437\u0430\u043F\u0443\u0449\u0435\u043D \u0438\u0437 \u0438\u0441\u0445\u043E\u0434\u043D\u0438\u043A\u043E\u0432: \u0441\u043E\u0431\u0435\u0440\u0438\u0442\u0435 \u0435\u0433\u043E (pnpm cyberzavod) \u0438 \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 \u0441\u043E\u0431\u0440\u0430\u043D\u043D\u044B\u0439"
    );
  }
  return installation.tool;
}

// src/wizard.ts
import { createInterface } from "node:readline";
import path12 from "node:path";
var DEFAULT_AGENT = {
  provider: "anthropic",
  agent: "claude"
};
var LIST_SEPARATOR = ";";
function defaultsPrompter() {
  return { ask: (_question, fallback) => Promise.resolve(fallback), close: () => void 0 };
}
function terminalPrompter(streams) {
  const terminal = createInterface({ input: streams.input });
  const lines = terminal[Symbol.asyncIterator]();
  return {
    ask: async (question, fallback) => {
      streams.output.write(`${question} [${fallback}]: `);
      const line = await lines.next();
      if (line.done === true) {
        streams.output.write("\n");
        return fallback;
      }
      const answer = line.value.trim();
      return answer === "" ? fallback : answer;
    },
    close: () => {
      terminal.close();
    }
  };
}
function describeDetected(root, detected) {
  const listed = (values) => values.length === 0 ? "\u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u044B" : values.join(", ");
  return [
    `\u041F\u0440\u043E\u0435\u043A\u0442: ${detected.name} (${root})`,
    `\u042F\u0437\u044B\u043A\u0438: ${listed(detected.languages)}`,
    `\u0424\u0440\u0435\u0439\u043C\u0432\u043E\u0440\u043A\u0438: ${listed(detected.frameworks)}`,
    `\u041C\u0435\u043D\u0435\u0434\u0436\u0435\u0440 \u043F\u0430\u043A\u0435\u0442\u043E\u0432: ${detected.packageManager ?? "\u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D"}`,
    `Git: ${detected.git ? "\u0435\u0441\u0442\u044C" : "\u043D\u0435\u0442"}`,
    `\u0421\u043A\u0440\u0438\u043F\u0442\u044B: ${listed(detected.scripts)}`
  ];
}
function splitList(answer) {
  const parts = answer.split(LIST_SEPARATOR).map((part) => part.trim());
  return parts.filter((part) => part !== "");
}
async function askAgents(harness2, stages, prompter) {
  const agents = {};
  for (const stage of stages) {
    const guide = harness2.stages[stage];
    if (guide.role === void 0) continue;
    const model = await prompter.ask(
      `\u041C\u043E\u0434\u0435\u043B\u044C \u044D\u0442\u0430\u043F\u0430 \xAB${guide.title}\xBB (\u0430\u0433\u0435\u043D\u0442 ${DEFAULT_AGENT.agent})`,
      DEFAULT_MODEL
    );
    agents[stage] = { ...DEFAULT_AGENT, model };
  }
  return agents;
}
async function askProjectConfig(detected, harness2, prompter) {
  const projectIdAnswer = await prompter.ask("\u0418\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u043F\u0440\u043E\u0435\u043A\u0442\u0430", projectIdOf(detected.name));
  const workflowName = await prompter.ask("\u041F\u0440\u043E\u0446\u0435\u0441\u0441", "default");
  const projectId = projectIdOf(projectIdAnswer);
  const workflow = workflowOf(harness2, workflowName);
  const agents = await askAgents(harness2, workflow.stages, prompter);
  const journal = await prompter.ask("\u041A\u0430\u0442\u0430\u043B\u043E\u0433 \u0436\u0443\u0440\u043D\u0430\u043B\u0430 \u043E\u0442 \u043A\u043E\u0440\u043D\u044F \u043F\u0440\u043E\u0435\u043A\u0442\u0430", DEFAULT_JOURNAL);
  const commands = await prompter.ask(
    `\u041A\u043E\u043C\u0430\u043D\u0434\u044B \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u0447\u0435\u0440\u0435\u0437 \xAB${LIST_SEPARATOR}\xBB`,
    detected.verification.join(`${LIST_SEPARATOR} `)
  );
  return {
    projectId,
    workflow: workflow.name,
    journal: journal.split(path12.sep).join("/"),
    agents,
    verification: { commands: splitList(commands), paths: [] },
    stack: stackOf(detected)
  };
}

// src/commands/gitignore.ts
import { appendFile as appendFile2 } from "node:fs/promises";
import path13 from "node:path";
var GITIGNORE = ".gitignore";
async function ignoreCapture(root, journal) {
  const relative = path13.posix.normalize(journal);
  if (relative.startsWith("..") || path13.isAbsolute(journal)) return void 0;
  const entry = `/${relative}/${CAPTURE_DIRECTORY}/`;
  const file = path13.join(root, GITIGNORE);
  const current = await readOptionalText(file);
  if (current?.split(/\r?\n/).includes(entry) === true) return void 0;
  const separator = current === void 0 || current.endsWith("\n") ? "" : "\n";
  await appendFile2(file, `${separator}${entry}
`);
  return entry;
}

// src/commands/tool-file.ts
import { mkdir as mkdir6, writeFile as writeFile7 } from "node:fs/promises";
import path14 from "node:path";
function toolFilePath(root) {
  return path14.join(root, ...TOOL_FILE.split("/"));
}
function sameText2(left, right) {
  return left.replace(/\r\n/g, "\n") === right.replace(/\r\n/g, "\n");
}
async function isToolFileOutdated(root, tool) {
  const current = await readOptionalText(toolFilePath(root));
  return current === void 0 || !sameText2(current, tool);
}
async function updateToolFile(root, tool) {
  if (!await isToolFileOutdated(root, tool)) return false;
  const file = toolFilePath(root);
  await mkdir6(path14.dirname(file), { recursive: true });
  await writeFile7(file, tool);
  return true;
}

// src/commands/init.ts
var RULES_FILE3 = "AGENTS.md";
var LEGACY_ENTRYPOINT = "CLAUDE.md";
function starterRules(template2, name, commands) {
  const verification = commands.length === 0 ? "  - \u043F\u043E\u043A\u0430 \u043D\u0435 \u0437\u0430\u0434\u0430\u043D\u044B" : commands.map((command) => `  - \`${command}\``).join("\n");
  return template2.replace("{{name}}", name).replace("{{verification}}", verification);
}
async function ensureRules(root, template2, name, commands) {
  const rules = path15.join(root, RULES_FILE3);
  const hasRules = await readOptionalText(rules) !== void 0;
  if (hasRules) return `${RULES_FILE3} \u0443\u0436\u0435 \u0435\u0441\u0442\u044C \u2014 \u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D`;
  const legacy = path15.join(root, LEGACY_ENTRYPOINT);
  const hasLegacyEntrypoint = await readOptionalText(legacy) !== void 0;
  if (hasLegacyEntrypoint) {
    await rename(legacy, rules);
    return `${LEGACY_ENTRYPOINT} \u043F\u0435\u0440\u0435\u043D\u0435\u0441\u0451\u043D \u0432 ${RULES_FILE3}: \u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u043F\u0440\u043E\u0435\u043A\u0442\u0430 \u0442\u0435\u043F\u0435\u0440\u044C \u0442\u0430\u043C`;
  }
  await writeFile8(rules, starterRules(template2, name, commands));
  return `${RULES_FILE3} \u2014 \u0437\u0430\u0433\u043E\u0442\u043E\u0432\u043A\u0430 \u043F\u0440\u0430\u0432\u0438\u043B \u043F\u0440\u043E\u0435\u043A\u0442\u0430, \u0437\u0430\u043F\u043E\u043B\u043D\u0438\u0442\u0435 \u0435\u0451`;
}
function printCreated(rules, files, ignored) {
  console.log(`
\u0421\u043E\u0437\u0434\u0430\u043D\u043E:
  ${PROJECT_CONFIG_FILE}
  ${TOOL_FILE}
  ${rules}`);
  for (const file of files) console.log(`  ${file}`);
  if (ignored !== void 0) console.log(`  .gitignore: ${ignored}`);
}
function printNextSteps(journal) {
  console.log(
    `
\u0416\u0443\u0440\u043D\u0430\u043B \u043F\u0440\u043E\u0435\u043A\u0442\u0430: ${journal}
\u0417\u0430\u043A\u043E\u043C\u043C\u0438\u0442\u044C\u0442\u0435 .cyberzavod/, AGENTS.md, CLAUDE.md \u0438 .claude/: \u0445\u0443\u043A\u0438 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u044E\u0442 CLI \u0438\u0437 \u043F\u0440\u043E\u0435\u043A\u0442\u0430.
\u0414\u0430\u043B\u044C\u0448\u0435: \u0434\u043E\u043F\u0438\u0448\u0438\u0442\u0435 \u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u0432 AGENTS.md \u0438 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u0439\u0442\u0435 \u0437\u0430\u0434\u0430\u0447\u0438 \u0447\u0435\u0440\u0435\u0437 /feature \u0432 Claude Code.`
  );
}
async function initProject(root, prompter, installation) {
  const isConnected = await readProjectConfig(root) !== void 0;
  if (isConnected) {
    throw new CommandError(`${PROJECT_CONFIG_FILE} \u0443\u0436\u0435 \u0435\u0441\u0442\u044C: \u043F\u0440\u043E\u0435\u043A\u0442 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0451\u043D, \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 sync`);
  }
  const tool = toolOf(installation);
  const detected = await detectProject(root);
  for (const line of describeDetected(root, detected)) console.log(line);
  const answers = await askProjectConfig(detected, installation.harness, prompter);
  const { projectId, ...rest } = answers;
  const config = { projectId, harness: HARNESS_VERSION, ...rest };
  await writeProjectConfig(root, config);
  const rules = await ensureRules(
    root,
    installation.rulesTemplate,
    detected.name,
    config.verification.commands
  );
  await updateToolFile(root, tool);
  const ignored = await ignoreCapture(root, config.journal);
  const report = await syncClaude({
    projectDirectory: root,
    installation: { harness: installation.harness, templates: installation.claudeTemplates }
  });
  printCreated(rules, report.changed, ignored);
  printNextSteps(config.journal);
}

// src/commands/journal.ts
import { randomUUID } from "node:crypto";
import path16 from "node:path";

// src/commands/project.ts
async function requireProjectAt(directory) {
  const root = await findProjectRoot(directory);
  const config = root === void 0 ? void 0 : await readProjectConfig(root);
  if (root === void 0 || config === void 0) {
    throw new CommandError(`${directory} \u043D\u0435 \u0432 \u043F\u0440\u043E\u0435\u043A\u0442\u0435 Cyberzavod: \u0441\u043D\u0430\u0447\u0430\u043B\u0430 cyberzavod init`);
  }
  return { root, config, journal: journalDirectory(root, config) };
}

// src/commands/journal.ts
var DATE_LENGTH = "2026-01-01".length;
var ID_SUFFIX_LENGTH = 8;
function manualHeader(projectId, now) {
  const timestamp = now.toISOString();
  const suffix = randomUUID().slice(0, ID_SUFFIX_LENGTH);
  return {
    version: RECORD_VERSION,
    id: `${timestamp.slice(0, DATE_LENGTH)}-${suffix}`,
    timestamp,
    projectId,
    source: { type: "manual" }
  };
}
async function writeRecord(directory, build) {
  const project = await requireProjectAt(directory);
  const store = new DirectoryRecordStore(project.journal);
  const record = parseRecord(build(project.config.projectId));
  await store.write(record);
  console.log(`\u0437\u0430\u043F\u0438\u0441\u0430\u043D\u043E: ${path16.relative(project.root, store.pathOf(record))}`);
}
async function recordDecision(directory, title, description) {
  await writeRecord(directory, (projectId) => ({
    ...manualHeader(projectId, /* @__PURE__ */ new Date()),
    type: "decision",
    data: { title, description }
  }));
}
async function recordNote(directory, text) {
  await writeRecord(directory, (projectId) => ({
    ...manualHeader(projectId, /* @__PURE__ */ new Date()),
    type: "note",
    data: { text }
  }));
}

// src/sharing/device-flow.ts
var SLOW_DOWN_STEP_SECONDS = 5;
var MILLISECONDS_IN_SECOND = 1e3;
async function waitForAccessToken(options) {
  const { auth, clientId, code, sleep } = options;
  let intervalSeconds = code.intervalSeconds;
  let waitedSeconds = 0;
  while (waitedSeconds < code.expiresInSeconds) {
    await sleep(intervalSeconds * MILLISECONDS_IN_SECOND);
    waitedSeconds += intervalSeconds;
    const poll = await auth.pollAccessToken(clientId, code.deviceCode);
    switch (poll.status) {
      case "granted":
        return poll.token;
      case "pending":
        break;
      case "slow_down":
        intervalSeconds += SLOW_DOWN_STEP_SECONDS;
        break;
      case "expired":
        throw new CommandError("\u043A\u043E\u0434 \u0432\u0445\u043E\u0434\u0430 \u0438\u0441\u0442\u0451\u043A: \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 cyberzavod login \u0437\u0430\u043D\u043E\u0432\u043E");
      case "denied":
        throw new CommandError("\u0432\u0445\u043E\u0434 \u043E\u0442\u043A\u043B\u043E\u043D\u0451\u043D \u043D\u0430 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0435 GitHub");
    }
  }
  throw new CommandError("\u043A\u043E\u0434 \u0432\u0445\u043E\u0434\u0430 \u0438\u0441\u0442\u0451\u043A: \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 cyberzavod login \u0437\u0430\u043D\u043E\u0432\u043E");
}

// src/commands/login.ts
async function login(sharing) {
  const clientId = await sharing.api.githubClientId();
  const code = await sharing.github.requestDeviceCode(clientId);
  console.log(`\u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 ${code.verificationUri} \u0438 \u0432\u0432\u0435\u0434\u0438\u0442\u0435 \u043A\u043E\u0434 ${code.userCode}`);
  console.log("\u0416\u0434\u0443 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F\u2026");
  const token = await waitForAccessToken({
    auth: sharing.github,
    clientId,
    code,
    sleep: (milliseconds) => sharing.sleep(milliseconds)
  });
  const me = await sharing.api.me(token);
  await sharing.credentials.save(token);
  console.log(`\u0432\u0445\u043E\u0434 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D: ${me.login}`);
}
async function logout(sharing) {
  const hadToken = await sharing.credentials.remove();
  console.log(hadToken ? "\u0432\u044B \u0432\u044B\u0448\u043B\u0438: \u0442\u043E\u043A\u0435\u043D \u0443\u0434\u0430\u043B\u0451\u043D" : "\u0432\u0445\u043E\u0434\u0430 \u0438 \u043D\u0435 \u0431\u044B\u043B\u043E");
}

// src/commands/share.ts
import { readFile as readFile8 } from "node:fs/promises";
import path17 from "node:path";
function requireRecordId(id) {
  if (!isRecordId(id)) {
    throw new CommandError(`${id} \u043D\u0435 \u043F\u043E\u0445\u043E\u0436 \u043D\u0430 id \u0437\u0430\u043F\u0438\u0441\u0438: \u0442\u043E\u043B\u044C\u043A\u043E \u0431\u0443\u043A\u0432\u044B, \u0446\u0438\u0444\u0440\u044B, \xAB_\xBB \u0438 \xAB-\xBB`);
  }
}
async function readRecordText(project, id) {
  const file = path17.join(project.journal, RECORD_COLLECTIONS.session, `${id}.json`);
  try {
    return await readFile8(file, "utf8");
  } catch (err) {
    if (!isNotFound(err)) throw err;
    const shown = path17.relative(project.root, file);
    throw new CommandError(`\u0432 \u0436\u0443\u0440\u043D\u0430\u043B\u0435 \u043D\u0435\u0442 \u0437\u0430\u043F\u0438\u0441\u0438 ${id}: \u0444\u0430\u0439\u043B\u0430 ${shown} \u043D\u0435 \u0441\u0443\u0449\u0435\u0441\u0442\u0432\u0443\u0435\u0442`, {
      cause: err
    });
  }
}
function parseSession(text, id) {
  try {
    const record = parseRecord(JSON.parse(text));
    if (record.type !== "session") throw new RecordError(`\u0442\u0438\u043F ${record.type}, \u043D\u0443\u0436\u043D\u0430 \u0441\u0435\u0441\u0441\u0438\u044F`);
    return record;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CommandError(`\u0437\u0430\u043F\u0438\u0441\u044C ${id} \u043D\u0435 \u043F\u0440\u043E\u0448\u043B\u0430 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0443: ${reason}`, { cause: err });
  }
}
function recordingLines(recordings) {
  return recordings.map((recording) => `  ${recording.id}  ${recording.title}`);
}
async function limitReachedError(sharing, token, serverMessage) {
  const me = await sharing.api.me(token);
  const lines = [
    serverMessage,
    `\u0417\u0430\u043F\u0438\u0441\u0438 \u0432 \u0433\u0430\u043B\u0435\u0440\u0435\u0435 (${me.recordings.length} \u0438\u0437 ${me.limit}):`,
    ...recordingLines(me.recordings),
    "\u041E\u0441\u0432\u043E\u0431\u043E\u0434\u0438\u0442\u0435 \u043C\u0435\u0441\u0442\u043E \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 cyberzavod unshare <id>"
  ];
  return new CommandError(lines.join("\n"));
}
async function upload(sharing, token, id, record) {
  try {
    return await sharing.api.uploadRecording(token, id, record);
  } catch (err) {
    if (!isApiError(err, LIMIT_REACHED_CODE)) throw err;
    throw await limitReachedError(sharing, token, err.message);
  }
}
async function shareRecording(sharing, directory, id) {
  requireRecordId(id);
  const project = await requireProjectAt(directory);
  const text = await readRecordText(project, id);
  const record = parseSession(text, id);
  const { uploaded, me } = await withToken(sharing, async (token) => ({
    uploaded: await upload(sharing, token, id, record),
    me: await sharing.api.me(token)
  }));
  const verb = uploaded.isNew ? "\u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0430" : "\u0437\u0430\u043C\u0435\u043D\u0435\u043D\u0430";
  console.log(`\u0437\u0430\u043F\u0438\u0441\u044C ${id} ${verb}`);
  console.log(`\u0441\u0441\u044B\u043B\u043A\u0430: ${recordingLink(sharing.siteUrl, uploaded.recording.slug)}`);
  if (!me.galleryPublic) {
    console.log("\u0433\u0430\u043B\u0435\u0440\u0435\u044F \u0437\u0430\u043A\u0440\u044B\u0442\u0430: \u0437\u0430\u043F\u0438\u0441\u044C \u0432\u0438\u0434\u043D\u0430 \u0442\u043E\u043B\u044C\u043A\u043E \u043F\u043E \u044D\u0442\u043E\u0439 \u0441\u0441\u044B\u043B\u043A\u0435");
    console.log("\u043E\u0442\u043A\u0440\u044B\u0442\u044C \u0433\u0430\u043B\u0435\u0440\u0435\u044E: cyberzavod gallery --public");
  }
}
async function unshareRecording(sharing, id) {
  requireRecordId(id);
  await withToken(sharing, (token) => sharing.api.deleteRecording(token, id));
  console.log(`\u0437\u0430\u043F\u0438\u0441\u044C ${id} \u0443\u0434\u0430\u043B\u0435\u043D\u0430 \u0438\u0437 \u0433\u0430\u043B\u0435\u0440\u0435\u0438`);
}

// src/commands/status.ts
import path18 from "node:path";
var RECORD_TITLES = {
  session: "\u0441\u0435\u0441\u0441\u0438\u0438",
  decision: "\u0440\u0435\u0448\u0435\u043D\u0438\u044F",
  note: "\u0437\u0430\u043C\u0435\u0442\u043A\u0438"
};
function performerOf(guide, agent) {
  if (guide.role === void 0) return "\u0432\u0435\u0434\u0443\u0449\u0438\u0439";
  return `${agent?.agent ?? DEFAULT_AGENT.agent} \xB7 ${agent?.model ?? DEFAULT_MODEL}`;
}
function processLines(project, harness2) {
  const workflow = workflowOf(harness2, project.config.workflow);
  const stages = workflow.stages.map((stage) => {
    const guide = harness2.stages[stage];
    const performer = performerOf(guide, project.config.agents[stage]);
    return `  ${guide.title}: ${performer}`;
  });
  return [`\u041F\u0440\u043E\u0446\u0435\u0441\u0441: ${workflow.name}`, ...stages];
}
function countLine(records, type) {
  const count = records.filter((record) => record.type === type).length;
  return `${RECORD_TITLES[type]}: ${count}`;
}
function newerOf(newest, record) {
  return newest === void 0 || record.timestamp > newest.timestamp ? record : newest;
}
function journalLines(project, records) {
  const types = Object.keys(RECORD_COLLECTIONS);
  const counts = types.map((type) => countLine(records, type));
  const latest = records.reduce(newerOf, void 0);
  const journalPath = path18.relative(project.root, project.journal) || ".";
  const latestLines = latest === void 0 ? [] : [`\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u044F\u044F \u0437\u0430\u043F\u0438\u0441\u044C: ${latest.timestamp} (${latest.type})`];
  return [`\u0416\u0443\u0440\u043D\u0430\u043B: ${journalPath} \u2014 ${counts.join(", ")}`, ...latestLines];
}
function harnessLine(version) {
  if (version === HARNESS_VERSION) return `Harness: ${version}`;
  return `Harness: ${version} (CLI \u2014 ${HARNESS_VERSION}, \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 cyberzavod sync)`;
}
async function printStatus(directory, installation) {
  const project = await requireProjectAt(directory);
  const { config } = project;
  const checks = config.verification.commands;
  const checksLine = checks.length === 0 ? "\u043D\u0435 \u0437\u0430\u0434\u0430\u043D\u044B" : checks.join("; ");
  const records = await new DirectoryRecordStore(project.journal).list();
  const lines = [
    `\u041F\u0440\u043E\u0435\u043A\u0442: ${config.projectId} (${project.root})`,
    harnessLine(config.harness),
    ...processLines(project, installation.harness),
    `\u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0438: ${checksLine}`,
    ...journalLines(project, records)
  ];
  for (const line of lines) console.log(line);
}

// src/commands/sync.ts
async function refreshedConfig(root, config) {
  const detected = await detectProject(root);
  return { ...config, harness: HARNESS_VERSION, stack: stackOf(detected) };
}
function printFiles(title, files) {
  if (files.length === 0) return;
  const lines = files.map((file) => `  ${file}`);
  console.log(`${title}:
${lines.join("\n")}`);
}
function printWrittenReport(report) {
  printFiles("\u0437\u0430\u043F\u0438\u0441\u0430\u043D\u044B", report.changed);
  printFiles("\u0443\u0434\u0430\u043B\u0435\u043D\u044B", report.removed);
  printFiles("\u043D\u0430\u043F\u0438\u0441\u0430\u043D\u044B \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u043E\u043C", report.conflicts);
}
function printOutdatedReport(report) {
  printFiles("\u0443\u0441\u0442\u0430\u0440\u0435\u043B\u0438", report.changed);
  printFiles("\u043B\u0438\u0448\u043D\u0438\u0435", report.removed);
  printFiles("\u043D\u0430\u043F\u0438\u0441\u0430\u043D\u044B \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u043E\u043C", report.conflicts);
}
function claudeInstallationOf(installation) {
  return { harness: installation.harness, templates: installation.claudeTemplates };
}
function withTool(report, isToolChanged) {
  return isToolChanged ? { ...report, changed: [TOOL_FILE, ...report.changed] } : report;
}
function isClean(report) {
  return report.changed.length + report.removed.length + report.conflicts.length === 0;
}
async function checkProject(directory, installation) {
  const project = await requireProjectAt(directory);
  const tool = toolOf(installation);
  const claudeReport = await syncClaude({
    projectDirectory: project.root,
    installation: claudeInstallationOf(installation),
    check: true
  });
  const isToolOutdated = await isToolFileOutdated(project.root, tool);
  const report = withTool(claudeReport, isToolOutdated);
  const isHarnessOutdated = project.config.harness !== HARNESS_VERSION;
  if (isHarnessOutdated) {
    console.log(
      `${PROJECT_CONFIG_FILE}: harness ${project.config.harness}, \u0430 CLI \u2014 ${HARNESS_VERSION}`
    );
  }
  printOutdatedReport(report);
  const isUpToDate = isClean(report) && !isHarnessOutdated;
  if (!isUpToDate) console.log("\u0424\u0430\u0439\u043B\u044B \u0430\u0433\u0435\u043D\u0442\u0430 \u0443\u0441\u0442\u0430\u0440\u0435\u043B\u0438: \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 cyberzavod sync");
  return isUpToDate;
}
async function syncProject(directory, options, installation) {
  const project = await requireProjectAt(directory);
  const tool = toolOf(installation);
  const config = await refreshedConfig(project.root, project.config);
  await writeProjectConfig(project.root, config);
  const isToolChanged = await updateToolFile(project.root, tool);
  const report = await syncClaude({
    projectDirectory: project.root,
    installation: claudeInstallationOf(installation),
    force: options.force
  });
  printWrittenReport(withTool(report, isToolChanged));
}

// src/sharing/services.ts
import { setTimeout as delay } from "node:timers/promises";

// src/sharing/github.ts
var GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
var GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
var DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
function field(body, name) {
  const value = body[name];
  if (typeof value !== "string" || value === "") {
    throw new CommandError(`GitHub \u0432\u0435\u0440\u043D\u0443\u043B \u043D\u0435\u043E\u0436\u0438\u0434\u0430\u043D\u043D\u044B\u0439 \u043E\u0442\u0432\u0435\u0442: \u043D\u0435\u0442 \u043F\u043E\u043B\u044F ${name}`);
  }
  return value;
}
function seconds(body, name) {
  const value = body[name];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new CommandError(`GitHub \u0432\u0435\u0440\u043D\u0443\u043B \u043D\u0435\u043E\u0436\u0438\u0434\u0430\u043D\u043D\u044B\u0439 \u043E\u0442\u0432\u0435\u0442: \u043D\u0435\u0442 \u043F\u043E\u043B\u044F ${name}`);
  }
  return value;
}
function parseDeviceCode(body) {
  if (!isObject5(body)) throw new CommandError("GitHub \u043D\u0435 \u0432\u044B\u0434\u0430\u043B \u043A\u043E\u0434 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0430");
  return {
    deviceCode: field(body, "device_code"),
    userCode: field(body, "user_code"),
    verificationUri: field(body, "verification_uri"),
    expiresInSeconds: seconds(body, "expires_in"),
    intervalSeconds: seconds(body, "interval")
  };
}
function parseTokenPoll(body) {
  if (!isObject5(body)) throw new CommandError("GitHub \u043D\u0435 \u0432\u044B\u0434\u0430\u043B \u0442\u043E\u043A\u0435\u043D");
  if (typeof body.access_token === "string" && body.access_token !== "") {
    return { status: "granted", token: body.access_token };
  }
  switch (body.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down" };
    case "expired_token":
      return { status: "expired" };
    case "access_denied":
      return { status: "denied" };
    default: {
      const reason = typeof body.error_description === "string" ? body.error_description : "";
      throw new CommandError(`GitHub \u043E\u0442\u043A\u043B\u043E\u043D\u0438\u043B \u0432\u0445\u043E\u0434: ${reason || String(body.error)}`);
    }
  }
}
var HttpGithubAuth = class {
  #fetch;
  /**
   * Клиент device flow GitHub.
   * @param {FetchFunction} fetchImplementation Функция запроса; по умолчанию встроенный `fetch`.
   */
  constructor(fetchImplementation = fetch) {
    this.#fetch = fetchImplementation;
  }
  /**
   * Просит у GitHub код устройства. Права (scope) не запрашиваются: хватает логина и id.
   * @param {string} clientId Идентификатор приложения GitHub.
   * @returns {Promise<DeviceCode>} Код для человека и параметры опроса.
   * @throws {CommandError} Если GitHub недоступен или ответил неожиданно.
   */
  async requestDeviceCode(clientId) {
    const body = await this.#post(GITHUB_DEVICE_CODE_URL, { client_id: clientId });
    return parseDeviceCode(body);
  }
  /**
   * Спрашивает у GitHub, подтвердил ли человек код.
   * @param {string} clientId Идентификатор приложения GitHub.
   * @param {string} deviceCode Код устройства из `requestDeviceCode`.
   * @returns {Promise<TokenPoll>} Токен или причина подождать либо отказаться.
   * @throws {CommandError} Если GitHub недоступен или отклонил вход по другой причине.
   */
  async pollAccessToken(clientId, deviceCode) {
    const body = await this.#post(GITHUB_ACCESS_TOKEN_URL, {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: DEVICE_CODE_GRANT_TYPE
    });
    return parseTokenPoll(body);
  }
  async #post(url, form) {
    const response = await sendRequest(this.#fetch, url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString()
    });
    return readJsonBody(response);
  }
};

// src/sharing/settings.ts
import { chmod, mkdir as mkdir7, rm as rm4, writeFile as writeFile9 } from "node:fs/promises";
import path19 from "node:path";
var SETTINGS_DIRECTORY_NAME = "cyberzavod";
var CREDENTIALS_FILE_NAME = "credentials.json";
var OWNER_ONLY_FILE_MODE = 384;
var OWNER_ONLY_DIRECTORY_MODE = 448;
function settingsDirectory(environment) {
  const { env, platform, homeDirectory } = environment;
  const isWindows = platform === "win32";
  const pathFor = isWindows ? path19.win32 : path19.posix;
  const windowsBase = env.APPDATA || pathFor.join(homeDirectory, "AppData", "Roaming");
  const posixBase = env.XDG_CONFIG_HOME || pathFor.join(homeDirectory, ".config");
  const base = isWindows ? windowsBase : posixBase;
  return pathFor.join(base, SETTINGS_DIRECTORY_NAME);
}
function credentialsFile(environment) {
  const pathFor = environment.platform === "win32" ? path19.win32 : path19.posix;
  return pathFor.join(settingsDirectory(environment), CREDENTIALS_FILE_NAME);
}
function tokenIn(text) {
  try {
    const parsed = JSON.parse(text);
    return isObject5(parsed) && typeof parsed.token === "string" && parsed.token !== "" ? parsed.token : void 0;
  } catch {
    return void 0;
  }
}
var FileCredentialsStore = class {
  #file;
  /**
   * Хранилище токена в файле.
   * @param {string} file Абсолютный путь `credentials.json`.
   */
  constructor(file) {
    this.#file = file;
  }
  /**
   * Читает сохранённый токен.
   * @returns {Promise<string | undefined>} Токен или undefined, если файла нет.
   * @throws {CommandError} Если файл повреждён.
   */
  async read() {
    const text = await readOptionalText(this.#file);
    if (text === void 0) return void 0;
    const token = tokenIn(text);
    if (token === void 0) {
      throw new CommandError(
        `\u0444\u0430\u0439\u043B ${CREDENTIALS_FILE_NAME} \u043F\u043E\u0432\u0440\u0435\u0436\u0434\u0451\u043D: \u0432\u043E\u0439\u0434\u0438\u0442\u0435 \u0437\u0430\u043D\u043E\u0432\u043E \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 cyberzavod login`
      );
    }
    return token;
  }
  /**
   * Сохраняет токен в файл, доступный только владельцу.
   * @param {string} token Токен GitHub.
   * @returns {Promise<void>} Готово, когда файл записан.
   */
  async save(token) {
    await mkdir7(path19.dirname(this.#file), { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
    await writeFile9(this.#file, `${JSON.stringify({ token }, null, 2)}
`, {
      mode: OWNER_ONLY_FILE_MODE
    });
    await chmod(this.#file, OWNER_ONLY_FILE_MODE);
  }
  /**
   * Удаляет файл с токеном.
   * @returns {Promise<boolean>} true, если токен был сохранён.
   */
  async remove() {
    const hadToken = await readOptionalText(this.#file) !== void 0;
    await rm4(this.#file, { force: true });
    return hadToken;
  }
};

// src/sharing/services.ts
var DEFAULT_API_URL = "https://cyberzavod.com";
var API_URL_VARIABLE = "CYBERZAVOD_API_URL";
var TRAILING_SLASHES = /\/+$/;
function createSharing(environment) {
  const siteUrl = (environment.env[API_URL_VARIABLE] || DEFAULT_API_URL).replace(
    TRAILING_SLASHES,
    ""
  );
  return {
    siteUrl,
    api: new HttpCyberzavodApi(siteUrl),
    github: new HttpGithubAuth(),
    credentials: new FileCredentialsStore(credentialsFile(environment)),
    sleep: (milliseconds) => delay(milliseconds)
  };
}

// src/cli.ts
var SUCCESS = 0;
var FAILURE = 1;
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
function requiredText(value, what) {
  if (value === void 0 || value.trim() === "") throw new CommandError(`\u043D\u0443\u0436\u0435\u043D ${what}`);
  return value;
}
function defaultSharing() {
  return createSharing({ env: process.env, platform: process.platform, homeDirectory: homedir() });
}
var COMMANDS = {
  init: {
    usage: "init [--yes]",
    summary: "\u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C \u043F\u0440\u043E\u0435\u043A\u0442 \u0432 \u0442\u0435\u043A\u0443\u0449\u0435\u043C \u043A\u0430\u0442\u0430\u043B\u043E\u0433\u0435: \u043C\u0430\u0441\u0442\u0435\u0440, \u043A\u043E\u043D\u0444\u0438\u0433, AGENTS.md, \u0444\u0430\u0439\u043B\u044B \u0430\u0433\u0435\u043D\u0442\u0430",
    run: async ({ args, directory }) => {
      const { values } = parseArgs({ args, options: { yes: { type: "boolean", short: "y" } } });
      const prompter = values.yes === true ? defaultsPrompter() : terminalPrompter({ input: process.stdin, output: process.stdout });
      try {
        await initProject(directory, prompter, await readInstallation());
      } finally {
        prompter.close();
      }
      return SUCCESS;
    }
  },
  sync: {
    usage: "sync [--check] [--force]",
    summary: "\u0437\u0430\u043D\u043E\u0432\u043E \u043D\u0430\u0439\u0442\u0438 \u0441\u0442\u0435\u043A \u0438 \u043F\u0435\u0440\u0435\u0441\u043E\u0431\u0440\u0430\u0442\u044C \u0444\u0430\u0439\u043B\u044B \u0430\u0433\u0435\u043D\u0442\u0430; --check \u2014 \u0442\u043E\u043B\u044C\u043A\u043E \u043F\u0440\u043E\u0432\u0435\u0440\u0438\u0442\u044C",
    run: async ({ args, directory }) => {
      const { values } = parseArgs({
        args,
        options: { check: { type: "boolean" }, force: { type: "boolean" } }
      });
      const installation = await readInstallation();
      if (values.check === true) {
        const isUpToDate = await checkProject(directory, installation);
        return isUpToDate ? SUCCESS : FAILURE;
      }
      await syncProject(directory, { force: values.force === true }, installation);
      return SUCCESS;
    }
  },
  status: {
    usage: "status",
    summary: "\u043F\u0440\u043E\u0435\u043A\u0442, \u043F\u0440\u043E\u0446\u0435\u0441\u0441, \u0430\u0433\u0435\u043D\u0442\u044B \u044D\u0442\u0430\u043F\u043E\u0432, \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u0438 \u0436\u0443\u0440\u043D\u0430\u043B",
    run: async ({ directory }) => {
      await printStatus(directory, await readInstallation());
      return SUCCESS;
    }
  },
  decision: {
    usage: 'decision "<\u0447\u0442\u043E \u0440\u0435\u0448\u0438\u043B\u0438>" [--why "<\u043F\u043E\u0447\u0435\u043C\u0443>"]',
    summary: "\u0437\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u0440\u0435\u0448\u0435\u043D\u0438\u0435 \u0432 \u0436\u0443\u0440\u043D\u0430\u043B",
    run: async ({ args, directory }) => {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { why: { type: "string" } }
      });
      const title = requiredText(positionals.join(" "), "\u0442\u0435\u043A\u0441\u0442 \u0440\u0435\u0448\u0435\u043D\u0438\u044F");
      await recordDecision(directory, title, values.why ?? "");
      return SUCCESS;
    }
  },
  note: {
    usage: 'note "<\u0442\u0435\u043A\u0441\u0442>"',
    summary: "\u0437\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u0437\u0430\u043C\u0435\u0442\u043A\u0443 \u0432 \u0436\u0443\u0440\u043D\u0430\u043B",
    run: async ({ args, directory }) => {
      const { positionals } = parseArgs({ args, allowPositionals: true });
      const text = requiredText(positionals.join(" "), "\u0442\u0435\u043A\u0441\u0442 \u0437\u0430\u043C\u0435\u0442\u043A\u0438");
      await recordNote(directory, text);
      return SUCCESS;
    }
  },
  draft: {
    usage: "draft [<\u0441\u044B\u0440\u043E\u0439 \u0436\u0443\u0440\u043D\u0430\u043B \u0441\u0435\u0441\u0441\u0438\u0438>]",
    summary: "\u0441\u043E\u0431\u0440\u0430\u0442\u044C \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A \u0437\u0430\u043F\u0438\u0441\u0438 \u0438\u0437 \u0436\u0443\u0440\u043D\u0430\u043B\u0430 \u0441\u0435\u0441\u0441\u0438\u0438 Claude Code",
    run: async ({ args, directory }) => {
      const { positionals } = parseArgs({ args, allowPositionals: true });
      const [rawPath] = positionals;
      await draftSession({
        projectDirectory: directory,
        ...rawPath === void 0 ? {} : { rawPath }
      });
      return SUCCESS;
    }
  },
  publish: {
    usage: "publish [--draft <\u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A>] [--build <id \u0441\u0431\u043E\u0440\u043A\u0438>]",
    summary: "\u043E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C \u043E\u0442\u0440\u0435\u0434\u0430\u043A\u0442\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u0439 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A \u0437\u0430\u043F\u0438\u0441\u044F\u043C\u0438 \u0432 \u0436\u0443\u0440\u043D\u0430\u043B",
    run: async ({ args, directory }) => {
      const { values } = parseArgs({
        args,
        options: { draft: { type: "string" }, build: { type: "string" } }
      });
      const published = await publishSessions({
        projectDirectory: directory,
        ...values.draft === void 0 ? {} : { draftPath: values.draft },
        ...values.build === void 0 ? {} : { buildId: values.build }
      });
      return published ? SUCCESS : FAILURE;
    }
  },
  login: {
    usage: "login",
    summary: "\u0432\u043E\u0439\u0442\u0438 \u0447\u0435\u0440\u0435\u0437 GitHub, \u0447\u0442\u043E\u0431\u044B \u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C \u0437\u0430\u043F\u0438\u0441\u0438 \u0432 \u0433\u0430\u043B\u0435\u0440\u0435\u044E (\u0430\u0434\u0440\u0435\u0441 \u0441\u0435\u0440\u0432\u0435\u0440\u0430 \u2014 CYBERZAVOD_API_URL)",
    run: async () => {
      await login(defaultSharing());
      return SUCCESS;
    }
  },
  logout: {
    usage: "logout",
    summary: "\u0437\u0430\u0431\u044B\u0442\u044C \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D\u043D\u044B\u0439 \u0442\u043E\u043A\u0435\u043D GitHub",
    run: async () => {
      await logout(defaultSharing());
      return SUCCESS;
    }
  },
  share: {
    usage: "share <id \u0437\u0430\u043F\u0438\u0441\u0438>",
    summary: "\u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u0437\u0430\u043F\u0438\u0441\u044C \u0441\u0435\u0441\u0441\u0438\u0438 \u0438\u0437 \u0436\u0443\u0440\u043D\u0430\u043B\u0430 \u0432 \u0432\u0430\u0448\u0443 \u0433\u0430\u043B\u0435\u0440\u0435\u044E \u0438 \u043F\u043E\u043A\u0430\u0437\u0430\u0442\u044C \u0441\u0441\u044B\u043B\u043A\u0443 \u043D\u0430 \u043D\u0435\u0451",
    run: async ({ args, directory }) => {
      const { positionals } = parseArgs({ args, allowPositionals: true });
      const [id] = positionals;
      await shareRecording(defaultSharing(), directory, requiredText(id, "id \u0437\u0430\u043F\u0438\u0441\u0438"));
      return SUCCESS;
    }
  },
  unshare: {
    usage: "unshare <id \u0437\u0430\u043F\u0438\u0441\u0438>",
    summary: "\u0443\u0431\u0440\u0430\u0442\u044C \u0437\u0430\u043F\u0438\u0441\u044C \u0438\u0437 \u0432\u0430\u0448\u0435\u0439 \u0433\u0430\u043B\u0435\u0440\u0435\u0438",
    run: async ({ args }) => {
      const { positionals } = parseArgs({ args, allowPositionals: true });
      const [id] = positionals;
      await unshareRecording(defaultSharing(), requiredText(id, "id \u0437\u0430\u043F\u0438\u0441\u0438"));
      return SUCCESS;
    }
  },
  gallery: {
    usage: "gallery [--public | --private]",
    summary: "\u0432\u0430\u0448\u0438 \u0437\u0430\u043F\u0438\u0441\u0438 \u0432 \u0433\u0430\u043B\u0435\u0440\u0435\u0435, \u043B\u0438\u043C\u0438\u0442 \u0438 \u0441\u0441\u044B\u043B\u043A\u0438; --public \u043E\u0442\u043A\u0440\u044B\u0432\u0430\u0435\u0442 \u0433\u0430\u043B\u0435\u0440\u0435\u044E, --private \u0437\u0430\u043A\u0440\u044B\u0432\u0430\u0435\u0442",
    run: async ({ args }) => {
      const { values } = parseArgs({
        args,
        options: { public: { type: "boolean" }, private: { type: "boolean" } }
      });
      const access2 = galleryAccessOf(values.public === true, values.private === true);
      await showGallery(defaultSharing(), access2);
      return SUCCESS;
    }
  },
  hook: {
    usage: `hook <${HOOK_NAMES.join("|")}>`,
    summary: "\u0445\u0443\u043A Claude Code: \u0441\u043E\u0431\u044B\u0442\u0438\u0435 \u043D\u0430 stdin; \u0435\u0433\u043E \u0432\u044B\u0437\u044B\u0432\u0430\u044E\u0442 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u043F\u0440\u043E\u0435\u043A\u0442\u0430, \u0430 \u043D\u0435 \u0447\u0435\u043B\u043E\u0432\u0435\u043A",
    run: async ({ args, directory }) => {
      const { positionals } = parseArgs({ args, allowPositionals: true });
      const [name = ""] = positionals;
      if (!isHookName(name)) throw new CommandError(`\u043D\u0435\u0442 \u0445\u0443\u043A\u0430 ${name}`);
      const payload = await readStdin();
      const outcome = await runHook(name, {
        payload,
        projectDirectory: process.env.CLAUDE_PROJECT_DIR || directory,
        tmpDir: tmpdir()
      });
      process.stdout.write(outcome.stdout);
      process.stderr.write(outcome.stderr);
      return outcome.exitCode;
    }
  }
};
function usage() {
  const lines = Object.values(COMMANDS).map(
    (command) => `  cyberzavod ${command.usage}
      ${command.summary}`
  );
  return `Cyberzavod \u2014 \u043F\u0440\u043E\u0446\u0435\u0441\u0441 \u0440\u0430\u0437\u0440\u0430\u0431\u043E\u0442\u043A\u0438 \u0441 \u0418\u0418-\u0430\u0433\u0435\u043D\u0442\u0430\u043C\u0438, \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u043E.

${lines.join("\n")}`;
}
var EXPECTED_ERRORS = [
  CommandError,
  ApiError,
  GenerateError,
  ProjectFileError,
  JournalError,
  RecordError
];
var ARGUMENT_ERROR_PREFIX = "ERR_PARSE_ARGS";
function isExpected(err) {
  if (EXPECTED_ERRORS.some((kind) => err instanceof kind)) return true;
  const code = err instanceof Error && "code" in err ? err.code : void 0;
  return typeof code === "string" && code.startsWith(ARGUMENT_ERROR_PREFIX);
}
async function runCli(argv, directory) {
  const [name, ...args] = argv;
  const command = name === void 0 ? void 0 : COMMANDS[name];
  if (command === void 0) {
    const isHelpRequest = name === void 0 || name === "help" || name === "--help";
    console.log(usage());
    return isHelpRequest ? SUCCESS : FAILURE;
  }
  try {
    return await command.run({ args, directory });
  } catch (err) {
    if (!isExpected(err)) throw err;
    console.error(`cyberzavod ${name}: ${err.message}`);
    return FAILURE;
  }
}

// src/bin/cyberzavod.ts
process.exitCode = await runCli(process.argv.slice(2), process.env.INIT_CWD ?? process.cwd());
