#!/usr/bin/env node
/**
 * LLM-based PR code review with inline diff comments.
 * Primary:  Gemini (free tier) — set GEMINI_API_KEY + optionally GEMINI_MODEL
 * Fallback: GitHub Models (gpt-4o)      — requires PAT with models:read as GH_MODELS_TOKEN
 */

import { execSync } from "child_process";

const {
  GITHUB_TOKEN,
  GH_MODELS_TOKEN, // PAT with models:read scope — needed for GitHub Models fallback
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-2.0-flash", // override via workflow env var if quota issues
  PR_NUMBER,
  REPO,
  HEAD_SHA,
} = process.env;

const MAX_DIFF_CHARS = 80_000;
// gpt-4o on GitHub Models has an ~8k total token budget; keep the diff small enough
// to leave room for the prompt template and the output.
const MAX_DIFF_CHARS_GH_MODELS = 18_000;

function getDiff() {
  try {
    const diff = execSync(`gh pr diff ${PR_NUMBER} --repo ${REPO}`, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return diff.length > MAX_DIFF_CHARS
      ? diff.slice(0, MAX_DIFF_CHARS) + "\n\n[diff truncated — too large]"
      : diff;
  } catch (err) {
    console.error("Failed to get PR diff:", err.message);
    process.exit(1);
  }
}

/**
 * Walk the unified diff and collect every (file, newLineNumber) pair that
 * corresponds to a "+" line in the new file. These are the only positions
 * the GitHub Reviews API accepts for inline comments.
 */
function parseValidLines(diff) {
  const validLines = new Map(); // file -> Set<lineNumber>
  let currentFile = null;
  let newLineNum = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6).trim();
      if (!validLines.has(currentFile)) validLines.set(currentFile, new Set());
      newLineNum = 0;
    } else if (line.startsWith("@@ ")) {
      const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
      if (m) newLineNum = parseInt(m[1], 10) - 1;
    } else if (currentFile) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        newLineNum++;
        validLines.get(currentFile).add(newLineNum);
      } else if (!line.startsWith("-")) {
        newLineNum++;
      }
    }
  }

  return validLines;
}

function buildPrompt(diff) {
  return `You are a senior software engineer reviewing a pull request for a WebGPU-based 3D terrain engine written in vanilla JavaScript (ES6 modules). The engine handles terrain rendering, LOD, splat maps, baked AO, lighting, and fog.

Review the diff for: bugs, security issues, GPU/memory leaks, shader syntax errors and bugs, unnecessary hot-path allocations, and maintainability problems.

Respond with ONLY valid JSON — no markdown fences, no text outside the JSON object. Schema:

{
  "summary": "1–3 sentence overall assessment.",
  "event": "COMMENT",
  "comments": [
    {
      "path": "exact/path/matching/+++ b/ header",
      "line": <integer — line number in the NEW file, must be a + line>,
      "body": "**🔴 Critical** | **🟡 Warning** | **🔵 Info** — concise explanation"
    }
  ]
}

Hard rules:
- "path" must match exactly what follows "+++ b/" in the diff header (no leading slash)
- "line" must be the line number of a "+" line in the new file (not context or "-" lines)
- Set "event" to "REQUEST_CHANGES" when there are Critical issues, otherwise "COMMENT"
- "comments" may be [] if there are no specific line-level issues worth noting
- Only report real issues — skip style nitpicks unless they introduce a real risk

Diff:
${diff}`;
}

function extractJSON(text) {
  // Strip accidental markdown fences the model may add despite instructions
  const cleaned = text
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```$/m, "")
    .trim();
  return JSON.parse(cleaned);
}

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.2,
        responseMimeType: "application/json",
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned empty response");
  return text;
}

async function callGitHubModels(prompt) {
  const res = await fetch("https://models.inference.ai.azure.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GH_MODELS_TOKEN}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "You are a senior software engineer doing a code review. Respond with valid JSON only, no markdown.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 2048,
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`GitHub Models ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("GitHub Models returned empty response");
  return text;
}

/** Post a proper PR review with inline comments via the Reviews API. */
async function postReview(summary, event, inlineComments, model) {
  const footer = `\n\n---\n> 🤖 Reviewed by ${model}`;
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/pulls/${PR_NUMBER}/reviews`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        commit_id: HEAD_SHA,
        body: summary + footer,
        event,
        comments: inlineComments,
      }),
    }
  );
  if (!res.ok) throw new Error(`Reviews API: ${await res.text()}`);
  console.log(`Review posted: ${inlineComments.length} inline comment(s).`);
}

/** Plain issue comment — last resort if Reviews API fails or JSON parse fails. */
async function postFallbackComment(body, model) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/issues/${PR_NUMBER}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ body: `> 🤖 **AI Code Review** — ${model}\n\n${body}` }),
    }
  );
  if (!res.ok) throw new Error(`Fallback comment: ${await res.text()}`);
  console.log("Posted fallback summary comment.");
}

async function main() {
  if (!GITHUB_TOKEN || !PR_NUMBER || !REPO || !HEAD_SHA) {
    console.error("Missing env vars: GITHUB_TOKEN, PR_NUMBER, REPO, HEAD_SHA");
    process.exit(1);
  }

  console.log(`Reviewing PR #${PR_NUMBER} in ${REPO}...`);
  const diff = getDiff();
  if (!diff.trim()) {
    console.log("Empty diff — skipping.");
    return;
  }

  const validLines = parseValidLines(diff);
  const prompt = buildPrompt(diff);
  let rawResponse = null;
  let model = null;

  if (GEMINI_API_KEY) {
    try {
      console.log(`Calling Gemini (${GEMINI_MODEL})...`);
      rawResponse = await callGemini(prompt);
      model = `Gemini · ${GEMINI_MODEL}`;
    } catch (err) {
      console.warn(`Gemini failed (${err.message}) — falling back to GitHub Models.`);
    }
  } else {
    console.log("GEMINI_API_KEY not set, using GitHub Models fallback.");
  }

  if (!rawResponse) {
    try {
      console.log("Calling GitHub Models (gpt-4o)...");
      const ghDiff = diff.length > MAX_DIFF_CHARS_GH_MODELS
        ? diff.slice(0, MAX_DIFF_CHARS_GH_MODELS) + "\n\n[diff truncated for token limit]"
        : diff;
      rawResponse = await callGitHubModels(buildPrompt(ghDiff));
      model = "GitHub Models · gpt-4o";
    } catch (err) {
      console.error(`GitHub Models also failed: ${err.message}`);
      process.exit(1);
    }
  }

  let review;
  try {
    review = extractJSON(rawResponse);
  } catch (err) {
    console.warn(`JSON parse failed (${err.message}) — posting as plain comment.`);
    await postFallbackComment(rawResponse, model);
    return;
  }

  const { summary = "", event = "COMMENT", comments: rawComments = [] } = review;

  // Validate each comment against the parsed diff — only + lines are valid targets
  const inlineComments = [];
  const orphaned = [];

  for (const c of rawComments) {
    const fileLines = validLines.get(c.path);
    if (fileLines?.has(c.line)) {
      inlineComments.push({ path: c.path, line: c.line, side: "RIGHT", body: c.body });
    } else {
      orphaned.push(c);
      console.warn(`  Invalid position — will add to summary: ${c.path}:${c.line}`);
    }
  }

  // Orphaned comments (LLM hallucinated a position) go into the summary body
  let summaryBody = summary;
  if (orphaned.length > 0) {
    summaryBody += "\n\n**Additional findings:**";
    for (const c of orphaned) {
      summaryBody += `\n- \`${c.path}\`: ${c.body}`;
    }
  }

  try {
    await postReview(summaryBody, event, inlineComments, model);
  } catch (err) {
    // Reviews API can fail if HEAD_SHA drifted — fall back gracefully
    console.warn(`Reviews API failed (${err.message}) — posting plain comment.`);
    const allFindings = inlineComments
      .map((c) => `- \`${c.path}:${c.line}\`: ${c.body}`)
      .join("\n");
    await postFallbackComment(
      summaryBody + (allFindings ? "\n\n**Inline findings:**\n" + allFindings : ""),
      model
    );
  }
}

main();
