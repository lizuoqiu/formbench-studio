// Offline replay. Optional first argument: a local R25 archive directory with
// design.json, cad.json and report.json. Output is a comparison, not a release gate.
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCadPlan } from '../cad-plan.js';
import { validateInteraction } from '../interaction-model.js';
import { replayInteraction } from '../server/design-review.mjs';
import { reviewInteractionGeometry } from '../server/interaction-geometry-review.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const arm = process.argv[2] ? relative(root, resolve(process.argv[2])) : 'output/playwright/arm-round25-preview';
const fixtures = [
  { id: 'static-cover', design: 'samples/shared/photo-cover/v1.json', cad: 'samples/shared/photo-cover/v1-cad.json' },
  { id: 'single-axis-fist-bump', design: 'samples/fist-bump.json', cad: 'samples/fist-bump-cad.json' },
  { id: 'six-axis-arm-r25', design: arm + '/design.json', cad: arm + '/cad.json', report: arm + '/report.json' },
];

async function json(path) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'));
}

function check(run) {
  try {
    run();
    return { status: 'passed' };
  } catch (error) {
    return { status: 'failed', issues: error.issues || [error.message] };
  }
}

function compiledMeshes(plan, cad) {
  const issues = [];
  if (!isDeepStrictEqual(plan, cad.cadPlan)) issues.push('The design and artifact CAD plans differ.');
  if (plan.bodies.length !== cad.bodies.length) issues.push('The design and artifact body counts differ.');
  let triangles = 0;
  for (const [i, body] of cad.bodies.entries()) {
    const record = plan.bodies[i];
    if (!record || body.name !== record.name || body.partIndex !== record.partIndex || !isDeepStrictEqual(body.positionMm, record.positionMm)) {
      issues.push('Assembly body identity or placement mismatch at index ' + i);
    }
    const data = Buffer.from(body.stlBase64 || '', 'base64');
    const count = data.length >= 84 ? data.readUInt32LE(80) : 0;
    if (!count || data.length !== 84 + 50 * count) issues.push('Invalid binary STL payload at index ' + i);
    else triangles += count;
  }
  return { status: issues.length ? 'failed' : 'passed', archiveEngine: cad.engine, bodies: cad.bodies.length, triangles, issues };
}

function discreteInteraction(design) {
  if (!design.interaction) return { status: 'not-declared' };
  const validation = check(() => validateInteraction(design.interaction, { parts: design.parts, cadPlan: design.cadPlan }));
  if (validation.status === 'failed') return validation;
  const replay = replayInteraction(design.interaction);
  return {
    status: replay.issues.length ? 'failed' : 'passed',
    visitedStates: replay.visitedStates.length, eventObservations: replay.observations.length, issues: replay.issues,
  };
}

async function replay(fixture) {
  const record = await json(fixture.design);
  const design = record.design ?? record;
  const plan = design.cadPlan;
  const report = fixture.report ? await json(fixture.report) : null;
  if (report && report.attempt !== 25) throw Error('Expected the saved round 25 review.');
  const geometry = report ? report.geometry : await reviewInteractionGeometry(design);
  const represented = new Set(plan.bodies.map(body => body.partIndex));
  const unrepresentedByPlacement = {};
  for (const [i, part] of design.parts.entries()) {
    if (represented.has(i)) continue;
    const placement = part.placement || 'unspecified';
    unrepresentedByPlacement[placement] = (unrepresentedByPlacement[placement] || 0) + 1;
  }
  const row = {
    id: fixture.id, inputs: fixture, name: design.name,
    bomLines: design.parts.length, bomLinesWithCadBodies: represented.size, unrepresentedByPlacement,
    cadPlan: check(() => validateCadPlan(plan, design.parts.length)),
    compiledMeshes: compiledMeshes(plan, await json(fixture.cad)),
    motion: { linearAxes: plan.motions?.length ?? 0, rotaryJoints: plan.joints?.length ?? 0 },
    discreteInteraction: discreteInteraction(design),
    geometry: {
      origin: report ? 'saved round 25 geometry review' : 'replayed locally from declared CAD features',
      status: geometry.status, checks: geometry.checks, issues: geometry.issues,
    },
  };
  if (design.generation?.reviewNote) row.sourceNote = design.generation.reviewNote;
  if (report) {
    row.archivedReview = {
      at: report.at, areas: Object.fromEntries(report.review.checks.map(({ area, status }) => [area, status])),
      reviewCallUsage: report.review.usage ?? null,
    };
  }
  return row;
}

const results = [];
for (const fixture of fixtures) {
  try {
    results.push(await replay(fixture));
  } catch (error) {
    results.push({ id: fixture.id, inputs: fixture, status: 'unavailable', reason: error.message });
    process.exitCode = 1;
  }
}
console.log(JSON.stringify({
  mode: 'Offline single-snapshot replay; no generation, paid requests, server, fresh CAD exports or job writes.',
  boundaries: [
    'Mesh validation checks STL framing, nonzero triangle counts and linkage to the CAD plan. It does not certify surfaces, fit or manufacture.',
    'Motion sampling tests selected declared body groups in discrete poses. It does not cover all same-group contacts, continuous paths, dynamics or physical wiring.',
    'Discrete event replay injects modeled events. The single-axis sample declares linear travel without a discrete controller model.',
    'Each fixture is a single snapshot. Verified closures, introduced regressions, total generation tokens and elapsed generation time cannot be compared. R25 usage applies only to its saved review call.',
    'R25 is a separate local archive. Pass its directory as the first argument if it is absent from the checkout.',
  ],
  results,
}, null, 2));
