import { commands as autopilot } from './features/autopilot/command.js';
import { commands as bench } from './features/bench/command.js';
import { commands as board } from './features/board/command.js';
import { commands as bottleneck } from './features/bottleneck/command.js';
import { commands as check } from './features/check/command.js';
import { commands as clean } from './features/clean/command.js';
import { commands as codemod } from './features/codemod/command.js';
import { commands as doctor } from './features/doctor/command.js';
import { commands as garden } from './features/garden/command.js';
import { commands as gate } from './features/gate/command.js';
import { commands as hook } from './features/hook/command.js';
import { commands as init } from './features/init/command.js';
import { commands as queue } from './features/queue/command.js';
import { commands as projects } from './features/projects/command.js';
import { commands as review } from './features/review/command.js';
import { commands as rules } from './features/rules/command.js';
import { commands as score } from './features/score/command.js';
import { commands as skills } from './features/skills/command.js';
import { commands as sync } from './features/sync/command.js';
import { commands as transcripts } from './features/transcripts/command.js';
import { commands as trust } from './features/trust/command.js';
import { commands as tui } from './features/tui/command.js';
import { commands as verify } from './features/verify/command.js';
import { commands as watch } from './features/watch/command.js';

/**
 * The command registry. Each feature folder exports `commands`; adding a feature = one folder + one line here.
 * Grouped in the order a human reads `wololo help`.
 */
export const GROUPS = {
  'Setup': [...tui, ...init, ...sync, ...doctor],
  'Verification (inner loop)': [...verify, ...check, ...score, ...gate, ...autopilot, ...watch, ...bench],
  'Environment & constraints': [...rules, ...codemod, ...garden, ...clean, ...hook],
  'Outer loop & coordination': [...queue, ...board, ...bottleneck, ...projects],
  'Review & trust': [...review, ...trust],
  'Skills & memory': [...skills, ...transcripts],
};

/** @type {import('./core/types.js').Command[]} */
export const COMMANDS = Object.values(GROUPS).flat();
