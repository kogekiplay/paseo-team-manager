import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCommanderPrompt, buildMemberCreateAgentParams, buildSubagentRolePrompt } from "../prompt-builder.ts";
import { createDefaultPresets } from "../settings.ts";

test("the commander gets copyable native tool parameters for enabled members", () => {
  const [preset] = createDefaultPresets();
  const prompt = buildCommanderPrompt({ preset, cwd: "/tmp/project", workspaceId: "ws-123" });
  assert.match(prompt, /当前工作区项目指挥（Commander）/);
  assert.match(prompt, /禁止直接修改项目业务源码文件/);
  assert.match(prompt, /\/tmp\/project/);
  assert.match(prompt, /ws-123/);
  assert.match(prompt, /后端开发/);
  assert.match(prompt, /前端开发/);
  const [backend, frontend, ...otherExamples] = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map(([, json]) => JSON.parse(json));
  assert.deepEqual(backend, {
    provider: "codex/auto/gpt-6.2-sol",
    settings: { modeId: "full-access", thinkingOptionId: "xhigh", features: { service_tier: "default" } },
    labels: { "paseo-team-manager.role": "backend", "paseo-team-manager.preset": "default-fullstack" },
    title: "[backend] 任务标题", initialPrompt: "填写任务目标、文件边界、接口契约与验收要求。", notifyOnFinish: true,
  });
  assert.deepEqual(frontend, {
    provider: "antigravity/gemini-4-neon",
    settings: { modeId: "full-access", thinkingOptionId: "high" },
    labels: { "paseo-team-manager.role": "frontend", "paseo-team-manager.preset": "default-fullstack" },
    title: "[frontend] 任务标题", initialPrompt: "填写任务目标、文件边界、接口契约与验收要求。", notifyOnFinish: true,
  });
  assert.deepEqual(otherExamples, []);
  const optional = prompt.split("### 可选扩展角色")[1];
  for (const text of ["默认未启用", "reviewer", "qa", "explorer"]) assert.ok(optional.includes(text));
  for (const text of ["create_agent", "send_agent_prompt", "team_get_roster", "Subagents", "worktree", "避免循环轮询"]) {
    assert.ok(prompt.includes(text));
  }
  assert.match(prompt, /provider\/model/);
  assert.match(prompt, /禁止擅自升级或切换为 `astra`、`fable` 等高成本模型/);
});

test("commander can make small changes when configured and receives trimmed extra instructions", () => {
  const [preset] = createDefaultPresets();
  const prompt = buildCommanderPrompt({ preset: {
    ...preset, members: [], commanderNoDirectEdit: false, commanderExtraInstructions: "  使用中文汇报。\n",
  } });
  assert.match(prompt, /可自行处理小型修改/);
  assert.doesNotMatch(prompt, /禁止直接修改/);
  assert.match(prompt, /当前预设没有已启用成员/);
  assert.ok(prompt.endsWith("### 补充指令\n\n使用中文汇报。"));
  assert.doesNotMatch(buildCommanderPrompt({ preset: { ...preset, commanderExtraInstructions: " \n " } }), /补充指令/);
});

test("the member template omits blank options and supplies a title prefix", () => {
  const [preset] = createDefaultPresets();
  const member = { ...preset.members[0], modeId: "", thinkingOptionId: "", features: {} };
  assert.deepEqual(buildMemberCreateAgentParams(member, preset.id), {
    provider: "codex/auto/gpt-6.2-sol",
    settings: {},
    labels: { "paseo-team-manager.role": "backend", "paseo-team-manager.preset": "default-fullstack" },
    recommendedTitlePrefix: "[backend] ",
  });
});

test("the child prompt contains role duties, file boundaries and reporting", () => {
  const [preset] = createDefaultPresets();
  const member = preset.members[0];
  const prompt = buildSubagentRolePrompt({ preset, member, cwd: "/tmp/repo" });
  for (const text of [member.name, member.roleId, member.responsibilities, member.rolePrompt, "/tmp/repo", "文件边界", "自测", "涉及文件", "验证结果"]) {
    assert.ok(prompt.includes(text));
  }
  assert.doesNotMatch(prompt, /Commander|team_get_roster|禁止直接修改项目业务源码文件|create_agent/);
});
